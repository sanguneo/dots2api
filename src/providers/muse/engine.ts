import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, errors } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { z } from "zod";
import { GatewayError, MUSE_APPROVAL_TIMEOUT_MS } from "../../contracts";
import type { AdapterContext, Credentials, ProviderAdapter, ReferenceImage, RunResult, ThreadDeletion } from "../../contracts";
import { IMAGE_EXTENSIONS, MAX_IMAGES } from "../../images";
import { downloadFiles, FILE_CARD, generatedMedia, mediaBaseline } from "./media";
import { ApprovalWait } from "./approval-wait";
import { APPROVAL_CARD_SELECTOR, scanApprovalCard } from "./approval-dom";
import { hasPendingMuseTask, observeCompletion } from "./completion";
import { rememberMuseTranscript, watchMusePage } from "./watch";
export { fileBlock } from "./media";

const configuration = z.object({
  cookieHeader: z.string().trim().optional(),
  cookieJson: z.string().trim().optional(),
  login: z.enum(["true", "false"]).optional(),
}).strict();
const importedCookies = z.union([
  z.record(z.string(), z.string()),
  z.array(z.object({ name: z.string(), value: z.string(), domain: z.string().optional() })),
]);
const CHAT_TIMEOUT = 600_000;
/** A thread id goes into a URL path, so only the characters Muse itself uses are allowed. */
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ATTACHMENT_TIMEOUT = 10_000;
/** References can total 32 MiB, so their upload gets its own, much longer, budget than a thumbnail read. */
const REFERENCE_UPLOAD_TIMEOUT = 120_000;
const VM_WAKE_TIMEOUT = 60_000;
/** Muse's own authentication cookies; only these are persisted back to the account. */
const ESSENTIAL_COOKIES = new Set(["hatch_sess", "hatch_gw", "hatch_vml", "hatch_native_auth_device"]);

