import { useState } from "react";
import type { Account } from "../../contracts";
import { Drawer } from "../components/dialog";
import { Button, CodeBlock, Notice } from "../components/ui";
import { cancelDotsLogin, completeDotsLogin, startDotsLogin, toApiError } from "../lib/api";
import type { DotsDevice } from "../lib/api";
import { gateway } from "../lib/store";

export function DotsLoginDrawer({ account, onClose }: { readonly account: Account; readonly onClose: () => void }) {
  const [device, setDevice] = useState<DotsDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setDevice(await startDotsLogin(account.id));
      setMessage("다른 기기의 브라우저에서도 인증할 수 있습니다. 링크에서 코드를 입력한 뒤 돌아오세요.");
    } catch (failure) { setError((await toApiError(failure)).message); }
    finally { setBusy(false); }
  }
  async function complete(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await completeDotsLogin(account.id);
      switch (result.status) {
        case "pending":
          setMessage(`아직 인증 대기 중입니다. 인증을 마친 뒤 ${Math.ceil(result.retryAfterMs / 1000)}초 이후 다시 확인하세요.`);
          break;
        case "connected":
          setDevice(null);
          await gateway.refresh();
          if (result.account.status === "ready") onClose();
          else setError(result.account.detail);
          break;
      }
    } catch (failure) { setError((await toApiError(failure)).message); }
    finally { setBusy(false); }
  }
  async function close(): Promise<void> {
    setBusy(true);
    try {
      if (device) await cancelDotsLogin(account.id);
      onClose();
    } catch (failure) { setError((await toApiError(failure)).message); }
    finally { setBusy(false); }
  }
  return <Drawer title="Dots 기기 로그인" subtitle={account.label} busy={busy} onClose={() => void close()}
    footer={<>
      <Button disabled={busy} onClick={() => void close()}>닫기</Button>
      {device
        ? <Button variant="primary" loading={busy} onClick={() => void complete()}>인증 완료 및 Dot 확인</Button>
        : <Button variant="primary" loading={busy} onClick={() => void start()}>기기 인증 시작</Button>}
    </>}>
    <div className="form">
      <Notice title="내 Dot에 연결">
        ChatGPT 계정으로 기기 인증하면 이 서버가 그 계정의 Dot과 대화합니다. 기기 인증이 계정 설정에서 허용되어 있어야 합니다.
      </Notice>
      {device ? <>
        <a className="btn btn--primary" href={device.verificationUrl} target="_blank" rel="noopener noreferrer">ChatGPT 인증 열기</a>
        <CodeBlock caption="일회용 기기 코드" code={device.userCode} />
        <p className="section-note">인증 만료: {new Date(device.expiresAt).toLocaleString()}</p>
        <Button variant="ghost" disabled={busy} onClick={() => void start()}>인증 다시 시작</Button>
      </> : null}
      {message ? <Notice>{message}</Notice> : null}
      <div role="alert">{error ? <Notice tone="danger">{error}</Notice> : null}</div>
      <p className="section-note">인증값은 서버에서 암호화해 저장합니다. 갱신 가능한 계정은 작업 전에 토큰을 갱신하며, 철회되면 다시 로그인해야 합니다.</p>
    </div>
  </Drawer>;
}
