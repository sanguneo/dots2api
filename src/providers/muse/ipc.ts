import { z } from "zod";
import { approvalChoiceIdSchema, approvalPromptIdSchema, GatewayError, MAX_FILE_BYTES } from "../../contracts";
import { MAX_IMAGE_BYTES, MAX_IMAGES } from "../../images";

export const REQUEST_LIMIT = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32 * 1024 * 1024;
export const COMMAND_LIMIT = 4 * 1024;
// Completion may contain up to one line's worth of image data per image, not per job.
export const EVENT_LIMIT = Math.max(Math.ceil(MAX_FILE_BYTES / 3) * 4, Math.ceil(MAX_IMAGE_BYTES / 3) * 4 * MAX_IMAGES) + 32 * 1024 * 1024;
export const approvalCommandSchema = z.object({
  type: z.literal("choose"),
  promptId: approvalPromptIdSchema,
  choiceId: approvalChoiceIdSchema,
});
export const approvalResultSchema = approvalCommandSchema.omit({ type: true }).extend({
  type: z.literal("approval_result"),
  clicked: z.boolean(),
});
export type ApprovalCommand = z.infer<typeof approvalCommandSchema>;

export function workerProtocolError(): GatewayError {
  return new GatewayError("muse_worker", "Muse worker messages could not be verified.", 502, true);
}

export async function* readStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally { reader.releaseLock(); }
}

/** Frame UTF-8 by byte before decoding, so split code points and oversized lines are both handled. */
export async function* jsonLines(
  chunks: AsyncIterable<Uint8Array>,
  firstLimit: number,
  lineLimit = firstLimit,
  allowFinalLine = false,
): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let size = 0;
  let limit = firstLimit;
  for await (const chunk of chunks) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const piece = bytes.subarray(offset, newline < 0 ? bytes.length : newline);
      size += piece.length;
      if (size > limit) throw workerProtocolError();
      if (piece.length) parts.push(piece);
      if (newline < 0) break;
      if (!size) throw workerProtocolError();
      yield Buffer.concat(parts, size).toString("utf8");
      parts = [];
      size = 0;
      limit = lineLimit;
      offset = newline + 1;
    }
  }
  if (size) {
    if (!allowFinalLine || limit !== firstLimit) throw workerProtocolError();
    yield Buffer.concat(parts, size).toString("utf8");
  }
}
