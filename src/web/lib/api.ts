import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";
import { accountIdSchema, jobIdSchema, providerIdSchema } from "../../contracts";
import type { Account, AccountId, CredentialField, Job, JobId, ProviderId, ProviderStatus } from "../../contracts";

const credentialFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  help: z.string(),
  secret: z.boolean(),
  required: z.boolean(),
  multiline: z.boolean().exactOptional(),
}) satisfies z.ZodType<CredentialField>;

const providerSchema = z.object({
  id: providerIdSchema,
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().int().positive(),
  contextBasis: z.enum(["configured", "measured-heuristic"]),
  fields: z.array(credentialFieldSchema),
  capabilities: z.object({
    nativeTools: z.literal(false),
    usage: z.literal("unknown"),
    execution: z.literal("remote-agent"),
    chat: z.boolean(),
  }),
  setupUrl: z.string(),
  enabled: z.boolean(),
}) satisfies z.ZodType<ProviderStatus>;

const accountSchema = z.object({
  id: accountIdSchema,
  provider: providerIdSchema,
  label: z.string(),
  enabled: z.boolean(),
  keepContext: z.boolean(),
  status: z.enum(["unconnected", "ready", "error"]),
  detail: z.string(),
  createdAt: z.string(),
  checkedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  hasCredentials: z.boolean(),
  busy: z.boolean(),
}) satisfies z.ZodType<Account>;

const jobSchema = z.object({
  id: jobIdSchema,
  accountId: accountIdSchema,
  provider: providerIdSchema,
  prompt: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "unknown"]),
  output: z.string(),
  error: z.string().nullable(),
  remoteId: z.string().nullable(),
  images: z.array(z.object({
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]), bytes: z.number(),
    width: z.number().optional(), height: z.number().optional(), revisedPrompt: z.string().optional(),
  })),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
}) satisfies z.ZodType<Job>;

const settingsSchema = z.object({ apiKey: z.string().min(1), baseUrl: z.string().min(1) });

export type Settings = z.infer<typeof settingsSchema>;

export interface AccountInput {
  readonly provider: ProviderId;
  readonly label: string;
  readonly credentials: Readonly<Record<string, string>>;
}

/** Omitted keys are left unchanged by the server; blank credential fields must be omitted, never sent. */
export interface AccountPatch {
  readonly label?: string;
  readonly enabled?: boolean;
  readonly keepContext?: boolean;
  readonly credentials?: Readonly<Record<string, string>>;
}

export type JobTarget = { readonly accountId: AccountId } | { readonly provider: ProviderId };

export type ApiErrorKind = "http" | "network" | "timeout" | "contract" | "unexpected";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;

  constructor(kind: ApiErrorKind, message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

// The error body is not part of src/contracts.ts; the gateway sends `{ error: { message, code, fields? } }`.
// Gateway codes get Korean copy; adapter-authored messages pass through as written.
const errorBodySchema = z.object({
  error: z.object({ message: z.string().min(1), code: z.string().optional(), fields: z.array(z.string()).optional() }),
});

const SESSION_MESSAGE = "관리 API는 서버와 같은 주소(127.0.0.1 또는 localhost)에서 연 브라우저의 요청만 허용합니다. 서버가 시작할 때 출력한 주소로 콘솔을 직접 여세요.";

const codeMessages: Readonly<Record<string, string>> = {
  dots_auth_expired: "기기 인증 또는 토큰이 만료됐습니다. 로그인을 다시 시작하세요.",
  dots_auth_revoked: "인증이 철회됐습니다. 기기 인증으로 다시 로그인하세요.",
  dots_auth_refresh_uncertain: "토큰 갱신 결과를 확인하지 못했습니다. 중복 갱신하지 않고 재로그인이 필요합니다.",
  unsupported_login: "이 공급자에서는 해당 로그인 방식을 사용할 수 없습니다.",
  unauthorized: SESSION_MESSAGE,
  invalid_host: SESSION_MESSAGE,
  invalid_origin: SESSION_MESSAGE,
  invalid_request: "입력값이 올바르지 않습니다.",
  invalid_json: "요청 본문을 해석하지 못했습니다.",
  account_busy: "계정이 다른 작업이나 연결 확인을 진행 중입니다. 끝난 뒤 다시 시도하세요.",
  queue_full: "이 계정의 대기 작업이 가득 찼습니다. 앞선 작업이 끝난 뒤 다시 시도하세요.",
  account_not_found: "계정을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.",
  job_not_found: "작업을 찾을 수 없습니다.",
  no_account: "이 공급자에 지금 쓸 수 있는 계정이 없습니다. 활성 상태이고 연결 확인을 마친 유휴 계정이 필요합니다.",
  account_not_ready: "계정을 활성화하고 연결 확인을 마친 뒤 작업을 보내세요.",
  provider_mismatch: "계정과 공급자가 일치하지 않습니다.",
  internal_error: "서버 내부 오류가 발생했습니다.",
};

function describeErrorBody(body: unknown): { readonly message: string; readonly code: string | null } | null {
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) return null;
  const { message, code, fields } = parsed.data.error;
  const text = (code && codeMessages[code]) || message;
  return { message: fields && fields.length > 0 ? `${text} (${fields.join(", ")})` : text, code: code ?? null };
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return SESSION_MESSAGE;
  if (status === 404) return "요청한 항목을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.";
  if (status === 409) return "계정이 다른 작업에 사용 중이라 지금은 처리할 수 없습니다.";
  if (status >= 500) return `서버 오류가 발생했습니다 (HTTP ${status}).`;
  return `요청이 거부되었습니다 (HTTP ${status}).`;
}

