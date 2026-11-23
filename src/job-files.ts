import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MAX_FILE_BYTES, MAX_FILES } from "./contracts";
import type { JobFile, JobId, RunFile } from "./contracts";

const mimeSchema = z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/);
export const jobFilesSchema = z.array(z.object({
  name: z.string().min(1).max(255),
  mime: mimeSchema,
  bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
})).max(MAX_FILES).default([]);

export class JobFiles {
  constructor(private readonly dataDir: string) {}

  private directory(id: string): string {
    return join(this.dataDir, "files", id);
  }

  save(id: JobId, files: readonly RunFile[]): JobFile[] {
    const saved: JobFile[] = [];
    const directory = this.directory(id);
    try {
      for (const file of files) {
        if (saved.length >= MAX_FILES) break;
        if (file.data.byteLength > MAX_FILE_BYTES) continue;
        const basename = (file.name.split(/[\\/]/).pop() ?? "").toWellFormed()
          .replace(/[\p{Cc}\p{Bidi_Control}]/gu, "").trim().slice(0, 255).toWellFormed();
        const name = !basename || basename === "." || basename === ".." ? `file-${saved.length + 1}` : basename;
        const mime = mimeSchema.safeParse(file.mime.split(";", 1)[0]?.trim().toLowerCase()).data ?? "application/octet-stream";
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(join(directory, String(saved.length)), file.data, { mode: 0o600 });
        saved.push({ name, mime, bytes: file.data.byteLength });
      }
      return saved;
    } catch (error) {
      this.remove(id);
      throw error;
    }
  }

  open(id: JobId, index: number): Blob | null {
    const path = join(this.directory(id), String(index));
    return existsSync(path) ? Bun.file(path) : null;
  }

  remove(id: string): void {
    rmSync(this.directory(id), { recursive: true, force: true });
  }
}
