import { CircleCheck, KeyRound, Plus } from "lucide-react";
import type { Account, ProviderId, ProviderStatus } from "../../contracts";
import { AccountStatusBadge, JobRow, JobStatusBadge, LoadError } from "../components/domain";
import { Button, EmptyState, PageHeader, SectionHead, SkeletonRows, StatusBadge, Switch, useNow } from "../components/ui";
import { runCheck, useConsoleActions } from "../lib/actions";
import { toApiError } from "../lib/api";
import { countAccounts, cx, firstLine, providerName } from "../lib/format";
import { routeHref } from "../lib/router";
import { gateway, useGateway } from "../lib/store";
import { notify } from "../lib/toast";

function ProviderSummary({ provider, accounts, onAdd, onToggle }: { readonly provider: ProviderStatus; readonly accounts: readonly Account[]; readonly onAdd: () => void; readonly onToggle: (enabled: boolean) => void }) {
  const counts = countAccounts(accounts);
  const items: ReadonlyArray<readonly [string, number, boolean]> = [
    ["계정", counts.total, false],
    ["준비됨", counts.ready, false],
    ["오류", counts.error, counts.error > 0],
    ["미연결", counts.unconnected, false],
    ["비활성", counts.disabled, false],
    ["작업 중", counts.busy, false],
  ];
  return (
    <div className="provider-row">
      <div className="provider-row__id">
        <p className="provider-row__name">
          {provider.name}
          {provider.enabled ? null : <StatusBadge tone="neutral">꺼짐</StatusBadge>}
        </p>
        <p className="provider-row__desc">{provider.description}</p>
      </div>
      <dl className="counts">
        {items.map(([label, value, alert]) => (
          <div key={label} className={cx("count", value === 0 && "count--zero", alert && "count--danger")}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="provider-row__action">
        <div className="provider-row__switch">
          <Switch
            checked={provider.enabled}
            label={`${provider.name} 공급자 사용`}
            title={provider.enabled ? `${provider.name} 공급자를 끄면 새 작업이 이 공급자로 가지 않습니다` : `${provider.name} 공급자를 켭니다`}
            onChange={onToggle}
          />
          <span aria-hidden="true">{provider.enabled ? "사용" : "꺼짐"}</span>
        </div>
        <Button size="sm" icon={<Plus aria-hidden="true" />} onClick={onAdd}>
          {provider.name} 추가
        </Button>
      </div>
    </div>
  );
}

export function OverviewView() {
  const { providers, accounts, jobs, checkStartedAt } = useGateway();
  const { openCreateAccount, openEditAccount } = useConsoleActions();
  const now = useNow(30_000);
  const accountList = accounts.data ?? [];
  const jobList = jobs.data ?? [];
  const totals = countAccounts(accountList);
  const running = jobList.filter((job) => job.status === "running" || job.status === "approval_required").length;
  const failed = jobList.filter((job) => job.status === "failed").length;
  const unknownJobs = jobList.filter((job) => job.status === "unknown");
  const erroredAccounts = accountList.filter((account) => account.status === "error");
  const accountFigure = (value: number): string => (accounts.data === null ? "—" : String(value));
  const jobFigure = (value: number): string => (jobs.data === null ? "—" : String(value));

  async function toggleProvider(id: ProviderId, enabled: boolean): Promise<void> {
    try {
      await gateway.setProviderEnabled(id, enabled);
      notify("ok", `‘${providerName(providers.data, id)}’ 공급자를 ${enabled ? "켰습니다" : "껐습니다"}`);
    } catch (error) {
      notify("danger", "공급자 상태를 바꾸지 못했습니다", (await toApiError(error)).message);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="개요"
        description="공급자별 계정 상태와 최근 작업을 확인합니다."
        actions={
          <Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={() => openCreateAccount()}>
            계정 추가
          </Button>
        }
      />

      {accounts.error && accounts.data === null ? <LoadError title="계정 목록을 불러오지 못했습니다" error={accounts.error} /> : null}
      {jobs.error && jobs.data === null ? <LoadError title="작업 기록을 불러오지 못했습니다" error={jobs.error} /> : null}

      <dl className="stats" aria-label="요약">
        <div className="stat">
          <dt className="stat__label">등록 계정</dt>
          <dd className="stat__figure">{accountFigure(totals.total)}</dd>
          <dd className="stat__note">
            활성&nbsp;{totals.enabled} · 비활성&nbsp;{totals.disabled}
          </dd>
        </div>
        <div className="stat">
          <dt className="stat__label">작업 가능</dt>
          <dd className="stat__figure">{accountFigure(totals.available)}</dd>
          <dd className="stat__note">
            준비됨&nbsp;{totals.ready} · 오류&nbsp;{totals.error} · 미연결&nbsp;{totals.unconnected}
          </dd>
        </div>
        <div className="stat">
          <dt className="stat__label">실행 중 작업</dt>
          <dd className="stat__figure">{jobFigure(running)}</dd>
          <dd className="stat__note">작업 중 계정 {totals.busy}</dd>
        </div>
        <div className="stat">
          <dt className="stat__label">결과 불확실</dt>
          <dd className="stat__figure">{jobFigure(unknownJobs.length)}</dd>
          <dd className="stat__note">최근 실패 {failed}</dd>
        </div>
      </dl>

      {accounts.data !== null && totals.total === 0 ? (
        <EmptyState
          icon={<KeyRound aria-hidden="true" />}
          title="아직 등록된 계정이 없습니다"
          action={
            <Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={() => openCreateAccount()}>
              첫 계정 추가
            </Button>
          }
        >
          공급자 계정을 추가하고 ‘확인’으로 실제 연결을 점검하면, 작업과 /v1 API 요청이 그 계정으로 실행됩니다.
        </EmptyState>
      ) : null}

      <section className="section" aria-labelledby="providers-title">
        <SectionHead id="providers-title" title="공급자" />
        {providers.error && providers.data === null ? <LoadError title="공급자 정보를 불러오지 못했습니다" error={providers.error} /> : null}
        {providers.data === null ? (
          providers.error ? null : <SkeletonRows count={3} />
        ) : (
          <div className="ledger">
            {providers.data.map((provider) => (
              <ProviderSummary
                key={provider.id}
                provider={provider}
                accounts={accountList.filter((account) => account.provider === provider.id)}
                onAdd={() => openCreateAccount(provider.id)}
                onToggle={(enabled) => void toggleProvider(provider.id, enabled)}
              />
            ))}
          </div>
        )}
      </section>

      {accounts.data !== null && (totals.total > 0 || jobList.length > 0) ? (
        <section className="section" aria-labelledby="attention-title">
          <SectionHead id="attention-title" title="확인이 필요한 항목" />
          {erroredAccounts.length === 0 && unknownJobs.length === 0 ? (
            <p className="quiet">
              <CircleCheck aria-hidden="true" />
              오류 계정이나 결과가 불확실한 작업이 없습니다.
            </p>
          ) : (
            <ul className="attention">
              {erroredAccounts.map((account) => {
                const checking = checkStartedAt.get(account.id);
                return (
                  <li key={account.id} className="attention__item">
                    <AccountStatusBadge account={account} checkStartedAt={checking} />
                    <div className="attention__body">
                      <p className="attention__title">
                        {account.label} <span className="muted">· {providerName(providers.data, account.provider)}</span>
                      </p>
                      <p className="attention__text">{account.detail || "연결 확인에 실패했습니다."}</p>
                    </div>
                    <div className="attention__actions">
                      <Button size="sm" loading={checking !== undefined} disabled={account.busy && checking === undefined} onClick={() => void runCheck(account)}>
                        다시 확인
                      </Button>
                      <Button size="sm" variant="ghost" disabled={account.busy} onClick={() => openEditAccount(account)}>
                        편집
                      </Button>
                    </div>
                  </li>
                );
              })}
              {unknownJobs.slice(0, 5).map((job) => (
                <li key={job.id} className="attention__item">
                  <JobStatusBadge status={job.status} />
                  <div className="attention__body">
                    <p className="attention__title">{firstLine(job.prompt) || "(빈 프롬프트)"}</p>
                    <p className="attention__text">{job.error ?? "원격 완료 여부를 확인하지 못했습니다."}</p>
                  </div>
                  <div className="attention__actions">
                    <a className="btn btn--ghost btn--sm" href={routeHref({ view: "jobs", jobId: job.id })}>
                      상세 보기
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {jobs.data !== null && (jobList.length > 0 || totals.total > 0) ? (
        <section className="section" aria-labelledby="recent-title">
          <SectionHead id="recent-title" title="최근 작업">
            <a className="link" href={routeHref({ view: "jobs", jobId: null })}>
              {jobList.length > 0 ? "모든 작업 보기" : "작업 보내기"}
            </a>
          </SectionHead>
          {jobList.length === 0 ? (
            <p className="quiet">아직 실행한 작업이 없습니다.</p>
          ) : (
            <div className="ledger">
              {jobList.slice(0, 5).map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  account={accountList.find((account) => account.id === job.accountId)}
                  provider={providerName(providers.data, job.provider)}
                  now={now}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