export async function toApiError(error: unknown): Promise<ApiError> {
  if (error instanceof ApiError) return error;
  if (error instanceof HTTPError) {
    const { status } = error.response;
    let body: unknown;
    try {
      body = await error.response.json();
    } catch {
      body = null; // Not JSON (empty 502, proxy page): the status-based message below applies.
    }
    const described = describeErrorBody(body);
    return new ApiError("http", described?.message ?? statusMessage(status), status, described?.code ?? null);
  }
  if (error instanceof TimeoutError) {
    return new ApiError("timeout", "서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요.");
  }
  if (error instanceof TypeError) {
    return new ApiError("network", "서버에 연결할 수 없습니다. dots2api 서버가 실행 중인지 확인하세요.");
  }
  console.error(error);
  return new ApiError("unexpected", error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.");
}

// Same-origin management API: the browser supplies Sec-Fetch-Site. Reads may retry
// once; every mutation passes `retry: 0` so an accepted request is never submitted twice.
const http = ky.create({
  prefixUrl: "/api",
  timeout: 30_000,
  retry: { limit: 1, methods: ["get"] },
  headers: { accept: "application/json" },
});

async function read<S extends z.ZodType>(schema: S, request: () => Promise<unknown>, endpoint: string): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await request();
  } catch (error) {
    throw await toApiError(error);
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : "본문";
  throw new ApiError("contract", `서버 응답이 API 계약과 다릅니다 (${endpoint} · ${path}).`);
}

const accountPath = (id: AccountId): string => `accounts/${encodeURIComponent(id)}`;

export async function listProviders(): Promise<readonly ProviderStatus[]> {
  const body = await read(z.object({ providers: z.array(providerSchema) }), () => http.get("providers").json(), "GET /api/providers");
  return body.providers;
}

/** The operator's per-provider switch; a disabled provider accepts no new jobs. */
export async function setProviderEnabled(id: ProviderId, enabled: boolean): Promise<ProviderStatus> {
  const body = await read(
    z.object({ provider: providerSchema }),
    () => http.patch(`providers/${encodeURIComponent(id)}`, { json: { enabled }, retry: 0 }).json(),
    "PATCH /api/providers/:id",
  );
  return body.provider;
}

export async function listAccounts(): Promise<readonly Account[]> {
  const body = await read(z.object({ accounts: z.array(accountSchema) }), () => http.get("accounts").json(), "GET /api/accounts");
  return body.accounts;
}

export async function createAccount(input: AccountInput): Promise<Account> {
  const body = await read(
    z.object({ account: accountSchema }),
    () => http.post("accounts", { json: input, retry: 0 }).json(),
    "POST /api/accounts",
  );
  return body.account;
}

export async function updateAccount(id: AccountId, patch: AccountPatch): Promise<Account> {
  const body = await read(
    z.object({ account: accountSchema }),
    () => http.patch(accountPath(id), { json: patch, retry: 0 }).json(),
    "PATCH /api/accounts/:id",
  );
  return body.account;
}

export async function deleteAccount(id: AccountId): Promise<void> {
  await read(z.object({ ok: z.literal(true) }), () => http.delete(accountPath(id), { retry: 0 }).json(), "DELETE /api/accounts/:id");
}

/** Observed connection check. No client timeout: a provider may hold it open for an interactive login. */
export async function checkAccount(id: AccountId): Promise<Account> {
  const body = await read(
    z.object({ account: accountSchema }),
    () => http.post(`${accountPath(id)}/check`, { retry: 0, timeout: false }).json(),
    "POST /api/accounts/:id/check",
  );
  return body.account;
}

