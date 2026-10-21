import type { Account, AccountStatus, Job, JobStatus, ProviderId, ProviderInfo } from "../../contracts";

export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

export const accountStatusLabel: Readonly<Record<AccountStatus, string>> = {
  unconnected: "미연결",
  ready: "준비됨",
  error: "오류",
};

export const jobStatusLabel: Readonly<Record<JobStatus, string>> = {
  queued: "대기 중",
  running: "실행 중",
  completed: "완료",
  failed: "실패",
  unknown: "결과 불확실",
};

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const absoluteFormat = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const dayFormat = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" });
const relativeFormat = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });

export function formatAbsolute(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : absoluteFormat.format(time);
}

export function formatRelative(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const elapsed = now - time;
  if (elapsed < 45 * SECOND) return "방금";
  if (elapsed < HOUR) return relativeFormat.format(-Math.max(1, Math.floor(elapsed / MINUTE)), "minute");
  if (elapsed < DAY) return relativeFormat.format(-Math.floor(elapsed / HOUR), "hour");
  if (elapsed < 7 * DAY) return relativeFormat.format(-Math.floor(elapsed / DAY), "day");
  return dayFormat.format(time);
}

export function formatDuration(ms: number): string {
  if (ms < SECOND) return "1초 미만";
  const total = Math.round(ms / SECOND);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분 ${seconds}초`;
  return `${seconds}초`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function jobDuration(job: Job): number | null {
  if (!job.finishedAt) return null;
  const started = Date.parse(job.createdAt);
  const finished = Date.parse(job.finishedAt);
  return Number.isNaN(started) || Number.isNaN(finished) ? null : Math.max(0, finished - started);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

export function providerName(providers: readonly ProviderInfo[] | null, id: ProviderId): string {
  return providers?.find((provider) => provider.id === id)?.name ?? id;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export interface AccountCounts {
  total: number;
  enabled: number;
  disabled: number;
  ready: number;
  error: number;
  unconnected: number;
  busy: number;
  /** Mirrors the gateway's job routing rule: enabled, ready and not busy. */
  available: number;
}

export function countAccounts(accounts: readonly Account[]): AccountCounts {
  const counts: AccountCounts = { total: 0, enabled: 0, disabled: 0, ready: 0, error: 0, unconnected: 0, busy: 0, available: 0 };
  for (const account of accounts) {
    counts.total += 1;
    counts[account.status] += 1;
    if (account.enabled) counts.enabled += 1;
    else counts.disabled += 1;
    if (account.busy) counts.busy += 1;
    if (isAvailable(account)) counts.available += 1;
  }
  return counts;
}

export function isAvailable(account: Account): boolean {
  return account.enabled && account.status === "ready" && !account.busy;
}

export function availabilityLabel(account: Account): string {
  if (account.busy) return "작업 중";
  if (!account.enabled) return "비활성";
  return account.status === "ready" ? "작업 가능" : accountStatusLabel[account.status];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

