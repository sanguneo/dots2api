import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { z } from "zod";
import { GatewayError } from "../../contracts";
import type { AdapterContext, Credentials, ProviderAdapter, ReferenceImage, RunImage, RunResult } from "../../contracts";
import { IMAGE_EXTENSIONS, MAX_IMAGES } from "../../images";

const configuration = z.object({
  cookieHeader: z.string().trim().optional(),
  cookieJson: z.string().trim().optional(),
  login: z.enum(["true", "false"]).optional(),
}).strict();
const importedCookies = z.union([
  z.record(z.string(), z.string()),
  z.array(z.object({ name: z.string(), value: z.string(), domain: z.string().optional() })),
]);
const CHAT_TIMEOUT = 300_000;
const ATTACHMENT_TIMEOUT = 10_000;
/** References can total 32 MiB, so their upload gets its own, much longer, budget than a thumbnail read. */
const REFERENCE_UPLOAD_TIMEOUT = 120_000;
const MEDIA_LOAD_TIMEOUT = 10_000;
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

interface Attachment {
  readonly tid: string;
  readonly hasVideo: boolean;
  readonly src: string;
  readonly vSrc: string;
  readonly iSrc: string;
  readonly w: number;
  readonly h: number;
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
 * Runs inside the page. Collects generated media from the attachment cards and the agent bubbles, while
 * excluding the composer, the user's own uploads and history, and avatar/emoji imagery. This mirrors the
 * selectors the community muse.ai clients rely on and is re-checked against the live DOM in `check`.
 */
function attachmentsInPage(): Attachment[] {
  const list: Attachment[] = [];
  const seenElement = new Set<Element>();
  const seenSource = new Set<string>();
  const addElement = (element: Element | null, tid: string): void => {
    if (!element || seenElement.has(element)) return;
    seenElement.add(element);
    // The live composer has no <form>; it is marked data-hatch-composer-chrome and holds the user's own uploads.
    if (element.closest('form, [data-hatch-composer-chrome], [class*=chat-user-bubble], [class*="group/msg"]')) return;
    const video = element.querySelector("video") ?? (element.tagName === "VIDEO" ? element : null);
    const image = element.querySelector("img") ?? (element.tagName === "IMG" ? element : null);
    const isVideo = (tid || "").includes("video") || video !== null;
    const primary = (isVideo ? (video ?? image) : (image ?? video)) as (HTMLImageElement & HTMLVideoElement) | null;
    const src = primary ? (primary.currentSrc || primary.src || "") : "";
    if (!src || seenSource.has(src)) return;
    seenSource.add(src);
    list.push({
      tid: tid || element.getAttribute("data-testid") || (isVideo ? "video" : "image"),
      hasVideo: video !== null,
      src,
      vSrc: video ? ((video as HTMLVideoElement).currentSrc || (video as HTMLVideoElement).src || "") : "",
      iSrc: image ? ((image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src || "") : "",
      w: primary ? (primary.videoWidth || primary.naturalWidth || 0) : 0,
      h: primary ? (primary.videoHeight || primary.naturalHeight || 0) : 0,
    });
  };
  document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]').forEach((element) => {
    addElement(element, element.getAttribute("data-testid") ?? "");
  });
  document.querySelectorAll('div[class*="hatch-agent-bubble-bg"] img, div[class*="hatch-agent-bubble-bg"] video').forEach((media) => {
    const src = (media as HTMLImageElement).currentSrc || (media as HTMLImageElement).src || "";
    if (src && !src.includes("avatar") && !src.includes("emoji")) addElement(media.parentElement ?? media, "agent-media");
  });
  return list;
}

/** Runs inside the page: the bytes of one media URL as base64, so `blob:` and `data:` sources work too. */
export async function mediaBytesInPage({ src, limit }: { readonly src: string; readonly limit: number }): Promise<{ readonly ok: boolean; readonly mime?: string; readonly b64?: string; readonly bytes?: number; readonly err?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(src, { signal: controller.signal });
    if (!response.ok) return { ok: false, err: `media-http-${response.status}` };
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      return { ok: false, err: "media-too-large" };
    }
    if (!response.body) return { ok: false, err: "media-no-body" };
    const input = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    try {
      while (true) {
        const { value, done } = await input.read();
        if (done) break;
        received += value.byteLength;
        if (received > limit) {
          await input.cancel();
          return { ok: false, err: "media-too-large" };
        }
        chunks.push(new Uint8Array(value));
      }
    } finally { input.releaseLock(); }
    const blob = new Blob(chunks, { type: response.headers.get("content-type") ?? "" });
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { ok: true, mime: blob.type || "", b64: dataUrl.slice(dataUrl.indexOf(",") + 1), bytes: received };
  } catch (error) {
    return { ok: false, err: String(error) };
  } finally { clearTimeout(timer); }
}

