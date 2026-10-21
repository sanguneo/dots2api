import { useEffect, useRef, useState } from "react";
import type { Account } from "../../contracts";
import { Drawer } from "../components/dialog";
import { Button, CodeBlock, Field, Notice } from "../components/ui";
import { cancelDotsLogin, completeDotsLogin, startDotsLogin, toApiError } from "../lib/api";
import type { DotsDevice } from "../lib/api";
import { gateway } from "../lib/store";
import { notify } from "../lib/toast";

const LABEL_MAX = 80;
const MIN_POLL_MS = 1_000;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export function DotsConnectDrawer({ onClose }: { readonly onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [device, setDevice] = useState<DotsDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!device || !account) return;
    const controller = new AbortController();
    void (async () => {
      let delay = Math.max(MIN_POLL_MS, device.pollIntervalMs);
      while (!controller.signal.aborted) {
        await wait(delay, controller.signal);
        if (controller.signal.aborted) return;
        try {
          const result = await completeDotsLogin(account.id);
          if (controller.signal.aborted) return;
          if (result.status === "pending") {
            delay = Math.max(MIN_POLL_MS, result.retryAfterMs);
            continue;
          }
          setDevice(null);
          await gateway.refresh();
          if (result.account.status === "ready") {
            done.current = true;
            notify("ok", `‘${result.account.label}’ 계정을 연결했습니다`, result.account.detail || null);
            onClose();
          } else {
            setError(result.account.detail || "Dot 연결을 확인하지 못했습니다. 이 ChatGPT 계정에 Dot이 있는지 확인한 뒤 다시 시작하세요.");
          }
          return;
        } catch (failure) {
          if (controller.signal.aborted) return;
          setDevice(null);
          setError((await toApiError(failure)).message);
          return;
        }
      }
    })();
    return () => controller.abort();
  // Bound to one device session: edits or parent re-renders must not restart polling.
  }, [device, account?.id]);

  async function start(): Promise<void> {
    const trimmedLabel = label.trim();
    const nextLabelError = !trimmedLabel ? "라벨을 입력하세요." : trimmedLabel.length > LABEL_MAX ? `${LABEL_MAX}자 이하로 입력하세요.` : null;
    setLabelError(nextLabelError);
    if (nextLabelError) return;
    setBusy(true);
    setError(null);
    try {
      const target = account ?? (await gateway.createAccount({ provider: "dots", label: trimmedLabel, credentials: {} }));
      setAccount(target);
      setDevice(await startDotsLogin(target.id));
    } catch (failure) {
      setError((await toApiError(failure)).message);
    } finally {
      setBusy(false);
    }
  }

  async function close(): Promise<void> {
    if (done.current || !account) return onClose();
    setBusy(true);
    try {
      if (device) await cancelDotsLogin(account.id);
      await gateway.deleteAccount(account.id);
    } catch {
      notify("warn", "연결하지 못한 계정이 남아 있습니다", "계정 목록에서 삭제하거나 로그인을 다시 진행하세요.");
    } finally {
      setBusy(false);
    }
    onClose();
  }

  const waiting = device !== null;
  return (
    <Drawer
      title="Dot 계정 연결"
      subtitle="추가와 기기 인증을 한 번에 진행합니다."
      busy={busy}
      onClose={() => void close()}
      footer={
        <>
          <Button disabled={busy} onClick={() => void close()}>
            {waiting ? "취소" : "닫기"}
          </Button>
          {waiting ? (
            <Button disabled={busy} onClick={() => void start()}>
              인증 다시 시작
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void start()}>
              {account ? "인증 다시 시작" : "연결 시작"}
            </Button>
          )}
        </>
      }
    >
      <form className="form" noValidate autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (!waiting && !busy) void start(); }}>
        <Notice title="내 Dot에 연결">
          ChatGPT 계정으로 기기 인증하면 이 서버가 그 계정의 Dot과 대화합니다. 요청은 ChatGPT의 Dot 대화에 그대로 남습니다.
          기기 인증이 계정 설정에서 허용되어 있어야 합니다.
        </Notice>
        <Field label="라벨" mark="required" error={labelError} hint="목록과 작업 기록에서 이 계정을 구분하는 이름입니다.">
          {(control) => (
            <input
              {...control}
              className="input"
              type="text"
              value={label}
              maxLength={LABEL_MAX}
              placeholder="예: 내 Dot"
              data-autofocus=""
              disabled={account !== null}
              onChange={(event) => setLabel(event.target.value)}
            />
          )}
        </Field>
        {device ? (
          <>
            <Notice title="인증을 기다리는 중입니다">
              아래 링크에서 코드를 입력해 승인하세요. 승인되면 이 화면이 자동으로 연결을 마칩니다. 다른 기기의 브라우저에서 해도 됩니다.
            </Notice>
            <a className="btn btn--primary" href={device.verificationUrl} target="_blank" rel="noopener noreferrer">
              ChatGPT 인증 열기
            </a>
            <CodeBlock caption="일회용 기기 코드" code={device.userCode} />
            <p className="section-note">인증 만료: {new Date(device.expiresAt).toLocaleString()}</p>
          </>
        ) : null}
        <div role="alert">{error ? <Notice tone="danger">{error}</Notice> : null}</div>
        <p className="section-note">인증값은 서버에서 암호화해 저장합니다. 갱신 가능한 계정은 작업 전에 토큰을 갱신하며, 철회되면 다시 로그인해야 합니다.</p>
      </form>
    </Drawer>
  );
}
