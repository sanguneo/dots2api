import { RefreshCw } from "lucide-react";
import type { Account, AccountStatus, Job, JobStatus } from "../../contracts";
import type { ApiError } from "../lib/api";
import { accountStatusLabel, firstLine, formatDuration, jobDuration, jobStatusLabel, shortId } from "../lib/format";
import { routeHref } from "../lib/router";
import { gateway } from "../lib/store";
import { Button, Elapsed, Notice, StatusBadge, TimeText } from "./ui";
import type { Tone } from "./ui";

const accountTone = { unconnected: "neutral", ready: "ok", error: "danger" } as const satisfies Record<AccountStatus, Tone>;
const jobTone = { queued: "neutral", running: "accent", completed: "ok", failed: "danger", unknown: "warn" } as const satisfies Record<JobStatus, Tone>;

export function AccountStatusBadge({ account, checkStartedAt }: { readonly account: Account; readonly checkStartedAt?: number | undefined }) {
  if (checkStartedAt !== undefined) {
    return (
      <StatusBadge tone="accent" pulse>
        확인 중 <Elapsed since={checkStartedAt} />
      </StatusBadge>
    );
  }
  return <StatusBadge tone={accountTone[account.status]}>{accountStatusLabel[account.status]}</StatusBadge>;
}

export function JobStatusBadge({ status }: { readonly status: JobStatus }) {
  return (
    <StatusBadge tone={jobTone[status]} pulse={status === "running"}>
      {jobStatusLabel[status]}
    </StatusBadge>
  );
}

interface JobRowProps {
  readonly job: Job;
  readonly account: Account | undefined;
  readonly provider: string;
  readonly now: number;
}

export function JobRow({ job, account, provider, now }: JobRowProps) {
  const duration = jobDuration(job);
  return (
    <a className="job-row" href={routeHref({ view: "jobs", jobId: job.id })}>
      <span className="job-row__status">
        <JobStatusBadge status={job.status} />
      </span>
      <span className="job-row__main">
        <span className="job-row__prompt">{firstLine(job.prompt) || "(빈 프롬프트)"}</span>
        <span className="job-row__meta">
          {provider} · {account ? account.label : "삭제된 계정"} · <span className="mono">{shortId(job.id)}</span>
        </span>
      </span>
      <span className="job-row__time">
        <TimeText iso={job.createdAt} now={now} />
      </span>
      <span className="job-row__duration">
        {job.status === "running" ? <Elapsed since={Date.parse(job.createdAt)} /> : duration === null ? "—" : formatDuration(duration)}
      </span>
    </a>
  );
}

export function LoadError({ title, error }: { readonly title: string; readonly error: ApiError }) {
  return (
    <Notice
      tone="danger"
      title={title}
      action={
        <Button size="sm" icon={<RefreshCw aria-hidden="true" />} onClick={() => void gateway.refresh()}>
          다시 시도
        </Button>
      }
    >
      {error.message}
    </Notice>
  );
}
