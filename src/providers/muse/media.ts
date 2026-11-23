import type { Page } from "playwright";
import { MAX_FILE_BYTES, MAX_FILES } from "../../contracts";
import type { RunFile, RunImage } from "../../contracts";
import { MAX_IMAGES } from "../../images";

export const FILE_CARD = '[data-testid^="hatch-chat-file-card-"]:not([data-hatch-composer-chrome] *):not([class*=chat-user-bubble] *)';
const INLINE_BYTES = 2 * 1024 * 1024;
const FILE_END = "[[/file]]";

interface Attachment {
  readonly src: string;
  readonly video: boolean;
  readonly width: number;
  readonly height: number;
}

/** Runs in the browser; a file card's nested icon is never generated media. */
export function attachmentsInPage(): Attachment[] {
  const result: Attachment[] = [];
  const seen = new Set<string>();
  document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"], div[class*="hatch-agent-bubble-bg"] img, div[class*="hatch-agent-bubble-bg"] video').forEach((element) => {
    if (element.closest('form,[data-hatch-composer-chrome],[class*=chat-user-bubble],[class*="group/msg"],[data-testid^="hatch-chat-file-card-"]')
      || element.querySelector('[data-testid^="hatch-chat-file-card-"]')) return;
    const video = element instanceof HTMLVideoElement ? element : element.querySelector("video");
    const image = element instanceof HTMLImageElement ? element : element.querySelector("img");
    const src = video ? video.currentSrc || video.src || video.querySelector("source")?.src || "" : image?.currentSrc || image?.src || "";
    if (!src || seen.has(src) || src.includes("avatar") || src.includes("emoji")) return;
    seen.add(src);
    result.push({
      src, video: video !== null,
      width: video?.videoWidth || image?.naturalWidth || 0,
      height: video?.videoHeight || image?.naturalHeight || 0,
    });
  });
  return result;
}

/** Runs in the browser so authenticated, blob: and data: media share the same bounded download. */
async function mediaBytesInPage(src: string) {
  const limit = 50 * 1024 * 1024;
  const response = await fetch(src, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) return { error: `media HTTP ${response.status}` };
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    return { error: "larger than 50 MiB, not attached" };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return { error: "larger than 50 MiB, not attached" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  const mime = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
  const b64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([data], { type: mime }));
  });
  return { mime, b64 };
}

export async function generatedMedia(page: Page, baseline: { readonly sources: ReadonlySet<string>; readonly cards: number }) {
  const collect = async () => (await page.evaluate(attachmentsInPage)).filter((item) => !baseline.sources.has(item.src) && !item.src.startsWith("data:image/svg"));
  let fresh = await collect();
  if (!fresh.length) {
    const pending = await page.locator('[data-testid^="hatch-chat-attachment-presentation-"]').count() > baseline.cards;
    await page.waitForFunction((known: string[]) => [...document.querySelectorAll('div[class*="hatch-agent-bubble-bg"] img,div[class*="hatch-agent-bubble-bg"] video,[data-testid^="hatch-chat-attachment-presentation-"] img,[data-testid^="hatch-chat-attachment-presentation-"] video')]
      .some((element) => {
        if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement)) return false;
        const src = element.currentSrc || element.src;
        return src && !known.includes(src) && !src.includes("avatar") && !src.includes("emoji");
      }), [...baseline.sources], { timeout: pending ? 10000 : 2000 }).catch(() => {});
    fresh = await collect();
  }
  if (fresh.some((item) => !item.video && item.width === 0)) {
    await page.waitForFunction((sources: string[]) => [...document.querySelectorAll("img")].some((image) =>
      sources.includes(image.currentSrc || image.src) && image.complete && image.naturalWidth > 0),
    fresh.filter((item) => !item.video).map((item) => item.src), { timeout: 10000 }).catch(() => {});
    fresh = await collect();
  }
  const images: RunImage[] = [];
  const files: RunFile[] = [];
  const notes: string[] = [];
  for (const item of fresh) {
    if (item.video ? files.length >= MAX_FILES : images.length >= MAX_IMAGES) continue;
    const bytes = await page.evaluate(mediaBytesInPage, item.src).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return { error: "download failed", mime: undefined, b64: undefined };
    });
    if (bytes.error || !bytes.b64 || !bytes.mime) {
      if (item.video) notes.push(`[video: ${bytes.error ?? "download failed"}]`);
      continue;
    }
    const data = new Uint8Array(Buffer.from(bytes.b64, "base64"));
    if (item.video) {
      const extension = bytes.mime === "video/webm" ? "webm" : bytes.mime === "video/quicktime" ? "mov" : "mp4";
      files.push({ name: `video-${files.length + 1}.${extension}`, mime: bytes.mime, data });
    } else {
      const mime = bytes.mime === "image/webp" ? "image/webp" : bytes.mime === "image/jpeg" ? "image/jpeg" : "image/png";
      images.push({ mime, data, ...(item.width > 0 && item.height > 0 ? { width: item.width, height: item.height } : {}) });
    }
  }
  return { images, files, notes };
}

export function fileBlock(name: string, data: Uint8Array): string {
  const text = Buffer.from(data).toString("utf8");
  const plain = !text.includes("\uFFFD") && !text.includes(FILE_END);
  const safeName = name.replace(/["\r\n]/g, "_");
  return `[[file name="${safeName}" encoding="${plain ? "utf8" : "base64"}"]]\n${plain ? text : Buffer.from(data).toString("base64")}\n${FILE_END}`;
}

/** The native Download action supplies the actual bytes, not the file viewer's preview. */
export async function downloadFiles(page: Page, knownCards: number, limit = MAX_FILES) {
  const cards = page.locator(FILE_CARD);
  const total = await cards.count();
  const blocks: string[] = [];
  const files: RunFile[] = [];
  for (let index = knownCards; index < Math.min(total, knownCards + limit); index += 1) {
    const card = cards.nth(index);
    const title = await card.locator("[title]").first().getAttribute("title", { timeout: 2000 }).catch(() => null) ?? `file-${index + 1}`;
    try {
      await card.click({ timeout: 8000 });
      await page.locator('button[aria-label="More actions"]').first().click({ timeout: 8000 });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 8000 }),
        page.getByRole("menuitem", { name: "Download", exact: true }).click({ timeout: 8000 }),
      ]);
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const data = Buffer.from(chunk);
        size += data.byteLength;
        if (size > MAX_FILE_BYTES) { await download.cancel(); break; }
        chunks.push(data);
      }
      if (size > MAX_FILE_BYTES) {
        blocks.push(`[file ${title}: larger than 50 MiB, not attached]`);
      } else {
        const name = download.suggestedFilename() || title;
        const data = new Uint8Array(Buffer.concat(chunks));
        const text = Buffer.from(data).toString("utf8");
        if (size <= INLINE_BYTES && !text.includes("\uFFFD") && !text.includes("\0")) {
          blocks.push(fileBlock(name, data));
        } else {
          const extension = name.split(".").pop()?.toLowerCase();
          const mime = extension === "mp4" ? "video/mp4" : extension === "webm" ? "video/webm" : extension === "mov" ? "video/quicktime" : "application/octet-stream";
          files.push({ name, mime, data });
        }
      }
      await download.delete();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      blocks.push(`[file ${title}: download failed]`);
    }
    await page.locator('button[aria-label="Close"]').first().click({ timeout: 2000 }).catch(() => {});
  }
  return { blocks, files };
}