/**
 * Every job opens /thread/new, which Muse keeps as a persistent side chat titled after the prompt. When the account's
 * context switch is off, the side chat this job just finished is deleted through Muse's own UI (⋯ → Delete → confirm).
 * Deletion cannot be undone, so it only touches the single row Muse marks as the open thread.
 */
const PRUNE_STEP_TIMEOUT = 5_000;

/** Deletes the side chat open on this page; false when it is not exactly one marked row or any step fails. */
async function pruneCurrentThread(page: Page): Promise<boolean> {
  const current = page.locator('[data-testid="hatch-thread-row"][aria-current="page"]');
  if (await current.count() !== 1) return false;
  try {
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

function attachmentMime(reported: string | undefined): RunImage["mime"] {
  if (reported === "image/webp") return "image/webp";
  if (reported === "image/jpeg") return "image/jpeg";
  return "image/png";
}

/** The origin override permits a local synthetic Muse page in adapter tests. */
export function createMuseAdapter(site = "https://muse.ai", chatTimeout = CHAT_TIMEOUT, pruneThreads = false): ProviderAdapter {
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
    const { cookieJson: _imported, ...canonical } = credentials;
    context.saveCredentials?.({ ...canonical, cookieHeader: renewed.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") });
  }

  async function generatedImages(page: Page, baseline: ReadonlySet<string>): Promise<RunImage[]> {
    const collect = async (): Promise<Attachment[]> =>
      (await page.evaluate(attachmentsInPage)).filter((attachment) =>
        attachment.src && !attachment.hasVideo && !baseline.has(attachment.src) && !attachment.src.startsWith("data:image/svg"));
    let fresh = await collect();
    if (fresh.length === 0) {
      try {
        await page.waitForFunction((known: string[]) => {
          const seen = new Set(known);
          return [...document.querySelectorAll('div[class*="hatch-agent-bubble-bg"] img, [data-testid^="hatch-chat-attachment-presentation-"] img')]
            .some((node) => {
              const src = (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src || "";
              return src && !seen.has(src) && !src.includes("avatar") && !src.includes("emoji");
            });
        }, [...baseline], { timeout: ATTACHMENT_TIMEOUT });
      } catch {
        // A text-only answer produces no attachment.
      }
      fresh = await collect();
    }
    if (fresh.length > 0) {
      // The bytes can arrive before the element reports a size; the size is read after it loads.
      try {
        await page.waitForFunction((sources: string[]) => {
          const wanted = new Set(sources);
          return [...document.querySelectorAll("img")].some((img) => wanted.has(img.currentSrc || img.src || "") && img.complete && img.naturalWidth > 0);
        }, fresh.map((attachment) => attachment.src), { timeout: MEDIA_LOAD_TIMEOUT });
      } catch {
        // Fetch whatever bytes are reachable even if the element never reports a size.
      }
      fresh = await collect();
    }
    const images: RunImage[] = [];
    let remaining = 32 * 1024 * 1024;
    for (const attachment of fresh.slice(0, MAX_IMAGES)) {
      const bytes = await page.evaluate(mediaBytesInPage, { src: attachment.src, limit: remaining });
      if (bytes.err === "media-too-large") throw new GatewayError("muse_image_limit", "Muse exceeded the 32 MiB image result budget.", 502, true);
      if (!bytes.ok || !bytes.b64) continue;
      remaining -= bytes.bytes ?? 0;
      images.push({
        mime: attachmentMime(bytes.mime),
        data: new Uint8Array(Buffer.from(bytes.b64, "base64")),
        ...(attachment.w > 0 && attachment.h > 0 ? { width: attachment.w, height: attachment.h } : {}),
      });
    }
    return images;
  }

  return {
    info: {
      id: "muse",
      name: "Muse",
      contextWindow: 180_000,
      contextBasis: "measured-heuristic",
      description: "Generates images with your own muse.ai account in an isolated Chrome profile per account. Each job starts a new thread.",
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
      capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent", chat: false },
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
    async run(credentials, prompt, context): Promise<RunResult> {
      const config = this.validate(credentials);
      if (!prompt.trim()) throw new GatewayError("muse_prompt", "Prompt must not be empty.");
      const references = context.referenceImages ?? [];
      if (references.length > MAX_IMAGES) throw new GatewayError("invalid_image", `Supply at most ${MAX_IMAGES} reference images.`);
      const browser = await openBrowser({ ...config, login: "false" }, context, origin);
      let submitted = false;
      let page: Page | undefined;
      try {
        page = browser.pages()[0] ?? await browser.newPage();
        await page.goto(new URL("/thread/new", origin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const input = page.locator("textarea").first();
        await input.waitFor({ state: "visible", timeout: 20_000 });
        // The composer mounts before the remote conversation finishes loading.
        await page.getByRole("log").waitFor({ state: "attached", timeout: 30_000 });
        await ensureAssignedSession(page, browser, config, context);
        if (await page.locator('div[class*="hatch-chat-groupable-bubble"]').count()) {
          throw new GatewayError("muse_thread", "New Muse thread contains previous messages.", 502);
        }
        // The upload precedes the baseline on purpose: the reference attached here is an existing attachment by then, so
        // it can never be mistaken for the result of the edit.
        // An upload cannot outlast the chat it belongs to, which also keeps the bounded test adapters fast.
        if (references.length) await attachReferences(page, references, Math.min(REFERENCE_UPLOAD_TIMEOUT, chatTimeout));
        // A generated image must be new, not a history attachment or the user's own upload.
        const baseline = new Set((await page.evaluate(attachmentsInPage)).flatMap((attachment) => [attachment.src, attachment.vSrc, attachment.iSrc]).filter(Boolean));
        const baselineAttachments = await page.locator('[data-testid^="hatch-chat-attachment-presentation-"]').count();
        // Observe the actual Stop control transition, not text stability or a silent timeout.
        await page.evaluate((knownAttachments: number) => {
          let seenStop = false;
          const root = document.documentElement;
          const stopSelector = '[data-testid="hatch-composer-stop-button"], button[aria-label*="Stop" i], button[aria-label*="\u{505c}\u{6b62}"]';
          const observe = () => {
            const stop = document.querySelector(stopSelector);
            if (stop) seenStop = true;
            if (root.dataset["museComplete"] === "true" || !seenStop || stop) return;
            if (!document.querySelector('div[class*="chat-user-bubble"]')) return;
            const hasText = [...document.querySelectorAll('div[class*="hatch-agent-bubble-bg"]')].some((bubble) => bubble.textContent?.trim());
            const hasMedia = document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]').length > knownAttachments;
            if (hasText || hasMedia) root.dataset["museComplete"] = "true";
          };
          new MutationObserver(observe).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
          observe();
        }, baselineAttachments);
        await input.fill(prompt);
        // The composer itself has role=button and can inherit "Send" in its
        // accessible name. Only click the actual, explicitly labelled control.
        const send = page.locator('button[aria-label="Send"]').first();
        await send.waitFor({ state: "visible", timeout: 10_000 });
        if (!await send.isEnabled()) throw new GatewayError("muse_send", "Muse send button is disabled.", 502);
        submitted = true; // A click can be accepted even if Playwright loses its acknowledgement.
        await send.click();
        const threadId = /^\/thread\/([^/]+)\/?$/.exec(new URL(page.url()).pathname)?.[1];
        context.onAccepted?.(threadId && threadId !== "new" ? threadId : null);
        await page.waitForFunction(() => {
          if (!location.pathname.startsWith("/thread/")) throw new Error("Muse left the chat thread.");
          return document.documentElement.dataset["museComplete"] === "true";
        }, null, { timeout: chatTimeout });
        const images = await generatedImages(page, baseline);
        const text = await page.locator('div[class*="hatch-agent-bubble-bg"]').last().innerText();
        if (!text.trim() && images.length === 0) throw new GatewayError("muse_result", "Muse finished without text or an image.", 502, true);
        const match = /^\/thread\/([^/]+)\/?$/.exec(new URL(page.url()).pathname);
        if (pruneThreads) await pruneCurrentThread(page);
        return {
          text: text.trim(),
          remoteId: match?.[1] && match[1] !== "new" ? match[1] : null,
          ...(images.length ? { images } : {}),
        };
      } catch (error) {
        if (error instanceof GatewayError) {
          if (!submitted || error.uncertain) throw error;
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
