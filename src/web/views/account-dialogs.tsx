import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ChevronRight, ExternalLink, PlugZap } from "lucide-react";
import type { Account, CredentialField, ProviderId } from "../../contracts";
import { ConfirmDialog, Drawer } from "../components/dialog";
import { LoadError } from "../components/domain";
import { Button, Field, Notice, SecretArea, SecretInput, SkeletonRows, Switch } from "../components/ui";
import type { NoticeTone } from "../components/ui";
import { runCheck } from "../lib/actions";
import { toApiError } from "../lib/api";
import { isHttpUrl, providerName, shortId } from "../lib/format";
import { gateway, useGateway } from "../lib/store";
import { notify } from "../lib/toast";

type SaveMode = "save" | "save-check";
type TextMap = Readonly<Record<string, string>>;

const LABEL_MAX = 80;

interface CredentialInputProps {
  readonly field: CredentialField;
  readonly value: string;
  readonly error: string | null;
  readonly editing: boolean;
  readonly onChange: (value: string) => void;
}

function CredentialInput({ field, value, error, editing, onChange }: CredentialInputProps) {
  const placeholder = editing ? "변경하지 않음" : undefined;
  return (
    <Field label={field.label} mark={editing ? null : field.required ? "required" : "optional"} hint={field.help || undefined} error={error}>
      {(control) => {
        const shared = { ...control, name: field.key, value, placeholder };
        if (field.secret && field.multiline) return <SecretArea {...shared} rows={4} onChange={(event) => onChange(event.target.value)} />;
        if (field.secret) return <SecretInput {...shared} onChange={(event) => onChange(event.target.value)} />;
        if (field.multiline) {
          return <textarea {...shared} className="input input--area" rows={4} spellCheck={false} onChange={(event) => onChange(event.target.value)} />;
        }
        return (
          <input
            {...shared}
            className="input"
            type="text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      }}
    </Field>
  );
}

/** “계정 추가” without a provider: pick one, then that provider's own login flow takes over. */
export function ProviderChoiceDrawer({ onChoose, onClose }: { readonly onChoose: (provider: ProviderId) => void; readonly onClose: () => void }) {
  const { providers } = useGateway();
  const providerList = providers.data ?? [];
  return (
    <Drawer title="계정 추가" subtitle="연결할 공급자를 고르세요." onClose={onClose} footer={<Button onClick={onClose}>취소</Button>}>
      <div className="form">
        {providers.error && providers.data === null ? <LoadError title="공급자 정보를 불러오지 못했습니다" error={providers.error} /> : null}
        {providers.data === null && !providers.error ? <SkeletonRows count={2} /> : null}
        {providers.data !== null && providerList.length === 0 ? <Notice tone="warn">서버에 등록된 공급자가 없습니다.</Notice> : null}
        {providerList.length > 0 ? (
          <div className="choices__list" role="list">
            {providerList.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="listitem"
                className="choice choice--action"
                {...(index === 0 ? { "data-autofocus": "" } : {})}
                onClick={() => onChoose(item.id)}
              >
                <span className="choice__body">
                  <span className="choice__title">{item.name}</span>
                  <span className="choice__desc">{item.description}</span>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : null}
        <p className="section-note">고른 공급자의 로그인 화면으로 바로 넘어갑니다. 토큰이나 쿠키를 직접 붙여넣을 필요는 없습니다.</p>
      </div>
    </Drawer>
  );
}

/** Edits an existing account. Credentials are a collapsed fallback; adding an account goes through login. */
export function AccountDrawer({ account, onClose }: { readonly account: Account; readonly onClose: () => void }) {
  const { providers, accounts } = useGateway();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [label, setLabel] = useState(account.label);
  const [keepContext, setKeepContext] = useState(account.keepContext);
  const [values, setValues] = useState<TextMap>({});
  const [labelError, setLabelError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ readonly tone: NoticeTone; readonly text: string } | null>(null);
  const [saving, setSaving] = useState<SaveMode | null>(null);

  const provider = providers.data?.find((item) => item.id === account.provider) ?? null;
  const current = accounts.data?.find((item) => item.id === account.id) ?? null;
  const gone = accounts.data !== null && current === null;
  const busy = current?.busy ?? false;
  const blocked = saving !== null || provider === null || gone || busy;
  const keepContextNote =
    account.provider === "muse"
      ? "Muse는 작업마다 새 대화를 엽니다. 켜 두면 그 대화가 Muse 앱의 사이드 챗으로 남고, 끄면 작업이 성공한 뒤 그 사이드 챗을 삭제합니다. 삭제는 되돌릴 수 없습니다."
      : "켜 두면 계정의 대화 하나를 계속 쓰고, 이미지가 많이 쌓이면 새 대화로 교체합니다. 끄면 작업마다 새 대화를 열고 끝나면 보관합니다. 앞사람의 프롬프트와 이미지가 다음 작업에 남지 않고, 계정에 저장된 대화는 그대로라 다시 켜면 이어서 씁니다.";

  async function save(mode: SaveMode): Promise<void> {
    if (blocked || provider === null) return;
    const trimmedLabel = label.trim();
    const nextLabelError = !trimmedLabel ? "라벨을 입력하세요." : trimmedLabel.length > LABEL_MAX ? `${LABEL_MAX}자 이하로 입력하세요.` : null;
    setLabelError(nextLabelError);
    if (nextLabelError) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    const credentials: Record<string, string> = {};
    for (const field of provider.fields) {
      const value = (values[field.key] ?? "").trim();
      if (value) credentials[field.key] = value;
    }
    const changedLabel = trimmedLabel !== account.label;
    const changedCredentials = Object.keys(credentials).length > 0;
    const changedKeepContext = keepContext !== account.keepContext;
    setMessage(null);
    if (!changedLabel && !changedCredentials && !changedKeepContext && mode === "save") {
      setMessage({ tone: "info", text: "변경된 내용이 없습니다." });
      return;
    }
    setSaving(mode);
    try {
      let saved: Account = current ?? account;
      if (changedLabel || changedCredentials || changedKeepContext) {
        saved = await gateway.updateAccount(account.id, {
          ...(changedLabel ? { label: trimmedLabel } : {}),
          ...(changedCredentials ? { credentials } : {}),
          ...(changedKeepContext ? { keepContext } : {}),
        });
        notify(
          "ok",
          `‘${saved.label}’ 계정을 저장했습니다`,
          changedCredentials && mode === "save" ? "자격 증명이 바뀌어 연결 상태가 ‘미연결’로 돌아갔습니다. 다시 확인하세요." : null,
        );
      }
      onClose();
      if (mode === "save-check") void runCheck(saved);
    } catch (error) {
      setMessage({ tone: "danger", text: (await toApiError(error)).message });
      setSaving(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void save("save");
  }

  return (
    <Drawer
      title="계정 편집"
      subtitle={`${providerName(providers.data, account.provider)} · ${shortId(account.id)}`}
      busy={saving !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={saving !== null}>
            취소
          </Button>
          <Button type="submit" form={formId} loading={saving === "save"} disabled={blocked && saving !== "save"}>
            저장
          </Button>
          <Button
            variant="primary"
            icon={<PlugZap aria-hidden="true" />}
            loading={saving === "save-check"}
            disabled={blocked && saving !== "save-check"}
            onClick={() => void save("save-check")}
          >
            저장하고 확인
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className="form" noValidate autoComplete="off" onSubmit={submit}>
        {providers.error && providers.data === null ? <LoadError title="공급자 정보를 불러오지 못했습니다" error={providers.error} /> : null}
        {providers.data === null && !providers.error ? <SkeletonRows count={3} /> : null}
        {gone ? (
          <Notice tone="warn" title="계정이 삭제되었습니다">
            다른 곳에서 이 계정이 삭제되어 저장할 수 없습니다.
          </Notice>
        ) : null}
        {busy ? (
          <Notice tone="warn" title="계정이 작업 중입니다">
            작업이나 연결 확인이 끝나야 저장할 수 있습니다. 끝나면 이 화면이 자동으로 갱신됩니다.
          </Notice>
        ) : null}

        <div className="form__section">
          <Field label="라벨" error={labelError} hint="목록과 작업 기록에서 이 계정을 구분하는 이름입니다.">
            {(control) => (
              <input
                {...control}
                className="input"
                type="text"
                value={label}
                maxLength={LABEL_MAX}
                data-autofocus=""
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="form__section">
          <div className="form__section-head">
            <p className="form__section-title">대화 유지</p>
          </div>
          <div className="account__switch">
            <Switch
              checked={keepContext}
              label={`${account.label} 대화 유지`}
              disabled={busy}
              onChange={setKeepContext}
            />
            <span aria-hidden="true">{keepContext ? "대화 유지" : account.provider === "muse" ? "사이드 챗 삭제" : "작업마다 새 대화"}</span>
          </div>
          <p className="quiet">{keepContextNote}</p>
        </div>

        <Notice title="다시 로그인하려면">
          <p>인증이 만료되면 계정 목록의 ‘로그인’ 버튼으로 다시 로그인하세요. 아래 값을 직접 넣을 필요는 없습니다.</p>
        </Notice>

        {provider && provider.fields.length > 0 ? (
          <details className="form__section advanced">
            <summary className="advanced__summary">고급: 인증값 직접 입력</summary>
            <div className="advanced__body">
              <div className="form__section-head">
                <p className="quiet">바꿀 항목만 입력하세요. 비워 둔 항목은 기존 값이 유지되고, 값을 바꾸면 연결 상태가 ‘미연결’로 돌아갑니다.</p>
                {isHttpUrl(provider.setupUrl) ? (
                  <a className="link" href={provider.setupUrl} target="_blank" rel="noreferrer noopener">
                    설정 안내 <ExternalLink aria-hidden="true" />
                  </a>
                ) : null}
              </div>
              {provider.fields.map((field) => (
                <CredentialInput
                  key={`${provider.id}:${field.key}`}
                  field={field}
                  value={values[field.key] ?? ""}
                  error={null}
                  editing
                  onChange={(value) => setValues((previous) => ({ ...previous, [field.key]: value }))}
                />
              ))}
            </div>
          </details>
        ) : null}
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      </form>
    </Drawer>
  );
}

export function DeleteAccountDialog({ account, onClose }: { readonly account: Account; readonly onClose: () => void }) {
  const { accounts, providers } = useGateway();
  const current = accounts.data?.find((item) => item.id === account.id) ?? account;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await gateway.deleteAccount(current.id);
      notify("ok", `‘${current.label}’ 계정을 삭제했습니다`);
      onClose();
    } catch (failure) {
      setError((await toApiError(failure)).message);
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog title="계정을 삭제할까요?" confirmLabel="삭제" busy={busy} confirmDisabled={current.busy} onConfirm={() => void confirm()} onClose={onClose}>
      <p>
        <strong className="strong">{current.label}</strong>{" "}
        <span className="muted">
          ({providerName(providers.data, current.provider)} · <span className="mono">{shortId(current.id)}</span>)
        </span>{" "}
        계정과 저장된 자격 증명이 삭제됩니다. 되돌릴 수 없습니다.
      </p>
      {current.busy ? <Notice tone="warn">작업 중인 계정은 삭제할 수 없습니다. 실행 중인 작업이나 확인이 끝난 뒤 다시 시도하세요.</Notice> : null}
      {error ? (
        <Notice tone="danger" title="삭제하지 못했습니다">
          {error}
        </Notice>
      ) : null}
    </ConfirmDialog>
  );
}