interface MuseSession {
  readonly status: string;
  readonly vmId: string | null;
  readonly vmState: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

const CAUSE_MAX = 240;
/** Removes anything that could carry a credential out of a diagnostics string. */
export function sanitizeDiagnostics(value: string): string {
  return value
    .replace(/\?[^\s"')]*/g, "?<redacted>")
    .replace(/\b(cookie|authorization|token|bearer|password|secret|session|sess|hatch_[a-z_]+)[=:]\s*[^\s;,)"']+/gi, "$1=<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CAUSE_MAX);
}
/**
 * A short, credential-free description of a browser failure, plus where the page stood when it happened. Without it an
 * unconfirmed run reaches the job record as a single generic sentence and the real cause is lost: a failure at
 * `/thread/new` (the submission never left home) reads very differently from one where the page left an open thread.
 */
function describeFailure(error: unknown, page: Page | undefined): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // Playwright folds the page-side stack into the message; drop it so the cause and the page location survive trimming.
  const head = (raw.split("\n")[0] ?? "").replace(/\s+at eval \(eval at[\s\S]*$/, "").slice(0, 160);
  let location = "";
  if (page) {
    try {
      const url = new URL(page.url());
      location = ` at ${url.origin}${url.pathname}`;
    } catch {
      // A destroyed page has no readable URL; the error text still stands.
    }
  }
  return sanitizeDiagnostics(`${head}${location}`);
}

/** Reads the assigned-session state; Muse renews its cookies on this same call. */
async function readSession(page: Page, origin: URL): Promise<MuseSession | null> {
  const response = await page.request.get(new URL("/api/session", origin).href, { timeout: 15_000 });
  if (!response.ok()) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  return {
    status: typeof record["status"] === "string" ? record["status"] : "",
    vmId: typeof record["vm_id"] === "string" ? record["vm_id"] : null,
    vmState: typeof record["vm_state"] === "string" ? record["vm_state"] : null,
  };
}

/** Wakes the account's cloud workspace VM after it slept; failure here is not decisive. */
async function wakeVm(page: Page, origin: URL, vmId: string): Promise<void> {
  try {
    await page.request.post(new URL("/api/hatch/vm/wake", origin).href, {
      data: { vm_id: vmId, retry_count: 0, connect_attempt_id: crypto.randomUUID() },
      timeout: 10_000,
    });
  } catch {
    // The bounded session poll that follows decides whether the workspace came back.
  }
}

function cookiesFrom(credentials: Credentials, origin: URL) {
  const values = new Map<string, string>();
  if (credentials["cookieHeader"]) {
    for (const part of credentials["cookieHeader"].split(";")) {
      const separator = part.indexOf("=");
      if (separator <= 0) throw new GatewayError("muse_credentials", "Invalid Cookie header.");
      values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }
  }
  if (credentials["cookieJson"]) {
    let parsed: z.infer<typeof importedCookies>;
    try {
      parsed = importedCookies.parse(JSON.parse(credentials["cookieJson"]));
    } catch {
      throw new GatewayError("muse_credentials", "Cookie JSON must be a name/value map or Chrome cookie array.");
    }
    if (Array.isArray(parsed)) {
      for (const cookie of parsed) {
        if (cookie.domain && cookie.domain.replace(/^\./, "") !== origin.hostname) {
          throw new GatewayError("muse_credentials", "Cookie domain must match muse.ai.");
        }
        values.set(cookie.name, cookie.value);
      }
    } else {
      for (const [name, value] of Object.entries(parsed)) values.set(name, value);
    }
  }
  return [...values].map(([name, value]) => ({
    name, value, domain: origin.hostname, path: "/", secure: origin.protocol === "https:",
  }));
}

/**
 * Sends reference images through Muse's own composer and waits until the composer itself reports them attached: one
 * `blob:` thumbnail per reference, a Remove control for each, and an enabled Send button. A prompt sent before that is
 * submitted as a text-only edit, so an attachment the composer never confirms fails the job before anything is sent.
 *
 * `/api/falco` is not used as the signal: in Muse's client bundle it is the batched telemetry logger (flushed every
 * 1-10 s and switched off by VM policy), so its responses are neither tied to this upload nor guaranteed to appear.
 */
async function attachReferences(page: Page, references: readonly ReferenceImage[], timeout: number): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: ATTACHMENT_TIMEOUT });
  await input.setInputFiles(references.map((image, index) => ({
    name: `reference-${index + 1}.${IMAGE_EXTENSIONS[image.mime]}`,
    mimeType: image.mime,
    buffer: Buffer.from(image.data),
  })));
  await page.waitForFunction((expected: number) => {
    const composer = document.querySelector('[data-hatch-composer-chrome="true"]');
    if (!composer) return false;
    const previews = composer.querySelectorAll('img[src^="blob:"]').length;
    const removable = composer.querySelectorAll('[aria-label="Remove attachment"]').length;
    const send = composer.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    return previews >= expected && removable >= expected && !!send && !send.disabled;
  }, references.length, { timeout }).catch(() => {
    throw new GatewayError("muse_attachment", "Muse did not confirm the reference image attachment.", 502);
  });
}

/**
 * Runs inside the page. Muse renders source chips as links in their own assistant message item, outside the text bubble,
 * so `innerText` never shows them. Returns the links of the assistant items that follow the last user message.
 */
function sourceLinksInPage(): string[] {
  const items = [...document.querySelectorAll('[data-message-item="true"]')];
  const lastUser = items.map((item) => item.getAttribute("data-message-role")).lastIndexOf("user");
  if (lastUser < 0) return [];
  return items.slice(lastUser + 1)
    .filter((item) => item.getAttribute("data-message-role") === "assistant")
    .flatMap((item) => [...item.querySelectorAll<HTMLAnchorElement>("a[href]")])
    .filter((link) => !link.closest('[data-testid^="hatch-chat-file-card-"]') && link.hostname !== location.hostname)
    .map((link) => link.href);
}

/** The page a source chip really points to: Muse wraps it in an l.meta.ai redirect and appends a citation marker. */
export function resolveSourceUrl(href: string): string | null {
  try {
    const url = new URL(href);
    const target = url.hostname === "l.meta.ai" ? url.searchParams.get("u") : href;
    if (!target) return null;
    const real = new URL(target.split("\u3010")[0] ?? "");
    return real.protocol === "http:" || real.protocol === "https:" ? real.href : null;
  } catch {
    return null;
  }
}

/**
 * Every job opens /thread/new, which Muse keeps as a persistent side chat titled after the prompt. When the account's
 * context switch is off, the side chat this job just finished is deleted through Muse's own UI (⋯ → Delete → confirm).
 * Deletion cannot be undone, so it only touches the single row Muse marks as the open thread.
 */
const PRUNE_STEP_TIMEOUT = 5_000;

