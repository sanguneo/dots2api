import { useEffect, useState } from "react";
import type { Account, Job, JobId } from "../../contracts";
import { Drawer } from "../components/dialog";
import { AccountStatusBadge, JobStatusBadge } from "../components/domain";
import { CopyButton, Elapsed, Notice, SkeletonRows, TimeText, useNow } from "../components/ui";
import { getJob, toApiError } from "../lib/api";
import type { ApiError } from "../lib/api";
import { formatAbsolute, formatBytes, formatDuration, jobDuration, providerName } from "../lib/format";
import { useGateway } from "../lib/store";

function JobDetail({ job, account, provider }: { readonly job: Job; readonly account: Account | undefined; readonly provider: string }) {
  const duration = jobDuration(job);
  return (
    <div className="detail">
      {job.status === "running" ? (
        <Notice title="원격 에이전트가 작업 중입니다">
          경과 <Elapsed since={Date.parse(job.createdAt)} /> · 완료되면 이 화면이 자동으로 갱신됩니다.
        </Notice>
      ) : null}
      {job.status === "approval_required" && job.approval ? (
        <Notice tone="warn" title="원격 에이전트가 승인을 기다립니다">{job.approval.description}</Notice>
      ) : null}
      {job.status === "queued" ? (
        <Notice title="앞선 작업이 끝나기를 기다립니다">
          같은 계정의 앞선 작업이 끝나면 이어서 실행됩니다. 순서가 되면 이 화면이 자동으로 갱신됩니다.
        </Notice>
      ) : null}
      {job.status === "unknown" ? (
        <Notice tone="warn" title="결과를 확인하지 못했습니다">
          원격 서비스가 요청을 받았을 수 있지만 완료 여부를 확인하지 못했습니다. 같은 작업이 두 번 실행되지 않도록, 다시 보내기 전에 원격 서비스에서
          결과를 직접 확인하세요.
        </Notice>
      ) : null}
      {job.status === "failed" ? (
        <Notice tone="danger" title="작업이 실패했습니다">
          {job.error ?? "실패 사유가 기록되지 않았습니다."}
        </Notice>
      ) : null}
      {job.error && job.status !== "failed" ? (
        <Notice tone={job.status === "unknown" ? "warn" : "danger"} title="오류 메시지">
          {job.error}
        </Notice>
      ) : null}

      <section className="detail__section">
        <div className="detail__head">
          <h3 className="detail__title">결과</h3>
          {job.output ? <CopyButton value={job.output} label="결과 복사" /> : null}
        </div>
        {job.output ? (
          <pre className="output">{job.output}</pre>
        ) : (
          <p className="quiet">{!job.finishedAt ? "아직 결과가 없습니다." : "결과 텍스트가 없습니다."}</p>
        )}
      </section>

      {job.images.length > 0 ? (
        <section className="detail__section" aria-labelledby={`images-${job.id}`}>
          <h3 className="detail__title" id={`images-${job.id}`}>
            이미지 <span className="muted">{job.images.length}</span>
          </h3>
          <ul className="gallery">
            {job.images.map((image, index) => {
              const href = `/api/jobs/${encodeURIComponent(job.id)}/images/${index}`;
              return (
                <li key={index} className="gallery__item">
                  <a href={href} target="_blank" rel="noopener" aria-label={`이미지 ${index + 1} 원본 열기`}>
                    <img className="gallery__img" src={href} alt={`원격 에이전트가 만든 이미지 ${index + 1}`} loading="lazy" />
                  </a>
                  <div className="gallery__meta">
                    <span className="mono">{image.mime.replace("image/", "").toUpperCase()}</span>
                    <span>{formatBytes(image.bytes)}</span>
                    <a className="link" href={href} download>
                      저장
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="detail__section">
        <div className="detail__head">
          <h3 className="detail__title">프롬프트</h3>
          <CopyButton value={job.prompt} label="프롬프트 복사" />
        </div>
        <pre className="output output--prompt">{job.prompt}</pre>
      </section>

      <section className="detail__section">
        <h3 className="detail__title">세부 정보</h3>
        <dl className="facts">
          <div>
            <dt>계정</dt>
            <dd>
              {account ? (
                <span className="facts__inline">
                  <span className="strong">{account.label}</span>
                  <AccountStatusBadge account={account} />
                </span>
              ) : (
                <span className="muted">삭제된 계정</span>
              )}
            </dd>
          </div>
          <div>
            <dt>공급자</dt>
            <dd>{provider}</dd>
          </div>
          <div>
            <dt>계정 ID</dt>
            <dd className="mono">{job.accountId}</dd>
          </div>
          <div>
            <dt>작업 ID</dt>
            <dd className="mono">{job.id}</dd>
          </div>
          <div>
            <dt>원격 ID</dt>
            <dd className="mono">{job.remoteId ?? "—"}</dd>
          </div>
          <div>
            <dt>생성</dt>
            <dd>{formatAbsolute(job.createdAt)}</dd>
          </div>
          <div>
            <dt>완료</dt>
            <dd>{job.finishedAt ? formatAbsolute(job.finishedAt) : "—"}</dd>
          </div>
          <div>
            <dt>소요 시간</dt>
            <dd>{duration === null ? "—" : formatDuration(duration)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

export function JobDrawer({ jobId, onClose }: { readonly jobId: JobId; readonly onClose: () => void }) {
  const { jobs, accounts, providers } = useGateway();
  const now = useNow(30_000);
  const listed = jobs.data?.find((job) => job.id === jobId) ?? null;
  const [fetched, setFetched] = useState<{ readonly job: Job | null; readonly error: ApiError | null }>({ job: null, error: null });

  useEffect(() => {
    if (listed || jobs.data === null) return;
    let cancelled = false;
    getJob(jobId).then(
      (job) => {
        if (!cancelled) setFetched({ job, error: null });
      },
      async (error: unknown) => {
        const failure = await toApiError(error);
        if (!cancelled) setFetched({ job: null, error: failure });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [jobId, listed, jobs.data]);

  const job = listed ?? (fetched.job?.id === jobId ? fetched.job : null);
  const account = job ? accounts.data?.find((item) => item.id === job.accountId) : undefined;

  return (
    <Drawer
      title="작업 상세"
      subtitle={
        job ? (
          <span className="drawer__meta">
            <JobStatusBadge status={job.status} />
            <span>
              생성 <TimeText iso={job.createdAt} now={now} />
            </span>
          </span>
        ) : null
      }
      onClose={onClose}
    >
      {job ? (
        <JobDetail job={job} account={account} provider={providerName(providers.data, job.provider)} />
      ) : fetched.error ? (
        <Notice tone="danger" title="작업을 불러오지 못했습니다">
          {fetched.error.message}
        </Notice>
      ) : (
        <SkeletonRows count={4} />
      )}
    </Drawer>
  );
}
