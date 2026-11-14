import { parseArgs } from "node:util";
import { RelayError } from "./config";
import { TelegramRelay } from "./relay";

export async function runTelegramRelay(configPath: string, signal: AbortSignal): Promise<void> {
  const relay = await TelegramRelay.open(configPath, signal);
  try { while (!signal.aborted) await relay.pollOnce(); }
  finally { await relay.close(); }
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const { values } = parseArgs({ options: { config: { type: "string" } }, strict: true });
    if (!values.config) throw new RelayError("configuration");
    await runTelegramRelay(values.config, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) {
      // Never log SDK errors: they can contain bot-token URLs, request bodies or keys.
      console.error(error instanceof RelayError ? error.message : "Telegram relay stopped. Inspect configuration and local state.");
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
