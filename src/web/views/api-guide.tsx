import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { Button, CodeBlock, CopyButton, Notice, PageHeader, SectionHead, SkeletonRows, StatusBadge } from "../components/ui";
import type { Tone } from "../components/ui";
import { getSettings, listModels, toApiError } from "../lib/api";
import type { ApiError, ModelInfo, Settings } from "../lib/api";
import { omoModelsConfig } from "../lib/model-config";

type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly value: T };

function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function maskKey(key: string): string {
  return `${"•".repeat(12)}${key.length > 16 ? key.slice(-4) : ""}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const tokenCount = new Intl.NumberFormat("ko-KR");

const contextBasis: Readonly<Record<ModelInfo["context_basis"], { readonly tone: Tone; readonly label: string; readonly note: string }>> = {
  configured: {
    tone: "neutral",
    label: "지정값",
    note: "지정값은 공급자별로 정해 둔 운용값이며 측정치가 아닙니다.",
  },
  "measured-heuristic": {
    tone: "warn",
    label: "잠정 추정",
    note: "잠정 추정은 프롬프트 문자 수를 4로 나눠 토큰으로 환산한 크기에서 표식 회수를 측정하고 여유를 둔 값으로, 실제 토큰 한도를 보장하지 않습니다.",
  },
};

interface GuideProps {
  readonly settings: Settings;
  readonly models: Loadable<readonly ModelInfo[]> | null;
  readonly onReloadModels: () => void;
}

function Guide({ settings, models, onReloadModels }: GuideProps) {
  const [revealed, setRevealed] = useState(false);
  const base = apiBase(settings.baseUrl);
  const modelList = models?.status === "ready" ? models.value : [];
  const firstModel = modelList[0];
  const bases = [...new Set(modelList.map((model) => model.context_basis))];
  const envSnippet = (key: string): string => `export DOTS2API_URL=${shellQuote(base)}\nexport DOTS2API_KEY=${shellQuote(key)}`;
  const modelsSnippet = `curl -sS "$DOTS2API_URL/models" \\\n  -H "Authorization: Bearer $DOTS2API_KEY"`;
  const chatSnippet = [
    firstModel ? `export MODEL=${shellQuote(firstModel.id)}` : "# /v1/models 응답의 data[].id 중 하나\nexport MODEL='MODEL_ID'",
    'curl -sS "$DOTS2API_URL/chat/completions" \\',
    '  -H "Authorization: Bearer $DOTS2API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d @- <<EOF",
    "{",
    '  "model": "$MODEL",',
    '  "messages": [{ "role": "user", "content": "간단히 자기소개를 해 주세요." }]',
    "}",
    "EOF",
  ].join("\n");
  const imageSnippet = [
    "export IMAGE_MODEL=dots-image   # muse-image 로 바꾸면 본인 muse.ai 계정으로 생성합니다",
    'curl -sS "$DOTS2API_URL/images/generations" \\',
    '  -H "Authorization: Bearer $DOTS2API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d @- <<EOF | jq -r '.data[0].b64_json' | base64 -d > out.png",
    "{",
    '  "model": "$IMAGE_MODEL",',
    '  "prompt": "해변을 달리는 은색 스포츠카, 실사 사진, 골든아워",',
    '  "size": "1536x1024",',
    '  "quality": "high"',
    "}",
    "EOF",
  ].join("\n");
  const omoConfig = modelList.length > 0 ? JSON.stringify(omoModelsConfig(base, modelList), null, 2) : null;

  return (
    <>
      <section className="section" aria-labelledby="connection-title">
        <SectionHead id="connection-title" title="연결 정보" />
        <dl className="kv">
          <div className="kv__row">
            <dt>Base URL</dt>
            <dd className="kv__value">
              <code className="kv__code">{base}</code>
              <CopyButton value={base} />
            </dd>
          </div>
          <div className="kv__row">
            <dt>API 키</dt>
            <dd className="kv__value">
              <code className="kv__code">{revealed ? settings.apiKey : maskKey(settings.apiKey)}</code>
              <Button
                size="sm"
                variant="ghost"
                icon={revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                aria-pressed={revealed}
                onClick={() => setRevealed((value) => !value)}
              >
                {revealed ? "숨기기" : "표시"}
              </Button>
              <CopyButton value={settings.apiKey} label="키 복사" />
            </dd>
          </div>
        </dl>
        <p className="section-note">
          이 키로 API에 접근할 수 있으니 화면 공유 중에는 표시하지 마세요. 관리 API(/api)는 같은 주소에서 연 브라우저 요청 또는 이 키로 인증한 요청만 허용합니다.
        </p>
      </section>

      <section className="section" aria-labelledby="models-title">
        <SectionHead id="models-title" title="모델과 컨텍스트 용량">
          <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden="true" />} loading={models?.status === "loading"} onClick={onReloadModels}>
            다시 조회
          </Button>
        </SectionHead>
        {models?.status === "loading" ? <SkeletonRows count={1} /> : null}
        {models?.status === "error" ? (
          <Notice tone="danger" title={`GET /v1/models 실패${models.error.status ? ` (HTTP ${models.error.status})` : ""}`}>
            {models.error.message}
          </Notice>
        ) : null}
        {models?.status === "ready" ? (
          modelList.length > 0 ? (
            <dl className="kv">
              {modelList.map((model) => (
                <div key={model.id} className="kv__row">
                  <dt className="mono">{model.id}</dt>
                  <dd className="kv__value">
                    <span className="tabular">
                      <span className="strong">{tokenCount.format(model.context_window)}</span> 토큰
                    </span>
                    <StatusBadge tone={contextBasis[model.context_basis].tone}>{contextBasis[model.context_basis].label}</StatusBadge>
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="quiet">응답에 모델이 없습니다.</p>
          )
        ) : null}
        <p className="section-note">
          위 목록은 이 키로 실제 GET /v1/models를 호출한 결과이며, 모델마다 해당 공급자의 계정으로 실행됩니다. 용량은 클라이언트가 대화를 압축할 시점을 정하는 운용 권고값으로, dots2api나 공급자가
          토크나이저로 세어 강제하는 상한이 아닙니다. 출력·시스템 지시·도구 정의도 이 예산에 들어갑니다.
        </p>
        {bases.length > 0 ? <p className="section-note">{bases.map((basis) => contextBasis[basis].note).join(" ")}</p> : null}
      </section>

      <section className="section" aria-labelledby="curl-title">
        <SectionHead id="curl-title" title="curl로 호출" />
        <div className="stack">
          <CodeBlock caption={revealed ? "1. 환경 변수" : "1. 환경 변수 · 복사하면 실제 키가 들어갑니다"} code={envSnippet(revealed ? settings.apiKey : maskKey(settings.apiKey))} copyValue={envSnippet(settings.apiKey)} />
          <CodeBlock caption="2. 모델 목록" code={modelsSnippet} />
          <CodeBlock caption="3. Chat Completions" code={chatSnippet} />
          <CodeBlock caption="4. 이미지 생성 (한 장에 약 1분)" code={imageSnippet} />
        </div>
      </section>

      <section className="section" aria-labelledby="omo-title">
        <SectionHead id="omo-title" title="OmO 설정 예시" />
        {omoConfig ? (
          <CodeBlock caption="~/.omo/agent/models.json" code={omoConfig} />
        ) : (
          <p className="quiet">
            {models?.status === "ready" || models?.status === "error"
              ? "모델 목록이 없어 설정 예시를 만들 수 없습니다. 위에서 모델을 다시 조회하세요."
              : "모델 목록을 불러오면 이 키로 조회한 모델로 설정 예시를 만듭니다."}
          </p>
        )}
        <ul className="limits">
          <li>
            <strong>병합</strong> 기존 models.json의 providers 안에 dots2api 항목만 추가하세요. 파일 전체를 덮어쓰면 다른 공급자 설정이 사라집니다.
          </li>
          <li>
            <strong>API 키</strong> 예시에는 키를 넣지 않았습니다. OmO에서 /login dots2api를 실행하고 위 API 키를 입력하면 ~/.omo/agent/auth.json에 저장되며, models.json의 apiKey보다
            우선합니다. models.json에 두려면 "apiKey": "$DOTS2API_KEY"처럼 OmO가 실행되는 환경의 변수를 참조하세요. $ 없이 쓴 값은 문자 그대로 키로 보냅니다.
          </li>
          <li>
            <strong>모델 값</strong> id와 contextWindow는 위 /v1/models 응답의 id와 context_window입니다. contextWindow를 빼면 OmO 기본값 128,000이 적용됩니다.
            compat.supportsStrictMode: false는 도구 정의에 strict 필드를 보내지 않게 하며, input은 텍스트만, reasoning은 false입니다.
          </li>
        </ul>
      </section>

      <section className="section" aria-labelledby="limits-title">
        <SectionHead id="limits-title" title="동작 방식과 제약" />
        <ul className="limits">
          <li>
            <strong>응답 시간</strong> 원격 작업이 끝난 뒤 응답하며 최대 약 5분 걸릴 수 있습니다. 클라이언트 타임아웃을 넉넉하게 두세요.
          </li>
          <li>
            <strong>계정 선택</strong> 활성·준비됨·유휴 공급자 계정 중 가장 오래 쉰 계정이 실행합니다. 없으면 503(no_account)입니다.
          </li>
          <li>
            <strong>공급자 스위치</strong> 개요 화면의 공급자 스위치로 Dots나 Muse 전체를 끌 수 있습니다. 꺼진 공급자로는 새 작업이 가지 않고, 그 모델을 호출하면 503(provider_disabled)을 돌려줍니다. 이미 실행 중인 작업은 끝까지 진행됩니다.
          </li>
          <li>
            <strong>muse-agent 채팅</strong> model에 muse-agent를 쓰면 내 muse.ai 계정의 Muse 에이전트가 답합니다. 도구 호출은 지원하지 않아 tools를 보내면 400(unsupported_parameter)이며, Muse가 이미지로 답하면 저장된 이미지 링크가 답변에 들어갑니다.
          </li>
          <li>
            <strong>이미지 생성</strong> POST /v1/images/generations는 공급자에게 이미지를 만들어 달라고 요청한 뒤 받은 파일을 b64_json 또는 url로 돌려줍니다. model은 dots-image(내 Dot) 또는
            muse-image(내 muse.ai 계정)이며, 생략하면 dots-image입니다. n은 1~4이고 한 장씩 차례로 만들어 장당 약 1분 걸립니다. size와 quality는 공급자가 지키도록 말로 요청하는 참고값이라 결과 크기가
            다를 수 있습니다(응답의 size에 실제 크기, output_format에 실제 형식). 이미지 파일은 data/images에 남고 작업 상세에서 볼 수 있습니다.
          </li>
          <li>
            <strong>thread (Muse 사이드 챗)</strong> 이미지·채팅 요청에 본문 필드 thread 또는 헤더 X-Muse-Thread(1~64자, A-Z a-z 0-9 . _ : -)를 넣으면 같은 키의 Muse 사이드 챗을 다시 열어 이어 씁니다. 형식이 틀리면 400(invalid_thread)이며 user 필드는 쓰지 않고 Dots 모델에서는 무시합니다.
            키가 없으면 요청마다 새 사이드 챗을 씁니다. muse-image 사이드 챗은 같은 세션에 10분 동안 새 요청이 없으면 삭제되고(새 요청이 오면 10분이 다시 시작), muse-agent 채팅은 키가 없으면 작업이 성공한 직후 삭제하고 키가 있으면 7일 동안 쓰지 않을 때 삭제합니다.
          </li>
          <li>
            <strong>provider_busy</strong> Dots가 이미 다른 작업을 하는 중이면 dots-agent와 dots-image 요청은 대기열에 쌓지 않고 바로 409(provider_busy)로 거절합니다. 메시지에 안내된 muse-image 또는 muse-agent로 바꿔 다시 요청하세요.
          </li>
          <li>
            <strong>도구 호출</strong> tools와 tool_choice는 프롬프트 기반 JSON 브리지로 지원합니다. 원격 에이전트가 작성한 호출을 OpenAI tool_calls로 돌려주며 실행은 OmO 같은 클라이언트가
            합니다(X-Dots2api-Tools: prompted). 네이티브 제약 디코딩이 아니어서 strict: true인 도구는 422(unsupported_parameter)로 거절하고, 형식이 맞지 않는 원격 응답은 다시 보내지 않고
            502(invalid_tool_response)로 끝냅니다.
          </li>
          <li>
            <strong>제한 파라미터</strong> response_format은 강제할 수 없어 422(unsupported_parameter)로 거절합니다. max_tokens·max_completion_tokens는 받지만 참고값으로만 전달하며 출력 길이를
            강제하지 않습니다(X-Dots2api-Token-Limit: advisory).
          </li>
          <li>
            <strong>스트리밍</strong> stream: true는 작업이 끝난 뒤 결과 전체(도구 호출 포함)를 한 번에 SSE로 보냅니다. 토큰 단위 스트림이 아닙니다(X-Dots2api-Streaming: buffered).
          </li>
          <li>
            <strong>사용량</strong> 실제 토큰 수를 알 수 없어 JSON 응답과 버퍼링된 SSE 모두 usage를 보내지 않으며 X-Dots2api-Usage: unknown 헤더를 붙입니다.
          </li>
          <li>
            <strong>여러 메시지</strong> 역할 접두어를 붙인 하나의 프롬프트로 합쳐 원격 에이전트에 전달합니다.
          </li>
          <li>
            <strong>결과 불확실</strong> 완료를 확인하지 못하면 502(upstream_unconfirmed)를 반환하고 자동으로 다시 보내지 않습니다. X-Dots2api-Job-Id 헤더로
            작업 목록에서 확인하세요.
          </li>
          <li>
            <strong>Responses API</strong> /v1/responses는 지원하지 않습니다(422).
          </li>
        </ul>
      </section>
    </>
  );
}

export function ApiGuideView() {
  const [settings, setSettings] = useState<Loadable<Settings>>({ status: "loading" });
  const [models, setModels] = useState<Loadable<readonly ModelInfo[]> | null>(null);

  const loadModels = useCallback(async (apiKey: string): Promise<void> => {
    setModels({ status: "loading" });
    try {
      setModels({ status: "ready", value: await listModels(apiKey) });
    } catch (error) {
      setModels({ status: "error", error: await toApiError(error) });
    }
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setSettings({ status: "loading" });
    try {
      const value = await getSettings();
      setSettings({ status: "ready", value });
      void loadModels(value.apiKey);
    } catch (error) {
      setSettings({ status: "error", error: await toApiError(error) });
    }
  }, [loadModels]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <PageHeader
        title="API 안내"
        description="OpenAI 호환 /v1 엔드포인트를 Bearer 키로 호출하는 방법입니다. 각 요청은 원격 에이전트 작업으로 실행되어 작업 기록에도 남습니다."
      />
      {settings.status === "loading" ? <SkeletonRows count={2} /> : null}
      {settings.status === "error" ? (
        <Notice
          tone="danger"
          title="연결 정보를 불러오지 못했습니다"
          action={
            <Button size="sm" icon={<RefreshCw aria-hidden="true" />} onClick={() => void load()}>
              다시 시도
            </Button>
          }
        >
          {settings.error.message}
        </Notice>
      ) : null}
      {settings.status === "ready" ? (
        <Guide settings={settings.value} models={models} onReloadModels={() => void loadModels(settings.value.apiKey)} />
      ) : null}
    </div>
  );
}
