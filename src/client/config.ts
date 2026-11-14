import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export class ClientError extends Error {
  constructor(message: string) { super(message); this.name = "ClientError"; }
}

const configuration = z.object({
  baseUrl: z.string().url(),
  apiKeyFile: z.string().min(1).optional(),
});
export type Configuration = z.infer<typeof configuration>;
export interface Connection {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export function configPath(override?: string): string {
  return resolve(override ?? join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "dots2api", "client.json"));
}

export function baseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ClientError("Use an HTTP(S) server address without credentials, query parameters or a fragment.");
  }
  return url.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function configure(path: string, input: Configuration): Promise<void> {
  const settings = configuration.parse(input);
  const value = { ...settings, baseUrl: baseUrl(settings.baseUrl), ...(settings.apiKeyFile ? { apiKeyFile: resolve(settings.apiKeyFile) } : {}) };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

export async function connect(options: { readonly config?: string; readonly base?: string; readonly keyFile?: string }): Promise<Connection> {
  const path = configPath(options.config);
  const file = Bun.file(path);
  const saved = await file.exists() ? configuration.parse(await file.json()) : undefined;
  const address = baseUrl(options.base ?? process.env["DOTS2API_BASE_URL"] ?? saved?.baseUrl ?? "http://127.0.0.1:3010");
  const keyFile = options.keyFile ?? process.env["DOTS2API_KEY_FILE"] ?? saved?.apiKeyFile;
  const key = process.env["DOTS2API_API_KEY"] ?? (keyFile ? await readFile(keyFile, "utf8") : "");
  if (!key.trim()) throw new ClientError("Set DOTS2API_API_KEY, or configure --key-file with your own server API key. Keys are never bundled.");
  return { baseUrl: address, apiKey: key.trim() };
}