export async function listJobs(): Promise<readonly Job[]> {
  const body = await read(z.object({ jobs: z.array(jobSchema) }), () => http.get("jobs").json(), "GET /api/jobs");
  return body.jobs;
}

export async function createJob(target: JobTarget, prompt: string): Promise<Job> {
  const body = await read(
    z.object({ job: jobSchema }),
    () => http.post("jobs", { json: { ...target, prompt }, retry: 0 }).json(),
    "POST /api/jobs",
  );
  return body.job;
}

export async function getJob(id: JobId): Promise<Job> {
  const body = await read(z.object({ job: jobSchema }), () => http.get(`jobs/${encodeURIComponent(id)}`).json(), "GET /api/jobs/:id");
  return body.job;
}

export async function getSettings(): Promise<Settings> {
  return read(settingsSchema, () => http.get("settings").json(), "GET /api/settings");
}

const chatModelSchema = z.object({
  id: z.string(),
  context_window: z.number().int().positive(),
  context_basis: z.enum(["configured", "measured-heuristic"]),
});
const imageModelSchema = z.object({ id: z.string(), capabilities: z.object({ images: z.literal(true) }) });
const modelSchema = z.union([chatModelSchema, imageModelSchema]);
export type ModelInfo = z.infer<typeof chatModelSchema>;

export async function listModels(apiKey: string): Promise<readonly ModelInfo[]> {
  const body = await read(
    z.object({ data: z.array(modelSchema) }),
    () => ky.get("/v1/models", { headers: { accept: "application/json", authorization: `Bearer ${apiKey}` }, retry: 0 }).json(),
    "GET /v1/models",
  );
  return body.data.filter((model): model is ModelInfo => "context_window" in model);
}

const dotsDeviceSchema = z.object({
  verificationUrl: z.url(), userCode: z.string(), expiresAt: z.number(), pollIntervalMs: z.number(),
});
export type DotsDevice = z.infer<typeof dotsDeviceSchema>;

export async function startDotsLogin(id: AccountId): Promise<DotsDevice> {
  return read(dotsDeviceSchema, () => http.post(`${accountPath(id)}/dots-login/start`, { retry: 0 }).json(), "Dots login start");
}
export async function completeDotsLogin(id: AccountId, threadId: string) {
  return read(z.discriminatedUnion("status", [
    z.object({ status: z.literal("pending"), retryAfterMs: z.number() }),
    z.object({ status: z.literal("connected"), account: accountSchema }),
  ]), () => http.post(`${accountPath(id)}/dots-login/complete`, {
    json: { threadId }, retry: 0, timeout: false,
  }).json(), "Dots login complete");
}
export async function cancelDotsLogin(id: AccountId): Promise<void> {
  await read(z.object({ ok: z.literal(true) }),
    () => http.post(`${accountPath(id)}/dots-login/cancel`, { retry: 0 }).json(), "Dots login cancel");
}

const museSessionSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string(),
  state: z.enum(["starting", "active", "completing", "completed", "cancelled", "expired", "failed"]),
  expiresAt: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type MuseSession = z.infer<typeof museSessionSchema>;

/** The remote browser login for Muse; the viewer streams over a WebSocket at the `stream` path. */
export async function getMuseLogin(id: AccountId): Promise<MuseSession | null> {
  const body = await read(z.object({ session: museSessionSchema.nullable() }),
    () => http.get(`${accountPath(id)}/muse-login`).json(), "GET Muse login");
  return body.session;
}
export async function startMuseLogin(id: AccountId): Promise<MuseSession> {
  const body = await read(z.object({ session: museSessionSchema }),
    () => http.post(`${accountPath(id)}/muse-login/start`, { retry: 0, timeout: false }).json(), "Muse login start");
  return body.session;
}
export async function completeMuseLogin(id: AccountId, sessionId: string): Promise<Account> {
  const body = await read(z.object({ status: z.literal("connected"), account: accountSchema }),
    () => http.post(`${accountPath(id)}/muse-login/complete`, { json: { sessionId }, retry: 0, timeout: false }).json(), "Muse login complete");
  return body.account;
}
export async function cancelMuseLogin(id: AccountId, sessionId: string): Promise<void> {
  await read(z.object({ session: museSessionSchema }),
    () => http.post(`${accountPath(id)}/muse-login/cancel`, { json: { sessionId }, retry: 0 }).json(), "Muse login cancel");
}
