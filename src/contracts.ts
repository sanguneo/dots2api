import { z } from "zod";

export const providerIdSchema = z.enum(["dots", "muse"]);
export type ProviderId = z.infer<typeof providerIdSchema>;
export const accountIdSchema = z.string().uuid().brand<"AccountId">();
export type AccountId = z.infer<typeof accountIdSchema>;
export const jobIdSchema = z.string().uuid().brand<"JobId">();
export type JobId = z.infer<typeof jobIdSchema>;
export type Credentials = Readonly<Record<string, string>>;
export type AccountStatus = "unconnected" | "ready" | "error";
export const jobStatusSchema = z.enum(["queued", "running", "approval_required", "completed", "failed", "unknown"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;
export const approvalChoiceIdSchema = z.string().min(1).max(80);
export const approvalPromptIdSchema = z.string().min(1).max(80);
export const jobApprovalSchema = z.object({
  id: approvalPromptIdSchema,
  description: z.string().min(1).max(500),
  choices: z.array(z.object({ id: approvalChoiceIdSchema, label: z.string().min(1).max(120) }).readonly()).min(1).max(8).readonly(),
  expiresAt: z.iso.datetime(),
}).readonly();
export type JobApproval = z.infer<typeof jobApprovalSchema>;
/** Aggregate time allowed for human decisions in one Muse job. */
export const MUSE_APPROVAL_TIMEOUT_MS = 600_000;

export interface Account {
  readonly id: AccountId;
  readonly provider: ProviderId;
  readonly label: string;
  readonly enabled: boolean;
  /** Keep one conversation thread across jobs. Off: every job runs on a fresh thread of its own. */
  readonly keepContext: boolean;
  readonly status: AccountStatus;
  readonly detail: string;
  readonly createdAt: string;
  readonly checkedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly hasCredentials: boolean;
  readonly busy: boolean;
}
/** A raster image produced by a remote agent and stored locally; fetched by index from the job. */
export interface JobImage {
  readonly mime: "image/png" | "image/jpeg" | "image/webp";
  readonly bytes: number;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** The prompt the remote agent actually used, when it reports one. */
  readonly revisedPrompt?: string | undefined;
}
export interface RunImage {
  readonly mime: JobImage["mime"];
  readonly data: Uint8Array;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly revisedPrompt?: string;
}
export const MAX_FILES = 3;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Metadata only; the file body is fetched separately by job and index. */
export interface JobFile {
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
}
export interface RunFile {
  readonly name: string;
  readonly mime: string;
  readonly data: Uint8Array;
}
/** Validated reference bytes supplied by the caller, separate from prompt text and generated images. */
export interface ReferenceImage {
  readonly mime: JobImage["mime"];
  readonly data: Uint8Array;
}
export interface Job {
  readonly id: JobId;
  readonly accountId: AccountId;
  readonly provider: ProviderId;
  readonly prompt: string;
  readonly status: JobStatus;
  readonly output: string;
  readonly error: string | null;
  readonly errorCode?: string | undefined;
  readonly approval?: JobApproval | undefined;
  readonly followup?: {
    readonly originJobId: JobId | null;
    readonly deliveredAt: string | null;
    readonly deliveryId?: string | undefined;
    readonly contentHash?: string | undefined;
  } | undefined;
  readonly pendingTask?: boolean | undefined;
  readonly remoteId: string | null;
  readonly images: readonly JobImage[];
  readonly files?: readonly JobFile[];
  readonly createdAt: string;
  readonly finishedAt: string | null;
}
export interface CredentialField {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly multiline?: boolean;
}
export interface ProviderInfo {
  readonly id: ProviderId;
  readonly name: string;
  readonly description: string;
  readonly contextWindow: number;
  readonly contextBasis: "configured" | "measured-heuristic";
  readonly fields: readonly CredentialField[];
  readonly capabilities: {
    readonly nativeTools: false;
    readonly usage: "unknown";
    readonly execution: "remote-agent";
    /** Whether this provider serves a `{id}-agent` chat model through /v1/chat/completions. */
    readonly chat: boolean;
  };
  readonly setupUrl: string;
}
/** A provider plus its operator switch: a disabled provider accepts no new jobs. */
export interface ProviderStatus extends ProviderInfo {
  readonly enabled: boolean;
}
export interface CheckResult {
  readonly detail: string;
}
export interface RunResult {
  readonly text: string;
  readonly remoteId: string | null;
  readonly images?: readonly RunImage[];
  readonly files?: readonly RunFile[];
  readonly pendingTask?: boolean;
  readonly deliveryId?: string;
  readonly followupKeys?: readonly string[];
}
export interface AdapterContext {
  readonly accountId: AccountId;
  /** False when every job must run on its own fresh thread; absent reads as "keep one thread". */
  readonly keepContext?: boolean;
  readonly dataDir: string;
  readonly signal: AbortSignal;
  readonly referenceImages?: readonly ReferenceImage[];
  /** Muse: reopen this existing side chat instead of starting a new one. Absent reads as "start a new thread". */
  readonly threadId?: string | null;
  /** Muse: delete the side chat this job just finished (a keyless chat request). Adds to the account's keepContext switch. */
  readonly pruneAfter?: boolean;
  /** False for keyed side chats: possibly submitted work must not be replayed, even before acceptance is confirmed. */
  readonly retryAccepted?: boolean;
  /** Muse marks submission immediately before Send: a click can reach the provider even if acknowledgement fails. */
  readonly onSubmitted?: () => void;
  readonly onAccepted?: (remoteId: string | null) => void;
  /** Advertise a live prompt; the returned callback withdraws it if the prompt ends without a click. */
  readonly onApproval?: (approval: JobApproval, choose: (choiceId: string) => Promise<boolean>) => () => void;
  /** Present when the caller can persist credentials an adapter repaired (for example a rebound thread). */
  readonly saveCredentials?: (credentials: Credentials) => void;
}
export interface MuseWatchThread {
  readonly threadId: string;
  readonly jobId: JobId;
  readonly output: string;
}
export interface MuseWatchContext extends AdapterContext {
  readonly threads: readonly MuseWatchThread[];
  readonly onWatchApproval: (threadId: string | null, approval: JobApproval, choose: (choiceId: string) => Promise<boolean>) => () => void;
  readonly onWatchResult: (threadId: string, result: RunResult) => void;
}
/** "gone": the side chat no longer exists remotely. "failed": nothing is known to have been deleted; try again later. */
export type ThreadDeletion = "deleted" | "gone" | "failed";
export interface ProviderAdapter {
  readonly info: ProviderInfo;
  /** Parse account configuration. Secrets are never returned by API reads. */
  validate(credentials: Credentials): Credentials;
  check(credentials: Credentials, context: AdapterContext): Promise<CheckResult>;
  /** Never retry an accepted remote submission blindly. Timeout must be reported as uncertain. */
  run(credentials: Credentials, prompt: string, context: AdapterContext): Promise<RunResult>;
  /** Observe remote work while the account is idle; cancellation releases its single browser before another operation. */
  watch?(credentials: Credentials, context: MuseWatchContext): Promise<void>;
  /**
   * Optional automatic recovery, used after an uncertain failure. It re-establishes the remote session - the step a
   * human performs by pressing Check - and must never submit work or touch an in-flight remote job. Declaring it lets
   * a transient session problem heal without locking the account; an adapter without it keeps the plain quarantine.
   */
  reconnect?(credentials: Credentials, context: AdapterContext): Promise<CheckResult>;
  /** Optional: delete one side chat this gateway opened. Must only ever touch that single thread. */
  deleteThread?(credentials: Credentials, threadId: string, context: AdapterContext): Promise<ThreadDeletion>;
}
export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function jobResultError(job: Job): GatewayError {
  const message = job.error ?? "Remote result is not confirmed.";
  return job.errorCode === "approval_timeout"
    ? new GatewayError("approval_timeout", message, 504)
    : new GatewayError("upstream_unconfirmed", message, 502, job.status === "unknown");
}
