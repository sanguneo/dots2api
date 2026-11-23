import { useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ListChecks, Plus, Send } from "lucide-react";
import type { AccountId, JobId, JobStatus, ProviderId } from "../../contracts";
import { JobRow, LoadError } from "../components/domain";
import { Button, EmptyState, Field, Notice, PageHeader, SectionHead, Segmented, Select, SkeletonRows, useNow } from "../components/ui";
import { useConsoleActions } from "../lib/actions";
import { toApiError } from "../lib/api";
import type { JobTarget } from "../lib/api";
import { accountStatusLabel, availabilityLabel, countAccounts, isAvailable, jobStatusLabel, providerName } from "../lib/format";
import { navigate } from "../lib/router";
import { gateway, useGateway } from "../lib/store";
import { JobDrawer } from "./job-drawer";

type TargetMode = "provider" | "account";
type StatusFilter = JobStatus | "all";

const STATUS_ORDER: readonly JobStatus[] = ["queued", "running", "approval_required", "completed", "failed", "unknown"];

function JobComposer() {
  const { providers, accounts } = useGateway();
  const { openCreateAccount } = useConsoleActions();
  const [mode, setMode] = useState<TargetMode>("provider");
  const [providerChoice, setProviderChoice] = useState<ProviderId | null>(null);
  const [accountChoice, setAccountChoice] = useState<AccountId | null>(null);
  const [prompt, setPrompt] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const providerList = providers.data ?? [];
  const accountList = accounts.data ?? [];
  const fallbackProvider =
    providerList.find((provider) => accountList.some((account) => account.provider === provider.id && isAvailable(account))) ?? providerList[0];
  const providerId = providerChoice ?? fallbackProvider?.id ?? null;
  const providerCounts = providerId ? countAccounts(accountList.filter((account) => account.provider === providerId)) : null;
  const selectedAccount = accountList.find((account) => account.id === accountChoice) ?? accountList.find(isAvailable) ?? null;
  const noAccounts = accounts.data !== null && accountList.length === 0;

  async function submit(): Promise<void> {
    if (sending) return;
    if (!prompt.trim()) {
      setPromptError("프롬프트를 입력하세요.");
      promptRef.current?.focus();
      return;
    }
    let target: JobTarget;
    if (mode === "account") {
      if (!selectedAccount) {
        setSubmitError("작업을 보낼 계정을 고르세요.");
        return;
      }
      target = { accountId: selectedAccount.id };
    } else {
      if (!providerId) {
        setSubmitError("공급자를 고르세요.");
        return;
      }
      target = { provider: providerId };
    }
    setPromptError(null);
    setSubmitError(null);
    setSending(true);
    try {
      const job = await gateway.createJob(target, prompt);
      setPrompt("");
      navigate({ view: "jobs", jobId: job.id });
    } catch (error) {
      setSubmitError((await toApiError(error)).message);
    } finally {
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit();
  }

  function onPromptKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  }

  const providerHint = providerCounts
    ? providerCounts.available > 0
      ? `작업 가능한 계정 ${providerCounts.available}개 중 가장 오래 쉰 계정이 실행합니다.`
      : "지금 작업 가능한 계정이 없습니다. 활성 상태이고 연결 확인을 마친 유휴 계정이 필요합니다."
    : undefined;
  const accountHint = selectedAccount
    ? isAvailable(selectedAccount)
      ? `상태: ${accountStatusLabel[selectedAccount.status]} · 이 계정에서만 실행합니다.`
      : `지금은 보낼 수 없습니다 (${availabilityLabel(selectedAccount)}).`
    : "작업 가능한 계정이 없습니다.";

  return (
    <section className="composer" aria-labelledby="composer-title">
      <h2 className="section-title" id="composer-title">
        새 작업
      </h2>
      {noAccounts ? (
        <Notice
          tone="warn"
          title="작업을 보내려면 계정이 필요합니다"
          action={
            <Button size="sm" icon={<Plus aria-hidden="true" />} onClick={() => openCreateAccount()}>
              계정 추가
            </Button>
          }
        >
          계정을 추가하고 연결 확인을 마치면 작업을 보낼 수 있습니다.
        </Notice>
      ) : null}
      <form className="composer__form" noValidate onSubmit={onSubmit}>
        <div className="composer__grid">
          <div className="composer__target">
            <Segmented
              legend="실행 대상"
              value={mode}
              options={[
                { value: "provider", label: "공급자 자동 선택" },
                { value: "account", label: "계정 지정" },
              ]}
              onChange={setMode}
            />
            {mode === "provider" ? (
              <Field label="공급자" hint={providerHint}>
                {(control) => (
                  <Select
                    {...control}
                    value={providerId ?? ""}
                    disabled={providerList.length === 0}
                    onChange={(event) => setProviderChoice(providerList.find((provider) => provider.id === event.target.value)?.id ?? null)}
                  >
                    {providerList.map((provider) => {
                      const counts = countAccounts(accountList.filter((account) => account.provider === provider.id));
                      return (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} · 작업 가능 {counts.available}/{counts.total}
                        </option>
                      );
                    })}
                  </Select>
                )}
              </Field>
            ) : (
              <Field label="계정" hint={accountHint}>
                {(control) => (
                  <Select
                    {...control}
                    value={selectedAccount?.id ?? ""}
                    disabled={accountList.length === 0}
                    onChange={(event) => setAccountChoice(accountList.find((account) => account.id === event.target.value)?.id ?? null)}
                  >
                    <option value="" disabled>
                      계정을 고르세요
                    </option>
                    {providerList.map((provider) => {
                      const group = accountList.filter((account) => account.provider === provider.id);
                      return group.length === 0 ? null : (
                        <optgroup key={provider.id} label={provider.name}>
                          {group.map((account) => (
                            <option key={account.id} value={account.id} disabled={!isAvailable(account)}>
                              {account.label} · {availabilityLabel(account)}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </Select>
                )}
              </Field>
            )}
          </div>
          <Field
            label="프롬프트"
            error={promptError}
            hint={
              <span>
                원격 에이전트에 그대로 전달됩니다. <kbd className="kbd">⌘/Ctrl</kbd> + <kbd className="kbd">Enter</kbd>로 보낼 수 있습니다.
              </span>
            }
          >
            {(control) => (
              <textarea
                {...control}
                ref={promptRef}
                className="input input--area composer__prompt"
                rows={6}
                value={prompt}
                placeholder="예: 오늘 받은 메일을 정리해서 중요한 것만 알려 줘"
                onChange={(event) => {
                  setPrompt(event.target.value);
                  if (promptError) setPromptError(null);
                }}
                onKeyDown={onPromptKey}
              />
            )}
          </Field>
        </div>
        {submitError ? (
          <Notice tone="danger" title="작업을 보내지 못했습니다">
            {submitError}
          </Notice>
        ) : null}
        <div className="composer__foot">
          <p className="composer__hint">수락된 작업은 아래 기록에 실시간으로 반영됩니다. 결과가 불확실한 작업은 자동으로 다시 보내지 않습니다.</p>
          <Button type="submit" variant="primary" icon={<Send aria-hidden="true" />} loading={sending} disabled={noAccounts}>
            작업 보내기
          </Button>
        </div>
      </form>
    </section>
  );
}

export function JobsView({ jobId }: { readonly jobId: JobId | null }) {
  const { providers, accounts, jobs } = useGateway();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const now = useNow(30_000);
  const jobList = jobs.data ?? [];
  const visible = filter === "all" ? jobList : jobList.filter((job) => job.status === filter);
  const options = [
    { value: "all" as const, label: "전체", count: jobList.length },
    ...STATUS_ORDER.map((status) => ({ value: status, label: jobStatusLabel[status], count: jobList.filter((job) => job.status === status).length })),
  ];

  return (
    <div className="page">
      <PageHeader title="작업" description="프롬프트를 원격 에이전트 작업으로 보내고 결과를 확인합니다. 계정마다 한 번에 한 작업만 실행됩니다." />
      <JobComposer />
      <section className="section" aria-labelledby="jobs-title">
        <SectionHead id="jobs-title" title="작업 기록">
          {jobList.length > 0 ? <Segmented legend="상태로 거르기" variant="chips" value={filter} options={options} onChange={setFilter} /> : null}
        </SectionHead>
        {jobs.error && jobs.data === null ? <LoadError title="작업 기록을 불러오지 못했습니다" error={jobs.error} /> : null}
        {jobs.data === null ? (
          jobs.error ? null : <SkeletonRows count={4} />
        ) : jobList.length === 0 ? (
          <EmptyState icon={<ListChecks aria-hidden="true" />} title="아직 실행한 작업이 없습니다">
            위에서 프롬프트를 보내면 선택한 계정의 원격 에이전트가 작업을 수행하고, 진행 상태와 결과가 여기에 실시간으로 표시됩니다.
          </EmptyState>
        ) : visible.length === 0 ? (
          <p className="quiet">이 상태의 작업이 없습니다.</p>
        ) : (
          <div className="ledger">
            {visible.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                account={accounts.data?.find((account) => account.id === job.accountId)}
                provider={providerName(providers.data, job.provider)}
                now={now}
              />
            ))}
          </div>
        )}
      </section>
      {jobId ? <JobDrawer jobId={jobId} onClose={() => navigate({ view: "jobs", jobId: null })} /> : null}
    </div>
  );
}
