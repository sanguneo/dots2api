import { GatewayError } from "./contracts";

/** A caller-chosen topic key: it names a Muse side chat to reuse. OpenAI's `user` field is deliberately not used for this. */
export const THREAD_KEY = /^[A-Za-z0-9._:-]{1,64}$/;
export const THREAD_HEADER = "X-Muse-Thread";

/** The body field wins over the header; an absent or blank-free value is undefined, an invalid one is a 400. */
export function parseThreadKey(field: string | undefined, header: string | undefined): string | undefined {
  const value = field ?? header;
  if (value === undefined) return undefined;
  if (!THREAD_KEY.test(value)) {
    throw new GatewayError("invalid_thread", "thread must be 1-64 characters from A-Z a-z 0-9 . _ : -.", 400);
  }
  return value;
}
