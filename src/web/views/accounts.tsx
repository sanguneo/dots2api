import { useId, useState } from "react";
import { KeyRound, LogIn, Pencil, PlugZap, Plus, Trash2 } from "lucide-react";
import type { Account, ProviderId } from "../../contracts";
import { AccountStatusBadge, LoadError } from "../components/domain";
import { Button, EmptyState, Notice, PageHeader, Segmented, SkeletonRows, StatusBadge, Switch, TimeText, useNow } from "../components/ui";
import { runCheck, useConsoleActions } from "../lib/actions";
import { toApiError } from "../lib/api";
import { cx, providerName, shortId } from "../lib/format";
import { gateway, useGateway } from "../lib/store";
import { notify } from "../lib/toast";
import { DotsLoginDrawer } from "./dots-login";
import { MuseLoginDrawer } from "./muse-login";

type ProviderFilter = ProviderId | "all";

const BUSY_TITLE = "작업이나 연결 확인이 진행 중이라 지금은 바꿀 수 없습니다";

interface AccountRowProps {
  readonly account: Account;
  readonly provider: string;
  readonly contextWindow: number | undefined;
  readonly contextBasis: "configured" | "measured-heuristic" | undefined;
  readonly checkStartedAt: number | undefined;
  readonly now: number;
}

function AccountRow({ account, provider, contextWindow, contextBasis, checkStartedAt, now }: AccountRowProps) {
  const { openEditAccount, requestDeleteAccount } = useConsoleActions();
  const [toggling, setToggling] = useState(false);
  const [togglingKeep, setTogglingKeep] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const titleId = useId();
  const checking = checkStartedAt !== undefined;
  const lockedByServer = account.busy && !checking;
  // The full explanation lives in the edit drawer; the row only names what "off" does for this provider.
  const freshLabel = account.provider === "muse" ? "사이드 챗 삭제" : "작업마다 새 대화";

  async function toggle(enabled: boolean): Promise<void> {
    setToggling(true);
    try {
      await gateway.updateAccount(account.id, { enabled });
    } catch (error) {
      notify("danger", `‘${account.label}’ ${enabled ? "활성화" : "비활성화"}하지 못했습니다`, (await toApiError(error)).message);
    } finally {
      setToggling(false);
    }
  }

  async function toggleKeep(keepContext: boolean): Promise<void> {
    setTogglingKeep(true);
    try {
      await gateway.updateAccount(account.id, { keepContext });
    } catch (error) {
      notify("danger", `‘${account.label}’ 대화 유지 설정을 바꾸지 못했습니다`, (await toApiError(error)).message);
    } finally {
      setTogglingKeep(false);
    }
  }

  return (
    <article className={cx("account", !account.enabled && "account--disabled")} aria-labelledby={titleId}>
      <div className="account__main">
        <div className="account__title-row">
          <h3 className="account__label" id={titleId}>
            {account.label}
          </h3>
          {!account.enabled ? <StatusBadge tone="neutral">비활성</StatusBadge> : null}
          {lockedByServer ? (
            <StatusBadge tone="accent" pulse>
              작업 중
            </StatusBadge>
          ) : null}
        </div>
        <p className="account__meta">
          <span>{provider}</span>
          {contextWindow ? <span title={contextBasis === "measured-heuristic" ? "문자 수 / 4 기반 회수 실험의 잠정 운용값" : "클라이언트용 지정 운용값"}>컨텍스트 {contextWindow.toLocaleString("ko-KR")} 토큰 · {contextBasis === "measured-heuristic" ? "잠정 추정" : "지정값"}</span> : null}
          <span className="mono" title={account.id}>
            {shortId(account.id)}
          </span>
          <span>
            등록 <TimeText iso={account.createdAt} now={now} />
          </span>
          {account.hasCredentials ? null : <span>저장된 자격 증명 없음</span>}
        </p>
        {account.detail ? <p className="account__detail">{account.detail}</p> : null}
        {checking ? (
          <p className="account__progress" role="status">
            <LogIn aria-hidden="true" />
            <span>
              서버가 공급자에 접속하고 있습니다. 다른 화면으로 이동해도 확인은 계속됩니다.
            </span>
          </p>
        ) : null}
      </div>
      <div className="account__state">
        <AccountStatusBadge account={account} checkStartedAt={checkStartedAt} />
        <p className="account__times">
          {account.checkedAt ? (
            <span>
              확인 <TimeText iso={account.checkedAt} now={now} />
            </span>
          ) : (
            <span>확인 기록 없음</span>
          )}
          {account.lastUsedAt ? (
            <span>
              사용 <TimeText iso={account.lastUsedAt} now={now} />
            </span>
          ) : null}
        </p>
      </div>
      <div className="account__controls">
        <div className="account__switch">
          <Switch
            checked={account.enabled}
            label={`${account.label} 활성화`}
            loading={toggling}
            disabled={account.busy}
            title={account.busy ? BUSY_TITLE : undefined}
            onChange={(enabled) => void toggle(enabled)}
          />
          <span aria-hidden="true">{account.enabled ? "활성" : "비활성"}</span>
        </div>
        <div className="account__switch">
          <Switch
            checked={account.keepContext}
            label={`${account.label} 대화 유지`}
            loading={togglingKeep}
            disabled={account.busy}
            title={account.busy ? BUSY_TITLE : undefined}
            onChange={(keepContext) => void toggleKeep(keepContext)}
          />
          <span aria-hidden="true">{account.keepContext ? "대화 유지" : freshLabel}</span>
        </div>
        <div className="account__actions">
          <Button size="sm" icon={<LogIn aria-hidden="true" />} disabled={account.busy} onClick={() => setLoginOpen(true)}>
            로그인
          </Button>
          <Button
            size="sm"
            icon={<PlugZap aria-hidden="true" />}
            loading={checking}
            disabled={lockedByServer}
            title={lockedByServer ? BUSY_TITLE : "공급자에 실제로 접속해 연결 상태를 기록합니다"}
            onClick={() => void runCheck(account)}
          >
            확인
          </Button>
          <Button size="sm" variant="ghost" icon={<Pencil aria-hidden="true" />} onClick={() => openEditAccount(account)}>
            편집
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 aria-hidden="true" />}
            disabled={account.busy}
            title={account.busy ? BUSY_TITLE : undefined}
            onClick={() => requestDeleteAccount(account)}
          >
            삭제
          </Button>
        </div>
      </div>
      {loginOpen && account.provider === "dots" ? <DotsLoginDrawer account={account} onClose={() => setLoginOpen(false)} /> : null}
      {loginOpen && account.provider === "muse" ? <MuseLoginDrawer account={account} onClose={() => setLoginOpen(false)} /> : null}
    </article>
  );
}

