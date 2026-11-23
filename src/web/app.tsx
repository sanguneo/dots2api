import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, KeyRound, LayoutDashboard, ListChecks, Moon, RefreshCw, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Account, ProviderId } from "../contracts";
import { ToastRegion } from "./components/toast-region";
import { Button, IconButton, Notice } from "./components/ui";
import { ConsoleActionsContext } from "./lib/actions";
import type { ConsoleActions, EditorState } from "./lib/actions";
import { cx } from "./lib/format";
import { routeHref, useRoute } from "./lib/router";
import type { Route, View } from "./lib/router";
import { gateway, useGateway } from "./lib/store";
import { useTheme } from "./lib/theme";
import type { LiveState } from "./lib/store";
import { AccountDrawer, DeleteAccountDialog, ProviderChoiceDrawer } from "./views/account-dialogs";
import { AccountsView } from "./views/accounts";
import { ApiGuideView } from "./views/api-guide";
import { DotsConnectDrawer } from "./views/dots-connect";
import { JobsView } from "./views/jobs";
import { MuseConnectDrawer } from "./views/muse-login";
import { OverviewView } from "./views/overview";

const NAV: ReadonlyArray<{ readonly view: View; readonly label: string; readonly Icon: LucideIcon; readonly target: Route }> = [
  { view: "overview", label: "개요", Icon: LayoutDashboard, target: { view: "overview" } },
  { view: "accounts", label: "계정", Icon: KeyRound, target: { view: "accounts" } },
  { view: "jobs", label: "작업", Icon: ListChecks, target: { view: "jobs", jobId: null } },
  { view: "api", label: "API 안내", Icon: BookOpen, target: { view: "api" } },
];

const LIVE_TEXT: Readonly<Record<LiveState, string>> = {
  connecting: "실시간 연결 중",
  open: "실시간 반영 중",
  reconnecting: "실시간 재연결 중",
  closed: "실시간 연결 끊김",
};

const LIVE_TONE = { connecting: "warn", open: "ok", reconnecting: "warn", closed: "danger" } as const satisfies Record<LiveState, string>;

/** Each provider adds accounts through its own login; without a provider the user picks one first. */
function connectEditor(provider: ProviderId | undefined): EditorState {
  switch (provider) {
    case "dots": return { mode: "connect" };
    case "muse": return { mode: "muse-connect" };
    case undefined: return { mode: "choose" };
    default: return provider satisfies never;
  }
}

function ViewSwitch({ route }: { readonly route: Route }) {
  switch (route.view) {
    case "overview":
      return <OverviewView />;
    case "accounts":
      return <AccountsView />;
    case "jobs":
      return <JobsView jobId={route.jobId} />;
    case "api":
      return <ApiGuideView />;
  }
}

export function App() {
  const route = useRoute();
  const [theme, toggleTheme] = useTheme();
  const { providers, accounts, jobs, live, syncing } = useGateway();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const lastView = useRef<View>(route.view);

  useEffect(() => gateway.start(), []);

  useEffect(() => {
    document.title = `${NAV.find((item) => item.view === route.view)?.label ?? "개요"} · dots2api`;
    if (lastView.current === route.view) return;
    lastView.current = route.view;
    document.getElementById("page-title")?.focus();
  }, [route.view]);

  const actions = useMemo<ConsoleActions>(
    () => ({
      openCreateAccount: (provider) => setEditor(connectEditor(provider)),
      openEditAccount: (account) => setEditor({ mode: "edit", account }),
      requestDeleteAccount: (account) => setDeleting(account),
    }),
    [],
  );

  const accountCount = accounts.data?.length ?? null;
  const running = jobs.data?.filter((job) => job.status === "running" || job.status === "approval_required").length ?? 0;
  const unauthorized = [providers.error, accounts.error, jobs.error].some((error) => error?.unauthorized === true);

  function skipToMain(): void {
    document.getElementById("main")?.focus();
  }

  return (
    <ConsoleActionsContext value={actions}>
      <button className="skip-link" type="button" onClick={skipToMain}>
        본문으로 건너뛰기
      </button>
      <div className="shell">
        <header className="site-header">
          <div className="wrap header-row">
            <a className="brand" href={routeHref({ view: "overview" })}>
              <span className="brand__mark" aria-hidden="true" />
              <span className="brand__text">
                <span className="brand__name">
                  dots2<em>api</em>
                </span>
                <span className="brand__sub">로컬 관리 콘솔</span>
              </span>
            </a>
            <div className="header-actions">
              <p className="status-chip" role="status">
                <span
                  className={cx("signal", `signal--${LIVE_TONE[live]}`, (live === "connecting" || live === "reconnecting") && "signal--pulse")}
                  aria-hidden="true"
                />
                <span className="status-chip__text">{LIVE_TEXT[live]}</span>
              </p>
              {live === "closed" ? (
                <Button size="sm" onClick={() => gateway.reconnect()}>
                  다시 연결
                </Button>
              ) : null}
              <Button
                size="sm"
                className="btn--refresh"
                icon={<RefreshCw className={cx(syncing && "spin")} aria-hidden="true" />}
                onClick={() => void gateway.refresh()}
              >
                새로 고침
              </Button>
              <IconButton
                label={theme === "dark" ? "라이트 테마로 전환" : "다크 테마로 전환"}
                icon={theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
                onClick={toggleTheme}
              />
            </div>
          </div>
        </header>
        <main id="main" className="wrap main" tabIndex={-1}>
          <nav className="tabs" aria-label="주 메뉴">
            <ul className="nav">
              {NAV.map(({ view, label, Icon, target }) => (
                <li key={view}>
                  <a className="nav__link" href={routeHref(target)} aria-current={route.view === view ? "page" : undefined}>
                    <Icon aria-hidden="true" />
                    <span className="nav__label">{label}</span>
                    {view === "accounts" && accountCount !== null ? <span className="nav__count">{accountCount}</span> : null}
                    {view === "jobs" && running > 0 ? (
                      <span className="nav__count nav__count--live" title={`실행 중 ${running}개`}>
                        {running}
                      </span>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {unauthorized ? (
            <div className="main__notice">
              <Notice
                tone="danger"
                title="관리 API에 접근할 수 없습니다"
                action={
                  <Button size="sm" onClick={() => void gateway.refresh()}>
                    다시 시도
                  </Button>
                }
              >
                관리 API는 서버와 같은 주소(127.0.0.1 또는 localhost)에서 연 브라우저의 요청만 허용합니다. 서버가 시작할 때 출력한 주소로 이 콘솔을 직접 여세요.
              </Notice>
            </div>
          ) : null}
          <ViewSwitch route={route} />
        </main>
      </div>
      {editor?.mode === "choose" ? <ProviderChoiceDrawer onChoose={(provider) => setEditor(connectEditor(provider))} onClose={() => setEditor(null)} /> : null}
      {editor?.mode === "connect" ? <DotsConnectDrawer onClose={() => setEditor(null)} /> : null}
      {editor?.mode === "muse-connect" ? <MuseConnectDrawer onClose={() => setEditor(null)} /> : null}
      {editor?.mode === "edit" ? <AccountDrawer key={editor.account.id} account={editor.account} onClose={() => setEditor(null)} /> : null}
      {deleting ? <DeleteAccountDialog account={deleting} onClose={() => setDeleting(null)} /> : null}
      <ToastRegion />
    </ConsoleActionsContext>
  );
}
