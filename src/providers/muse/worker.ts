import { z } from "zod";
import { accountIdSchema, GatewayError, jobIdSchema, MAX_FILE_BYTES, MAX_FILES } from "../../contracts";
import { MAX_IMAGES } from "../../images";
import type { AdapterContext, JobApproval, RunResult } from "../../contracts";
import { createMuseAdapter } from "./engine";
import { approvalCommandSchema, COMMAND_LIMIT, jsonLines, REQUEST_LIMIT, workerProtocolError } from "./ipc";

const requestSchema = z.object({
  operation: z.enum(["check", "run", "delete", "watch"]),
  site: z.url(),
  chatTimeout: z.number().positive(),
  approvalTimeout: z.number().int().positive().optional(),
  credentials: z.record(z.string(), z.string()),
  accountId: accountIdSchema,
  dataDir: z.string(),
  prompt: z.string(),
  pruneThreads: z.boolean().default(false),
  threadId: z.string().nullable().default(null),
  threads: z.array(z.object({ threadId: z.string(), jobId: jobIdSchema, output: z.string() })).default([]),
  referenceImages: z.array(z.object({
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    dataB64: z.string().min(1),
  })).max(MAX_IMAGES).default([]),
});
const controller = new AbortController();
const abort = () => controller.abort();
process.on("SIGTERM", abort);
function emit(value: object): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
const inputLines = jsonLines(process.stdin, REQUEST_LIMIT, COMMAND_LIMIT, true);
let approval: { readonly id: string; readonly choose: (choiceId: string) => Promise<boolean> } | undefined;
function publishApproval(threadId: string | null, prompt: JobApproval, choose: (choiceId: string) => Promise<boolean>) {
  const active = { id: prompt.id, choose };
  approval = active;
  emit({ type: "approval", threadId, prompt });
  return () => {
    if (approval !== active) return;
    approval = undefined;
    emit({ type: "approval_withdrawn", promptId: active.id });
  };
}

async function emitResult(result: RunResult, event: { readonly type: "completed" } | { readonly type: "watch_result"; readonly threadId: string }): Promise<void> {
  let sent = 0;
  for (const file of result.files ?? []) {
    if (sent >= MAX_FILES) break;
    if (file.data.byteLength > MAX_FILE_BYTES) continue;
    // Send separate events to keep base64 for multiple attachments out of a single JSON record.
    const line = JSON.stringify({
      type: "file", name: file.name, mime: file.mime,
      dataB64: Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength).toString("base64"),
    });
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolve()));
    sent++;
  }
  const omitted = (result.files?.length ?? 0) - sent;
  emit({
    ...event,
    text: omitted ? `${result.text}\n\n[dots2api] ${omitted} file(s) exceeded the attachment size or count limit.` : result.text,
    remoteId: result.remoteId,
    pendingTask: result.pendingTask,
    deliveryId: result.deliveryId,
    followupKeys: result.followupKeys,
    images: (result.images ?? []).map((image) => ({
      mime: image.mime,
      dataB64: Buffer.from(image.data).toString("base64"),
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
      ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
    })),
  });
}
async function commands(): Promise<void> {
  try {
    for await (const line of inputLines) {
      const { promptId, choiceId } = approvalCommandSchema.parse(JSON.parse(line));
      const clicked = approval?.id === promptId ? await approval.choose(choiceId) : false;
      emit({ type: "approval_result", promptId, choiceId, clicked });
    }
  } catch {
    controller.abort(workerProtocolError());
  }
}
try {
  const line = await inputLines.next();
  if (line.done) throw workerProtocolError();
  const input = requestSchema.parse(JSON.parse(line.value));
  const adapter = createMuseAdapter(input.site, input.chatTimeout, input.pruneThreads, input.approvalTimeout);
  // Reading begins after the request frame, not after EOF; the gateway keeps stdin open during a run.
  if (input.operation === "run" || input.operation === "watch") void commands();
  const context = {
    accountId: input.accountId, dataDir: input.dataDir, signal: controller.signal, threadId: input.threadId,
    referenceImages: input.referenceImages.map((image) => ({ mime: image.mime, data: new Uint8Array(Buffer.from(image.dataB64, "base64")) })),
    onAccepted: (remoteId: string | null) => emit({ type: "accepted", remoteId }),
    onSubmitted: () => emit({ type: "submitted" }),
    onApproval: (prompt: JobApproval, choose: (choiceId: string) => Promise<boolean>) => publishApproval(null, prompt, choose),
    saveCredentials: (credentials: Record<string, string>) => emit({ type: "credentials", credentials }),
  };
  switch (input.operation) {
    case "check":
      emit({ type: "checked", ...await adapter.check(input.credentials, context) });
      break;
    case "delete": {
      if (!input.threadId || !adapter.deleteThread) throw new GatewayError("muse_worker", "Muse delete needs a thread id.", 400);
      emit({ type: "deleted", outcome: await adapter.deleteThread(input.credentials, input.threadId, context) });
      break;
    }
    case "run":
      await emitResult(await adapter.run(input.credentials, input.prompt, context), { type: "completed" });
      break;
    case "watch": {
      let pending = Promise.resolve();
      if (!adapter.watch) throw workerProtocolError();
      await adapter.watch(input.credentials, {
        ...context, threads: input.threads,
        onWatchApproval: publishApproval,
        onWatchResult: (threadId, result) => {
          pending = pending.then(() => emitResult(result, { type: "watch_result", threadId }));
          void pending.catch(abort);
        },
      });
      await pending;
      emit({ type: "watched" });
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
} finally {
  process.stdin.destroy();
  process.off("SIGTERM", abort);
}
