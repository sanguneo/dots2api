import { z } from "zod";
import { accountIdSchema, GatewayError } from "../../src/contracts";
import { createMuseAdapter } from "../../src/providers/muse";

const input = z.object({ site: z.url(), dataDir: z.string(), retryAccepted: z.boolean().optional() }).parse(await Bun.stdin.json());
const accepted: (string | null)[] = [];
let submitted = 0;
const context = {
  accountId: accountIdSchema.parse(crypto.randomUUID()), dataDir: input.dataDir, signal: new AbortController().signal,
  ...(input.retryAccepted === undefined ? {} : { retryAccepted: input.retryAccepted }),
  onAccepted: (id: string | null) => { accepted.push(id); },
  onSubmitted: () => { submitted++; },
};
const failure = await createMuseAdapter(input.site, 1_000).run({ cookieHeader: "hatch_sess=fake" }, "brief", context)
  .then(() => null, (error: unknown) => {
    if (!(error instanceof GatewayError)) throw error;
    return { code: error.code, uncertain: error.uncertain };
  });
console.log(JSON.stringify({ failure, accepted, submitted }));
