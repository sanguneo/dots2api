import ky from "ky";
import { z } from "zod";
import { ClientError } from "./config";
import type { Connection } from "./config";

export async function request(connection: Connection, path: string, body?: string | FormData): Promise<unknown> {
  const response = await ky(connection.baseUrl + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${connection.apiKey}`,
      ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
    },
    ...(body === undefined ? {} : { body }),
    timeout: 330_000, retry: 0, throwHttpErrors: false, redirect: "error",
  });
  if (!response.ok) {
    throw new ClientError(`Gateway HTTP ${response.status}. The request was not retried; inspect the server job history before resubmitting.`);
  }
  return response.json<unknown>();
}

export async function jobImage(connection: Connection, source: string): Promise<Uint8Array> {
  const url = new URL(source, connection.baseUrl + "/");
  const root = new URL(connection.baseUrl);
  if (url.origin !== root.origin || !/^\/api\/jobs\/[A-Za-z0-9-]+\/images\/\d+$/.test(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new ClientError("Refusing a non-gateway image URL; the API key was not sent.");
  }
  const response = await ky(url, {
    headers: { authorization: `Bearer ${connection.apiKey}` },
    timeout: 30_000, retry: 0, redirect: "error", throwHttpErrors: false,
  });
  if (!response.ok) throw new ClientError(`Image download HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

export const chatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});
export const imageResponse = z.object({
  data: z.array(z.object({
    b64_json: z.string().optional(), url: z.string().optional(), revised_prompt: z.string().optional(),
  })).min(1),
});
