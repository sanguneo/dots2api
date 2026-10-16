import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { GatewayError } from "./contracts";
import type { Job, ProviderId, ReferenceImage } from "./contracts";
import type { Gateway } from "./gateway";
import { buildImagePrompt } from "./image-prompt";
import { MAX_IMAGE_BYTES, MAX_IMAGES, sniffImage, validateReferenceImages } from "./images";

const MAX_N = 4;
/** Image models this gateway serves and the provider account each one runs on. */
export const IMAGE_MODELS = { "dots-image": "dots", "muse-image": "muse" } as const satisfies Readonly<Record<string, ProviderId>>;
export type ImageModelId = keyof typeof IMAGE_MODELS;
export const IMAGE_MODEL: ImageModelId = "dots-image";

const request = z.strictObject({
  model: z.string().optional(),
  prompt: z.string().trim().min(1).max(32_000),
  n: z.number().int().min(1).max(MAX_N).default(1),
  size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).default("auto"),
  quality: z.enum(["auto", "low", "medium", "high"]).default("auto"),
  response_format: z.enum(["b64_json", "url"]).default("b64_json"),
  output_format: z.literal("png").optional(),
  background: z.enum(["auto", "opaque"]).optional(),
  moderation: z.literal("auto").optional(),
  user: z.string().optional(),
});

/** Resolve the requested model to a provider; an omitted model uses the default image model. */
function imageProvider(model: string | undefined): ProviderId {
  if (model === undefined || model.startsWith("gpt-image")) return IMAGE_MODELS[IMAGE_MODEL];
  if (Object.hasOwn(IMAGE_MODELS, model)) return IMAGE_MODELS[model as ImageModelId];
  throw new GatewayError("unsupported_parameter", `Model ${model} is not available; use ${Object.keys(IMAGE_MODELS).join(" or ")}.`, 422);
}

/** One generated image per job: each is a separate provider turn, run one after another on that account's single thread. */
export function attachImageGeneration(app: Hono, gateway: Gateway): void {
  app.use("/v1/images/edits", bodyLimit({
    maxSize: MAX_IMAGE_BYTES + 1024 * 1024,
    onError: () => { throw new GatewayError("image_too_large", "Multipart image request exceeds the 33 MiB body limit.", 413); },
  }));
  app.post("/v1/images/:operation", async (c) => {
    const operation = c.req.param("operation");
    if (operation !== "generations" && operation !== "edits") return c.notFound();
    let referenceImages: ReferenceImage[] | undefined;
    let input: unknown;
    if (operation === "edits") {
      if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
        throw new GatewayError("invalid_request", "Image edits require multipart/form-data.");
      }
      let form: FormData;
      try { form = await c.req.raw.formData(); }
      catch { throw new GatewayError("invalid_request", "Invalid multipart image request."); }
      const fields: Record<string, unknown> = {};
      const files: File[] = [];
      for (const [name, value] of form) {
        if (name === "image" || name === "image[]") {
          if (typeof value === "string") throw new GatewayError("invalid_image", "Images must be uploaded binary files, not URLs or strings.");
          files.push(value);
        } else {
          if (typeof value !== "string" || Object.hasOwn(fields, name)) {
            throw new GatewayError("invalid_request", "Options must be single text fields.");
          }
          fields[name] = name === "n" ? Number(value) : value;
        }
      }
      if (files.length === 0 || files.length > MAX_IMAGES) {
        throw new GatewayError("invalid_image", `Supply between 1 and ${MAX_IMAGES} reference images.`);
      }
      if (files.some((file) => file.size === 0) || files.reduce((sum, file) => sum + file.size, 0) > MAX_IMAGE_BYTES) {
        throw new GatewayError("image_too_large", "Reference images must be nonempty and total at most 32 MiB.", 413);
      }
      referenceImages = [];
      for (const file of files) {
        const data = new Uint8Array(await file.arrayBuffer());
        const mime = sniffImage(data);
        if (!mime) throw new GatewayError("invalid_image", "Reference images must contain PNG, JPEG or WebP bytes.");
        referenceImages.push({ mime, data });
      }
      validateReferenceImages(referenceImages);
      input = fields;
    } else input = await c.req.json();
    const body = request.parse(input);
    if (body.output_format !== undefined) {
      throw new GatewayError("unsupported_parameter", "Explicit output_format is not supported; the provider determines the image encoding.", 422);
    }
    const provider = imageProvider(body.model);
    const origin = new URL(c.req.url).origin;
    const prompt = buildImagePrompt({ prompt: body.prompt, size: body.size, quality: body.quality });
    const data: Array<Record<string, string>> = [];
    const jobIds: string[] = [];
    let first: { width?: number | undefined; height?: number | undefined; format?: "png" | "jpeg" | "webp" } = {};
    let failure: GatewayError | undefined;
    for (let index = 0; index < body.n; index++) {
      let job: Job;
      try {
        job = gateway.submit({ provider, prompt, ...(referenceImages ? { referenceImages } : {}) });
      } catch (error) {
        if (!(error instanceof GatewayError) || data.length === 0) throw error;
        failure = error;
        break;
      }
      jobIds.push(job.id);
      const result = await gateway.wait(job.id);
      if (result.status !== "completed") {
        failure = new GatewayError("upstream_unconfirmed", result.error ?? "Remote result is not confirmed.", 502, result.status === "unknown");
        break;
      }
      const image = result.images[0];
      if (!image) {
        const said = result.output.replace(/\s+/g, " ").trim().slice(0, 300);
        failure = new GatewayError("image_not_generated", `The provider did not return an image${said ? `: ${said}` : "."}`, 502);
        break;
      }
      const stored = gateway.store.image(job.id, 0);
      if (!stored) {
        failure = new GatewayError("image_not_generated", "The generated image could not be read back.", 502);
        break;
      }
      if (index === 0) first = {
        width: image.width, height: image.height,
        format: stored.mime === "image/jpeg" ? "jpeg" : stored.mime === "image/webp" ? "webp" : "png",
      };
      data.push({
        ...(body.response_format === "b64_json"
          ? { b64_json: Buffer.from(stored.data).toString("base64") }
          : { url: `${origin}/api/jobs/${job.id}/images/0` }),
        ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
      });
    }
    c.header("X-Dots2api-Job-Id", jobIds.join(","));
    c.header("X-Dots2api-Usage", "unknown");
    if (data.length === 0 && failure) throw failure;
    if (failure) {
      // Images that were already paid for are returned rather than discarded.
      c.header("X-Dots2api-Images-Requested", String(body.n));
      c.header("X-Dots2api-Images-Returned", String(data.length));
    }
    return c.json({
      created: Math.floor(Date.now() / 1000),
      data,
      output_format: first.format ?? "png",
      ...(first.width && first.height ? { size: `${first.width}x${first.height}` } : {}),
    });
  });
}
