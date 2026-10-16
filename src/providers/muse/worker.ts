import { z } from "zod";
import { accountIdSchema, GatewayError } from "../../contracts";
import { MAX_IMAGES } from "../../images";
import { createMuseAdapter } from "./engine";
import { MAX_WORKER_LINE_BYTES } from "./io";

const requestSchema = z.object({
  operation: z.enum(["check", "run"]),
  site: z.url(),
  chatTimeout: z.number().positive(),
  credentials: z.record(z.string(), z.string()),
  accountId: accountIdSchema,
  dataDir: z.string(),
  prompt: z.string(),
  pruneThreads: z.boolean().default(false),
  referenceImages: z.array(z.object({
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    dataB64: z.string().min(1),
  })).max(MAX_IMAGES).default([]),
});
const buffers: Buffer[] = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > MAX_WORKER_LINE_BYTES) throw new GatewayError("muse_worker", "Muse worker input exceeds its byte budget.", 413);
  buffers.push(Buffer.from(chunk));
}
const controller = new AbortController();
const abort = () => controller.abort();
process.on("SIGTERM", abort);
function emit(value: object): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
try {
  const input = requestSchema.parse(JSON.parse(Buffer.concat(buffers).toString("utf8")));
  const adapter = createMuseAdapter(input.site, input.chatTimeout, input.pruneThreads);
  const context = {
    accountId: input.accountId, dataDir: input.dataDir, signal: controller.signal,
    referenceImages: input.referenceImages.map((image) => ({ mime: image.mime, data: new Uint8Array(Buffer.from(image.dataB64, "base64")) })),
    onAccepted: (remoteId: string | null) => emit({ type: "accepted", remoteId }),
    saveCredentials: (credentials: Record<string, string>) => emit({ type: "credentials", credentials }),
  };
  switch (input.operation) {
    case "check":
      emit({ type: "checked", ...await adapter.check(input.credentials, context) });
      break;
    case "run": {
      const result = await adapter.run(input.credentials, input.prompt, context);
      emit({
        type: "completed",
        text: result.text,
        remoteId: result.remoteId,
        images: (result.images ?? []).map((image) => ({
          mime: image.mime,
          dataB64: Buffer.from(image.data).toString("base64"),
          ...(image.width !== undefined ? { width: image.width } : {}),
          ...(image.height !== undefined ? { height: image.height } : {}),
          ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
        })),
      });
      break;
    }
  }
} catch (error) {
  emit({
    type: "failed",
    code: error instanceof GatewayError ? error.code : "muse_worker",
    message: error instanceof GatewayError ? error.message : "Muse worker could not confirm the operation.",
    status: error instanceof GatewayError ? error.status : 502,
    uncertain: error instanceof GatewayError ? error.uncertain : true,
  });
} finally { process.off("SIGTERM", abort); }