export function AccountsView() {
  const { providers, accounts, checkStartedAt } = useGateway();
  const { openCreateAccount } = useConsoleActions();
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const now = useNow(30_000);
  const providerList = providers.data ?? [];
  const accountList = accounts.data ?? [];
  const visible = filter === "all" ? accountList : accountList.filter((account) => account.provider === filter);
  const filterName = filter === "all" ? null : providerName(providers.data, filter);
  const options = [
    { value: "all" as const, label: "전체", count: accountList.length },
    ...providerList.map((provider) => ({
      value: provider.id,
      label: provider.name,
      count: accountList.filter((account) => account.provider === provider.id).length,
    })),
  ];
  const addForFilter = (): void => openCreateAccount(filter === "all" ? undefined : filter);

  return (
    <div className="page">
      <PageHeader
        title="계정"
        description="계정을 등록하고 실제 연결을 확인합니다. 입력한 인증값은 암호화해 저장합니다."
        actions={
          <Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={addForFilter}>
            계정 추가
          </Button>
        }
      />
      {providerList.length > 1 ? (
        <div className="toolbar">
          <Segmented legend="공급자로 거르기" variant="chips" value={filter} options={options} onChange={setFilter} />
        </div>
      ) : null}
      {providers.error && providers.data === null ? <LoadError title="공급자 정보를 불러오지 못했습니다" error={providers.error} /> : null}
      {accounts.error && accounts.data === null ? <LoadError title="계정 목록을 불러오지 못했습니다" error={accounts.error} /> : null}
      {accounts.error && accounts.data !== null ? (
        <Notice tone="warn" title="최신 상태로 갱신하지 못했습니다">
          {accounts.error.message}
        </Notice>
      ) : null}
      {accounts.data === null ? (
        accounts.error ? null : <SkeletonRows count={3} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<KeyRound aria-hidden="true" />}
          title={filterName ? `${filterName} 계정이 없습니다` : "아직 등록된 계정이 없습니다"}
          action={
            <Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={addForFilter}>
              {filterName ? `${filterName} 계정 추가` : "첫 계정 추가"}
            </Button>
          }
        >
          계정을 추가한 뒤 ‘확인’으로 연결하면 작업과 /v1 API 요청에 사용할 수 있습니다.
        </EmptyState>
      ) : (
        <div className="ledger">
          {visible.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              provider={providerName(providers.data, account.provider)}
              contextWindow={providerList.find((provider) => provider.id === account.provider)?.contextWindow}
              contextBasis={providerList.find((provider) => provider.id === account.provider)?.contextBasis}
              checkStartedAt={checkStartedAt.get(account.id)}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}