/** Opens the side-chat panel when collapsed, then deletes only its single marked current row. */
async function pruneCurrentThread(page: Page): Promise<boolean> {
  const current = page.locator('[data-testid="hatch-thread-row"][aria-current="page"]');
  try {
    // A closed panel unmounts every row, including the open thread's row.
    if (await current.count() === 0) {
      await page.getByTestId("hatch-chat-switcher-trigger").click({ timeout: PRUNE_STEP_TIMEOUT });
      await current.first().waitFor({ state: "visible", timeout: 10_000 });
    }
    if (await current.count() !== 1) return false;
    await current.hover({ timeout: PRUNE_STEP_TIMEOUT });
    await current.locator('button[aria-label="More thread actions"]').click({ timeout: PRUNE_STEP_TIMEOUT });
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click({ timeout: PRUNE_STEP_TIMEOUT });
    const confirm = page.getByRole("dialog").filter({ hasText: "Delete side chat?" });
    await confirm.getByRole("button", { name: "Delete", exact: true }).click({ timeout: PRUNE_STEP_TIMEOUT });
    await confirm.waitFor({ state: "detached", timeout: PRUNE_STEP_TIMEOUT });
    return true;
  } catch {
    // The result is already captured; a leftover side chat must never fail the job.
    return false;
  }
}

