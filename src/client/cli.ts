import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { sniffImage } from "../images";
import { ClientError, baseUrl, configPath, configure, connect } from "./config";
import { chatResponse, imageResponse, jobImage, request } from "./http";
import { saveChatMedia, saveImage } from "./media";

const help = `dots2api client (Bun required)
  configure --base-url http://127.0.0.1:3010 --key-file /private/api-key.txt
  models
  chat --prompt "Hello" [--model muse-agent|dots-agent] [--session topic] [--save-dir ./answers]
  image --prompt "A red fox" --out ./fox [--model dots-image|muse-image] [--image reference.png ...]
Options: --config PATH, --base-url URL, --key-file PATH, --prompt-file PATH,
         --system TEXT, --size SIZE, --quality QUALITY, --n 1..4.
No requests are retried automatically. A timeout can leave a job running on the server.
Named sessions reuse a Muse conversation; Dots uses its own primary Dot conversation.
`;

export async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv], allowPositionals: true, strict: true,
    options: {
      help: { type: "boolean", short: "h" }, config: { type: "string" },
      "base-url": { type: "string" }, "key-file": { type: "string" },
      prompt: { type: "string" }, "prompt-file": { type: "string" },
      model: { type: "string" }, session: { type: "string" }, system: { type: "string" },
      out: { type: "string" }, "save-dir": { type: "string" },
      image: { type: "string", multiple: true }, size: { type: "string" },
      quality: { type: "string" }, n: { type: "string" },
    },
  });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const command = z.enum(["configure", "models", "chat", "image"]).parse(positionals[0]);
  if (positionals.length !== 1) throw new ClientError("Use --prompt for text; extra positional arguments are not accepted.");
  if (command === "configure") {
    const path = configPath(values.config);
    await configure(path, {
      baseUrl: baseUrl(values["base-url"] ?? "http://127.0.0.1:3010"),
      ...(values["key-file"] ? { apiKeyFile: values["key-file"] } : {}),
    });
    console.log(JSON.stringify({ configured: path, next: "Log in at your server console, set your API key, then run models." }));
    return;
  }
  const connection = await connect({
    ...(values.config ? { config: values.config } : {}),
    ...(values["base-url"] ? { base: values["base-url"] } : {}),
    ...(values["key-file"] ? { keyFile: values["key-file"] } : {}),
  });
  if (command === "models") {
    const result = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await request(connection, "/v1/models"));
    console.log(JSON.stringify(result.data.map((model) => model.id)));
    return;
  }
  if (values.prompt && values["prompt-file"]) throw new ClientError("Choose --prompt or --prompt-file, not both.");
  const prompt = z.string().trim().min(1).parse(values["prompt-file"] ? await readFile(values["prompt-file"], "utf8") : values.prompt);
  const thread = values.session === undefined ? undefined : z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/).parse(values.session);
  switch (command) {
    case "chat": {
      if (values.image?.length) throw new ClientError("Chat does not accept image uploads. Use the image command with --image for reference editing.");
      const model = z.enum(["muse-agent", "dots-agent"]).parse(values.model ?? "muse-agent");
      const messages = [
        ...(values.system ? [{ role: "system", content: values.system }] : []),
        { role: "user", content: prompt },
      ];
      const result = chatResponse.parse(await request(connection, "/v1/chat/completions", JSON.stringify({
        model, messages, ...(thread ? { thread } : {}),
      })));
      const answer = result.choices[0];
      if (!answer) throw new ClientError("The gateway returned no answer.");
      const files = values["save-dir"] ? await saveChatMedia(connection, answer.message.content, values["save-dir"]) : [];
      console.log(JSON.stringify({ model, ...(thread ? { session: thread } : {}), text: answer.message.content, files }));
      break;
    }
    case "image": {
      if (!values.out) throw new ClientError("Image generation requires --out.");
      const body = {
        model: z.enum(["dots-image", "muse-image"]).parse(values.model ?? "dots-image"),
        prompt, n: z.coerce.number().int().min(1).max(4).parse(values.n ?? 1),
        size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).parse(values.size ?? "auto"),
        quality: z.enum(["auto", "low", "medium", "high"]).parse(values.quality ?? "auto"),
        response_format: "b64_json", ...(thread ? { thread } : {}),
      };
      const references = values.image ?? [];
      if (references.length > 8) throw new ClientError("Supply at most eight reference images.");
      let payload: string | FormData = JSON.stringify(body);
      if (references.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(body)) form.set(key, String(value));
        let total = 0;
        for (const path of references) {
          const data = await readFile(path);
          total += data.byteLength;
          if (total > 32 * 1024 * 1024) throw new ClientError("Reference images must total at most 32 MiB.");
          const mime = sniffImage(data);
          if (!mime) throw new ClientError("Reference images must contain PNG, JPEG or WebP bytes.");
          form.append("image[]", new Blob([data], { type: mime }), "reference");
        }
        payload = form;
      }
      const result = imageResponse.parse(await request(connection, references.length ? "/v1/images/edits" : "/v1/images/generations", payload));
      const files: string[] = [];
      for (const [index, item] of result.data.entries()) {
        const bytes = item.b64_json ? Buffer.from(item.b64_json, "base64") : item.url ? await jobImage(connection, item.url) : undefined;
        if (!bytes) throw new ClientError("The gateway returned an image without data.");
        const path = result.data.length === 1 ? values.out : values.out.replace(/(\.[^./\\]+)?$/, `-${index + 1}$1`);
        files.push(await saveImage(path, bytes));
      }
      console.log(JSON.stringify({ model: body.model, requested: body.n, returned: files.length, files }));
      break;
    }
    default: {
      const unreachable: never = command;
      throw new ClientError(`Unsupported command: ${unreachable}`);
    }
  }
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    // Do not echo HTTP bodies, token-bearing URLs, input values or full Zod issues.
    console.error(error instanceof ClientError ? error.message : "Client request failed. Check your arguments, connection and server job history; nothing was retried.");
    process.exitCode = 1;
  }
}
