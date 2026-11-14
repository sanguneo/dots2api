import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { sniffImage } from "../images";
import { ClientError } from "./config";
import type { Connection } from "./config";
import { jobImage } from "./http";

export async function saveImage(path: string, bytes: Uint8Array): Promise<string> {
  const mime = sniffImage(bytes);
  if (!mime) throw new ClientError("The response did not contain PNG, JPEG or WebP image bytes.");
  const extension = mime === "image/png" ? ".png" : mime === "image/jpeg" ? ".jpg" : ".webp";
  // A provider may return WebP even when the requested filename ends in .png.
  const actual = resolve(path.replace(/\.(png|jpe?g|webp)$/i, "") + extension);
  await mkdir(dirname(actual), { recursive: true, mode: 0o700 });
  await writeFile(actual, bytes, { mode: 0o600 });
  return actual;
}

/** Download only explicitly requested attachments, never arbitrary markdown links. */
export async function saveChatMedia(connection: Connection, text: string, directory: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const target = resolve(directory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  let index = 0;
  for (const match of text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (!match[1]) continue;
    paths.push(await saveImage(join(target, `image-${++index}`), await jobImage(connection, match[1])));
  }
  for (const match of text.matchAll(/\[\[file name="([^"]*)" encoding="(utf8|base64)"\]\]\n([\s\S]*?)\n\[\[\/file\]\]/g)) {
    const [, name, encoding, content] = match;
    if (name === undefined || content === undefined) continue;
    const safeName = basename(name.replaceAll("\\", "/"));
    if (!safeName || safeName === "." || safeName === "..") throw new ClientError("Invalid attachment filename.");
    // Prefix prevents collisions with generated images and repeated attachment names.
    const output = join(target, `file-${++index}-${safeName}`);
    await writeFile(output, Buffer.from(content, encoding === "base64" ? "base64" : "utf8"), { mode: 0o600 });
    paths.push(output);
  }
  return paths;
}