/** The origin override permits a local synthetic Muse page in adapter tests. */
export function createMuseAdapter(site = "https://muse.ai", chatTimeout = CHAT_TIMEOUT, pruneThreads = false, approvalTimeout = MUSE_APPROVAL_TIMEOUT_MS): ProviderAdapter {
  const origin = new URL(site);

  /**
   * Guarantees an assigned Muse session, waking a slept VM when needed, and persists the cookies Muse renews
   * on this call back to the account, so the account recovers on its own after a remote reset or a server reboot.
   */
  async function ensureAssignedSession(page: Page, browser: BrowserContext, credentials: Credentials, context: AdapterContext): Promise<void> {
    let state = await readSession(page, origin);
    if (state && state.status !== "assigned" && state.vmId && state.vmState !== "DISABLED") {
      await wakeVm(page, origin, state.vmId);
      const deadline = Date.now() + VM_WAKE_TIMEOUT;
      while (Date.now() < deadline && state.status !== "assigned") {
        await sleep(2_000);
        state = await readSession(page, origin) ?? state;
      }
    }
    if (state?.status !== "assigned") {
      throw new GatewayError("muse_auth", "Muse session is not assigned. Reconnect this account.", 401);
    }
    const renewed = (await browser.cookies([origin.href])).filter((cookie) => ESSENTIAL_COOKIES.has(cookie.name) && cookie.value);
    if (renewed.length === 0) return;
    // Chrome drops session cookies when the persistent context closes; a future expiry keeps them on disk.
    await browser.addCookies(renewed.map((cookie) => ({ ...cookie, expires: Math.floor(Date.now() / 1000) + 86_400 })));
    context.saveCredentials?.({ ...credentials, cookieHeader: renewed.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") });
  }

  return {
    info: {
      id: "muse",
      name: "Muse",
      contextWindow: 180_000,
      contextBasis: "measured-heuristic",
      description: "Chats (muse-agent) and generates images (muse-image) with your own muse.ai account in an isolated Chrome profile per account. Each job starts a new thread.",
      setupUrl: "https://muse.ai/",
      fields: [
        {
          key: "cookieHeader", label: "Cookie header", secret: true, required: false, multiline: true,
          help: "Optional. Sign into muse.ai with Google in your own browser, open DevTools > Network, select a muse.ai request, and copy its Cookie request header into this field. Include hatch_sess, hatch_gw, hatch_vml, and hatch_native_auth_device; never paste it into logs.",
        },
        {
          key: "cookieJson", label: "Cookies JSON", secret: true, required: false, multiline: true,
          help: "Optional alternative: paste an explicitly exported muse.ai cookie name/value JSON object or Chrome-style cookie array. Never supply cookies from another site.",
        },
        {
          key: "login", label: "Open browser for Google sign-in", secret: false, required: false,
          help: "Set to true, then press Check on the same desktop. A headed isolated browser opens for up to 2 minutes; sign in with Google there. The account's browser profile is saved under the data directory and reused without imported cookies. Set back to false after signing in.",
        },
      ],
      capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent", chat: true },
    },
    validate(credentials) {
      const result = configuration.safeParse(credentials);
      if (!result.success) throw new GatewayError("muse_credentials", "Invalid Muse credential fields.");
      cookiesFrom(credentials, origin);
      return credentials;
    },
    async check(credentials, context) {
      const config = this.validate(credentials);
      const browser = await openBrowser(config, context, origin);
      let page: Page | undefined;
      try {
        page = browser.pages()[0] ?? await browser.newPage();
        await page.goto(new URL("/thread/new", origin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.locator("textarea").first().waitFor({ state: "visible", timeout: config["login"] === "true" ? 120_000 : 20_000 });
        await ensureAssignedSession(page, browser, config, context);
        return { detail: "Signed in; Muse chat and assigned session confirmed." };
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError("muse_check", `Muse chat sign-in could not be confirmed; check the browser session and network. (${describeFailure(error, page)})`, 502);
      } finally {
        await browser.close();
      }
    },
    async watch(credentials, context) {
      const config = this.validate(credentials);
      const browser = await openBrowser({ ...config, login: "false" }, context, origin);
      try {
        const page = browser.pages()[0] ?? await browser.newPage();
        await watchMusePage(page, origin, context, resolve(context.dataDir, "muse", context.accountId, "watch-state.json"), approvalTimeout);
      } finally {
        await browser.close();
      }
    },
    /**
     * Deletes one side chat by id through the same single-row path a finished job uses. "gone" only when Muse itself sends
     * the page home; a page that is not the thread for any other reason is a failure to retry, never a deletion.
     */
    async deleteThread(credentials, threadId, context): Promise<ThreadDeletion> {
      const config = this.validate(credentials);
      if (!THREAD_ID.test(threadId)) return "failed";
      const browser = await openBrowser({ ...config, login: "false" }, context, origin);
      try {
        const page = browser.pages()[0] ?? await browser.newPage();
        const path = `/thread/${threadId}`;
        await page.goto(new URL(path, origin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.locator("textarea").first().waitFor({ state: "visible", timeout: 20_000 });
        const where = new URL(page.url()).pathname.replace(/\/$/, "");
        if (where === "/thread/new" || where === "") return "gone";
        if (where !== path) return "failed";
        return await pruneCurrentThread(page) ? "deleted" : "failed";
      } catch {
        return "failed";
      } finally {
        await browser.close();
      }
    },
    async run(credentials, prompt, context): Promise<RunResult> {
      const config = this.validate(credentials);
      if (!prompt.trim()) throw new GatewayError("muse_prompt", "Prompt must not be empty.");
      const references = context.referenceImages ?? [];
      if (references.length > MAX_IMAGES) throw new GatewayError("invalid_image", `Supply at most ${MAX_IMAGES} reference images.`);
      const browser = await openBrowser({ ...config, login: "false" }, context, origin);
      let submitted = false;
      let page: Page | undefined;
      let approvals: ApprovalWait | undefined;
      try {
        page = browser.pages()[0] ?? await browser.newPage();
        // Muse can assign the side-chat URL after Send returns. Report it before a timeout or restart loses the key.
        page.on("framenavigated", (frame) => {
          if (!submitted || frame.parentFrame()) return;
          const threadId = /^\/thread\/([^/]+)\/?$/.exec(new URL(frame.url()).pathname)?.[1];
          if (threadId && threadId !== "new") context.onAccepted?.(threadId);
        });
        // A topic key reopens its side chat. If that chat is gone (deleted by hand, or Muse redirects away), start a new one.
        let reused = false;
        if (context.threadId && THREAD_ID.test(context.threadId)) {
          const path = `/thread/${context.threadId}`;
          try {
            await page.goto(new URL(path, origin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.locator("textarea").first().waitFor({ state: "visible", timeout: 20_000 });
            reused = new URL(page.url()).pathname.replace(/\/$/, "") === path;
          } catch {
            reused = false;
          }
        }
        if (!reused) await page.goto(new URL("/thread/new", origin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const input = page.locator("textarea").first();
        await input.waitFor({ state: "visible", timeout: 20_000 });
        // The composer mounts before the remote conversation finishes loading.
        await page.getByRole("log").waitFor({ state: "attached", timeout: 30_000 });
        await ensureAssignedSession(page, browser, config, context);
        approvals = new ApprovalWait(page, context, scanApprovalCard, approvalTimeout);
        while (await approvals.check()) { /* drain pre-existing prompts before using the composer */ }
        if (!reused && await page.locator('div[class*="hatch-chat-groupable-bubble"]').count()) {
          throw new GatewayError("muse_thread", "New Muse thread contains previous messages.", 502);
        }
        // The upload precedes the baseline on purpose: the reference attached here is an existing attachment by then, so
        // it can never be mistaken for the result of the edit.
        // An upload cannot outlast the chat it belongs to, which also keeps the bounded test adapters fast.
        if (references.length) await attachReferences(page, references, Math.min(REFERENCE_UPLOAD_TIMEOUT, chatTimeout));
        // A generated image must be new, not a history attachment or the user's own upload.
        const baseline = await mediaBaseline(page);
        const baselineAttachments = baseline.cards;
        const baselineFiles = await page.locator(FILE_CARD).count();
        const existingThread = /^\/thread\/([^/]+)\/?$/.exec(new URL(page.url()).pathname)?.[1];
        const statePath = resolve(context.dataDir, "muse", context.accountId, "watch-state.json");
        if (existingThread && existingThread !== "new") {
          for (const hash of await rememberMuseTranscript(page, statePath, existingThread)) baseline.hashes.add(hash);
        }
        // Observe the actual Stop control transition, not text stability or a silent timeout.
        await page.evaluate(observeCompletion, { knownAttachments: baselineAttachments, approvalSelector: APPROVAL_CARD_SELECTOR });
        await input.fill(prompt);
        // The composer itself has role=button and can inherit "Send" in its
        // accessible name. Only click the actual, explicitly labelled control.
        const send = page.locator('button[aria-label="Send"]').first();
        let sendBy = Date.now() + 10_000;
        for (;;) {
          const tick = Date.now();
          if (await approvals.check()) {
            sendBy += Date.now() - tick;
            continue;
          }
          const remaining = sendBy - Date.now();
          if (remaining <= 0) throw new GatewayError("muse_send", "Muse send button did not become actionable.", 502);
          try {
            // An approval can mount after fill and intercept Send. A trial can be repeated; the real click cannot.
            await send.click({ trial: true, timeout: Math.min(250, remaining) });
            if (!await approvals.check()) break;
            sendBy += Date.now() - tick;
          } catch (error) {
            if (!(error instanceof errors.TimeoutError)) throw error;
          }
        }
        submitted = true; // A click can be accepted even if Playwright loses its acknowledgement.
        context.onSubmitted?.();
        await send.click();
        const threadId = /^\/thread\/([^/]+)\/?$/.exec(new URL(page.url()).pathname)?.[1];
        context.onAccepted?.(threadId && threadId !== "new" ? threadId : null);
        let finishBy = Date.now() + chatTimeout;
        for (;;) {
          if (!new URL(page.url()).pathname.startsWith("/thread/")) throw new Error("Muse left the chat thread.");
          const tick = Date.now();
          if (await approvals.check()) {
            finishBy += Date.now() - tick;
            continue;
          }
          if (!await page.evaluate(() => document.documentElement.dataset["museComplete"] === "true")) {
            if (Date.now() >= finishBy) throw new errors.TimeoutError("Muse generation completion timed out.");
            await sleep(Math.min(125, finishBy - Date.now()));
            continue;
          }
        const media = await generatedMedia(page, baseline);
        const images = media.images;
        // An image-only answer has no agent text bubble, and waiting for one timed out after the image had arrived.
        const bubbles = page.locator('div[class*="hatch-agent-bubble-bg"]');
        const message = await bubbles.count() ? await bubbles.last().evaluate((element: HTMLElement) => ({
          id: element.closest("[data-message-id]")?.getAttribute("data-message-id") ?? "",
          text: element.innerText.trim(),
        })) : null;
        const rawText = message?.text ?? "";
        // innerText drops link targets (source chips are links outside the bubble), so list the ones the text lacks.
        const sources = [...new Set((await page.evaluate(sourceLinksInPage)).map(resolveSourceUrl))]
          .filter((url): url is string => url !== null && !rawText.includes(url));
        // With the addresses attached, a bare "출처:" label left at the end of the text would only dangle.
        const body = sources.length ? rawText.replace(/\s*(출처|Sources?)\s*[:：]\s*$/i, "").trim() : rawText.trim();
        const downloaded = await downloadFiles(page, baselineFiles, 3 - media.files.length);
        const files = [...media.files, ...downloaded.files].slice(0, 3);
        const text = [body, ...sources.map((url) => `출처: ${url}`), ...media.notes, ...downloaded.blocks].filter(Boolean).join("\n\n");
        // Media and file extraction can take seconds. Do not commit the candidate if a late
        // approval or resumed generation invalidated the Stop transition during extraction.
        const candidateAt = Date.now();
        if (await approvals.check()) {
          finishBy += Date.now() - candidateAt;
          continue;
        }
        if (!await page.evaluate(() => document.documentElement.dataset["museComplete"] === "true")) continue;
        if (!text.trim() && images.length === 0 && files.length === 0) {
          if (Date.now() >= finishBy) throw new GatewayError("muse_result", "Muse finished without text or media.", 502, true);
          await sleep(Math.min(125, finishBy - Date.now()));
          continue;
        }
        const match = /^\/thread\/([^/]+)\/?$/.exec(new URL(page.url()).pathname);
        const pendingTask = await page.evaluate(hasPendingMuseTask);
        const remoteId = match?.[1] && match[1] !== "new" ? match[1] : null;
        const pruned = pruneThreads && !pendingTask && await pruneCurrentThread(page);
        if (remoteId && !pruned) {
          await rememberMuseTranscript(page, statePath, remoteId, {
            message, sources: media.sources, files: downloaded.ids,
            historicalPresentations: baseline.presentations, historicalMessages: baseline.messages,
          })
            .catch(() => undefined); // A checkpoint failure must not turn a confirmed reply into a retry.
        }
        return {
          text: text.trim(),
          remoteId,
          ...(pendingTask ? { pendingTask } : {}),
          ...(images.length ? { images } : {}),
          ...(files.length ? { files } : {}),
        };
        }
      } catch (error) {
        if (error instanceof GatewayError) {
          if (!submitted || error.uncertain || error.code === "approval_timeout") throw error;
          throw new GatewayError(error.code, error.message, error.status, true);
        }
        const cause = describeFailure(error, page);
        throw new GatewayError(
          submitted ? "muse_uncertain" : "muse_unavailable",
          submitted
            ? `Muse submission may have succeeded, but completion was not confirmed. (${cause})`
            : `Muse chat was unavailable before submission. (${cause})`,
          502, submitted,
        );
      } finally {
        await approvals?.dispose();
        await browser.close();
      }
    },
  };
}

async function openBrowser(credentials: Credentials, context: AdapterContext, origin: URL) {
  if (context.signal.aborted) throw new GatewayError("muse_cancelled", "Muse request cancelled.");
  const chrome = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find(existsSync);
  const bundled = chromium.executablePath();
  // Prefer the browser revision tested with this Playwright release. A newer desktop
  // Chrome can start but never complete persistent-context initialization.
  const executablePath = existsSync(bundled) ? bundled : chrome;
  if (!executablePath) throw new GatewayError("muse_browser", "Install Chrome or run bunx playwright install chromium.", 503);
  let browser: BrowserContext;
  try {
    browser = await chromium.launchPersistentContext(resolve(context.dataDir, "muse", context.accountId), {
      // Let Playwright use its matching headless-shell for unattended work and
      // full Chromium for login. Forcing full desktop Chrome in headless mode
      // also starts platform browser UI targets and can stall initialization.
      ...(existsSync(bundled) ? {} : { executablePath }),
      headless: credentials["login"] !== "true", timeout: 20_000,
    });
  } catch {
    throw new GatewayError("muse_browser", "Chrome could not open this account profile.", 503);
  }
  const abort = () => { void browser.close(); };
  context.signal.addEventListener("abort", abort, { once: true });
  browser.on("close", () => context.signal.removeEventListener("abort", abort));
  try {
    if (context.signal.aborted) throw new GatewayError("muse_cancelled", "Muse request cancelled.");
    // Only our account-specific profile is involved. Keep one tab instead of
    // restoring an ever-growing set of old provider pages on every operation.
    for (const page of browser.pages().slice(1)) await page.close();
    const imported = cookiesFrom(credentials, origin);
    if (imported.length) await browser.addCookies(imported);
    return browser;
  } catch (error) {
    context.signal.removeEventListener("abort", abort);
    await browser.close();
    throw error;
  }
}
