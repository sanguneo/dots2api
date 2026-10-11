import { z } from "zod";

export const providerIdSchema = z.enum(["dots", "muse"]);
export type ProviderId = z.infer<typeof providerIdSchema>;
export const accountIdSchema = z.string().uuid().brand<"AccountId">();
export type AccountId = z.infer<typeof accountIdSchema>;
export const jobIdSchema = z.string().uuid().brand<"JobId">();
export type JobId = z.infer<typeof jobIdSchema>;
export type Credentials = Readonly<Record<string, string>>;
export type AccountStatus = "unconnected" | "ready" | "error";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "unknown";

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
  readonly remoteId: string | null;
  readonly images: readonly JobImage[];
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
}
export interface AdapterContext {
  readonly accountId: AccountId;
  /** False when every job must run on its own fresh thread; absent reads as "keep one thread". */
  readonly keepContext?: boolean;
  readonly dataDir: string;
  readonly signal: AbortSignal;
  readonly referenceImages?: readonly ReferenceImage[];
  readonly onAccepted?: (remoteId: string | null) => void;
  /** Present when the caller can persist credentials an adapter repaired (for example a rebound thread). */
  readonly saveCredentials?: (credentials: Credentials) => void;
}
export interface ProviderAdapter {
  readonly info: ProviderInfo;
  /** Parse account configuration. Secrets are never returned by API reads. */
  validate(credentials: Credentials): Credentials;
  check(credentials: Credentials, context: AdapterContext): Promise<CheckResult>;
  /** Never retry an accepted remote submission blindly. Timeout must be reported as uncertain. */
  run(credentials: Credentials, prompt: string, context: AdapterContext): Promise<RunResult>;
  /**
   * Optional automatic recovery, used after an uncertain failure. It re-establishes the remote session - the step a
   * human performs by pressing Check - and must never submit work or touch an in-flight remote job. Declaring it lets
   * a transient session problem heal without locking the account; an adapter without it keeps the plain quarantine.
   */
  reconnect?(credentials: Credentials, context: AdapterContext): Promise<CheckResult>;
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
