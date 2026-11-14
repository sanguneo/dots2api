import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const secretReference = z.union([
  z.object({ file: z.string().min(1) }).strict(),
  z.object({ env: z.string().min(1) }).strict(),
]);
const apiBase = z.url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === "/";
}, "API base must be an HTTP(S) origin without credentials, path, query or fragment.");
const id = z.number().int().safe();

export const telegramConfigSchema = z.object({
  gateway: z.object({
    baseURL: apiBase.default("http://127.0.0.1:3010"),
    apiKey: secretReference,
  }).strict(),
  telegram: z.object({
    botToken: secretReference,
    apiBaseURL: apiBase.default("https://api.telegram.org"),
  }).strict(),
  allowedUserIds: z.array(id.positive()).min(1),
  allowedChatIds: z.array(id).default([]),
  allowBotMessages: z.boolean().default(false),
  model: z.enum(["dots-agent", "muse-agent"]).default("muse-agent"),
  systemPrompt: z.string().default("You are a helpful assistant."),
  stateDir: z.string().min(1).default("./telegram-state"),
  requestTimeoutMs: z.number().int().min(100).max(3_600_000).default(300_000),
  pollTimeoutSeconds: z.number().int().min(0).max(50).default(25),
}).strict();

export type TelegramConfig = z.infer<typeof telegramConfigSchema>;
export class RelayError extends Error {
  constructor(readonly code: "configuration" | "locked" | "state" | "pending" | "network" | "protocol" | "rejected" | "image") {
    super(`Telegram relay stopped (${code}). No automatic resubmission; inspect local state before restarting.`);
    this.name = "RelayError";
  }
}

/** Secrets and paths are resolved relative to the config file, never the working directory. */
export async function loadTelegramConfig(path: string) {
  try {
    const config = telegramConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const base = dirname(resolve(path));
    const secret = async (reference: z.infer<typeof secretReference>) => {
      const value = "file" in reference
        ? await readFile(resolve(base, reference.file), "utf8")
        : process.env[reference.env];
      if (!value?.trim() || /[\r\n]/.test(value.trim())) throw new RelayError("configuration");
      return value.trim();
    };
    const apiKey = await secret(config.gateway.apiKey);
    const botToken = await secret(config.telegram.botToken);
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new RelayError("configuration");
    return { config, apiKey, botToken, stateDir: resolve(base, config.stateDir) };
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError("configuration");
  }
}
