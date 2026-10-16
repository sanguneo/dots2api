<p align="center">
  <img src="docs/assets/banner.svg" alt="dots2api — 내 Dot을 위한 채팅과 이미지 생성" width="880">
</p>

<p align="center">
  <strong>내 OpenAI Dot을 개인 서버의 OpenAI 호환 HTTP API로 씁니다.</strong>
</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.1.0-b57920?style=flat-square" alt="버전 0.1.0"></a>
  <a href="install.sh"><img src="https://img.shields.io/badge/Bun-1.3%2B-1f6f78?style=flat-square" alt="Bun 1.3 이상"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-28231f?style=flat-square" alt="MIT 라이선스"></a>
</p>

<!-- README-I18N:START -->

[English](./README.md) | [中文](./README.zh.md) | **한국어**

<!-- README-I18N:END -->

**[dots2api](https://github.com/yelixir-dev/dots2api)**("Dot to API")는 내 OpenAI **Dot**을 채팅(`chat/completions`, 도구 호출 포함)과 이미지 생성으로 열어 주는 개인용 게이트웨이이며, 계정·작업 기록·생성한 이미지를 관리하는 웹 콘솔이 함께 있습니다. 모델 ID는 **`dots-agent`**(채팅)와 이미지 모델 **`dots-image`**(내 Dot), **`muse-image`**(내 muse.ai 계정)입니다.

[기능](#기능) · [설치](#설치) · [사용법](#사용법) · [동작 방식](#동작-방식) · [저장소 구조](#저장소-구조) · [현재 한계](#현재-한계) · [라이선스](#라이선스)

## 기능

- **OpenAI 방식 채팅.** `dots-agent`로 `POST /v1/chat/completions`를 호출하며, `tools`와 `tool_choice`는 프롬프트 기반 JSON 브리지로 동작하고 반환된 호출은 클라이언트(예: OmO)가 실행합니다.
- **이미지 생성.** `dots-image` 또는 `muse-image`로 `POST /v1/images/generations`를 호출하며 `prompt`, `n`(1~4), `size`, `quality`, `response_format`(`b64_json` 또는 `url`)을 받고, 파일은 서명으로 판별해 PNG/JPEG/WebP만 장당 32 MiB 이하로 받습니다. `dots-image`는 Dot이, `muse-image`는 격리된 Chrome 프로파일에서 내 muse.ai 계정이 생성하며(Node.js 22 이상과 Chromium 필요) 보통 WebP를 돌려줍니다.
- **공급자·계정 스위치.** 계정마다 자체 활성 스위치가 있고, 공급자(Dots, Muse)마다 저장된 자격 증명은 그대로 둔 채 새 작업이 그 공급자로 가지 않게 하는 상위 스위치가 있습니다. 계정마다 **대화 유지** 스위치도 있으며 기본은 켜짐입니다. 켜 두면 Dots 계정은 대화 하나를 계속 쓰고, 끄면 작업마다 새 대화를 열고 끝나면 보관하므로 한 작업의 프롬프트와 이미지가 다음 작업에 남지 않습니다.
- **중복 제출 없는 자가 복구.** 에이전트를 잃은 Dot 스레드는 실행 전에 새 스레드로 다시 묶을 수 있고, Muse는 실행 전에 세션 갱신과 작업 VM 깨우기를 수행합니다. 세션 재확인은 인증 복구일 뿐 이전 작업의 완료 확인이 아닙니다. 수락됐거나 수락 여부가 불확실한 요청은 자동으로 다시 보내지 않으며, 실행 전 거절이 확인된 경우에만 재시도합니다.
- **웹 콘솔.** 루프백에서 열리는 React 콘솔로 계정, 작업, 이미지 미리보기가 있는 작업 상세, 로컬 API 키와 OmO `models.json` 예시를 보여 주는 API 안내를 제공합니다.
- **기기 인증 로그인.** `auth.openai.com/codex/device`에서 승인하며 다른 컴퓨터의 브라우저도 됩니다. 토큰은 서버에만 두고 AES-256-GCM으로 암호화하며 만료 60초 전에 갱신합니다.
- **계정당 작업 하나, 순서대로.** 같은 계정에 들어온 다음 작업은 `queued`로 접수되어 앞선 작업이 끝나면 이어서 실행되므로 동시 요청이 한 Dot 스레드를 나눠 쓰지 않습니다. 로그인·연결 확인이 계정을 잡고 있으면 `409 account_busy`, 대기열이 가득 차면 `429 queue_full`, 쓸 수 있는 계정이 없으면 `503`입니다.
- **루프백 전용.** 서버는 `127.0.0.1`에만 바인딩하고 `/v1` 엔드포인트는 Bearer API 키가 필요합니다.

보유 중인 작업 입력에는 계정별 20개 제한 외에 전체 128 MiB 예산이 적용됩니다(UTF-16 프롬프트 바이트와 참조 이미지 바이트 합계). `DOTS2API_QUEUE_BYTES`로 바이트 단위 변경이 가능하며 최소 40 MiB입니다. 예산이 부족하면 복사본을 만들기 전에 `429 queue_bytes_full`로 거절합니다. 이는 브라우저·출력 이미지·인코딩 복사본까지 포함한 프로세스 메모리 상한이 아니므로 서비스 메모리 설정에 여유를 두어야 합니다. 종료 시 새 접수를 막고 접수된 작업을 정리한 뒤 SQLite를 닫습니다. 명시적 `output_format`은 공급자 형식을 보장할 수 없어 422로 거절하며, 생략하면 실제 PNG/JPEG/WebP 형식으로 반환합니다.

## 설치

사용자 systemd가 있는 Linux와 Bun 1.3 이상이 필요합니다. 설치 스크립트는 루트 권한이 필요 없고 빌드 없이 런타임 의존성만 설치합니다.

```bash
git clone https://github.com/yelixir-dev/dots2api.git
cd dots2api
./install.sh --port 3010
```

설치 스크립트는 프로그램을 `~/.local/share/dots2api/app`에 복사하고, 데이터는 `~/.local/share/dots2api/data`에 두며, `dots2api`라는 사용자 서비스를 켭니다. 다시 실행하면 데이터는 건드리지 않고 프로그램만 갱신해 서비스를 재시작합니다. 로그인해 두지 않는 서버에서는 서비스가 계속 돌도록 `sudo loginctl enable-linger "$USER"`를 한 번 실행하세요.

설치 대신 소스 체크아웃에서 바로 실행하려면 다음과 같이 합니다.

```bash
bun install
bun run start
```

`http://127.0.0.1:3010`을 엽니다. 포트는 `PORT`, 데이터 경로는 `DOTS2API_DATA_DIR`로 바꿉니다.

```bash
PORT=3011 DOTS2API_DATA_DIR=/absolute/path/to/dots2api-data bun run start
```

원격(헤드리스) 서버라면 내 컴퓨터에서 포트를 포워딩한 뒤 그쪽에서 `http://127.0.0.1:3010`을 여세요.

```bash
ssh -N -L 3010:127.0.0.1:3010 user@server
```

### 데이터

- `dots2api.sqlite`: 계정 메타데이터, 작업, 로컬 API 키. 이전 `bot2api.sqlite`가 있으면 처음 실행할 때 이 이름으로 옮기고, 그 안의 **Grok Bot 계정·작업·이미지는 삭제**하며 Muse·Dots 데이터는 유지합니다.
- `master.key`: 자격 증명 암호화 키. DB와 함께 보관해야 계정을 복원할 수 있습니다.
- `images/`: 생성한 이미지이며 자동 삭제는 없습니다.
- `logs/muse-worker.log`: Muse 워커 실행마다 인증값이 없는 한 줄(결과, 실패하면 잘라 낸 브라우저 오류 끝부분)을 남기며, 256 KiB를 넘으면 비웁니다.
- 프롬프트와 결과, 이미지도 민감할 수 있으니 데이터 디렉터리를 공유하거나 Git에 넣지 마세요.

## 사용법

### Dot 연결

1. 콘솔의 **계정 → 계정 추가**에서 라벨과 **기존 Dot**(`https://chatgpt.com/dots`에 접속해 사용할 Dot을 연 뒤 주소창의 주소 `https://chatgpt.com/dots/<ID>`를 붙여넣습니다. ID만 넣어도 됩니다)을 입력하고 **연결 시작**을 누릅니다. 계정 추가와 기기 인증 시작이 한 번에 이루어집니다.
2. 표시된 ChatGPT 링크(`auth.openai.com/codex/device`)를 열고 일회용 코드를 승인합니다. 브라우저는 서버가 아닌 다른 컴퓨터에 있어도 됩니다. 콘솔이 승인 여부를 확인하다가 스스로 연결을 마치므로 더 누를 것이 없습니다.
3. dots2api는 스레드를 새로 만들지 않으며 `threadSource: aeon`이 확인되지 않으면 연결하지 않습니다. 연결 전에 취소하면 만들다 만 계정은 삭제됩니다.

토큰은 브라우저에 돌려주지 않습니다. 갱신이 철회되었거나 결과를 확인하지 못하면 다시 로그인하세요. **같은 refresh token을 Codex CLI 등 다른 곳과 공유하지 마세요.** 이미 있는 계정은 **로그인** 버튼으로 다시 로그인할 수 있습니다. 자세한 계약은 [`src/dots-auth/README.md`](src/dots-auth/README.md)에 있습니다.

### Muse 계정 연결

Muse는 공식 OAuth 앱이 없어 muse.ai에 로그인한 세션을 유지하는 방식으로 연결합니다. 콘솔에서 **계정 → 계정 추가 → Muse**를 고르고 라벨을 입력하면 아래 원격 브라우저가 바로 열립니다. 쿠키 입력 칸은 계정 편집의 고급 항목으로만 남아 있습니다.

- **원격 브라우저(기본, 헤드리스 서버에서도 동작).** Muse 계정을 추가하면 바로 시작되고, 이미 있는 계정은 **로그인 → 원격 브라우저 시작**을 누르면 서버가 전용 가상 화면(Xvfb)에 실제 Chromium을 띄우고 그 화면을 콘솔로 실시간 전송합니다. 화면이 작으면 **크게 보기**로 창 전체에 띄운 뒤, 그 화면에서 Google 로그인을 마치고 **로그인 완료 및 연결 확인**을 누르세요. 뷰어는 콘솔과 같은 포트로 흘러 추가 SSH 터널이 필요 없습니다.
  새 헤드리스 서버(예: Oracle Cloud)에서는 두 의존성을 루트로 한 번 설치하세요.
  ```bash
  sudo apt install -y xvfb        # Debian/Ubuntu; Oracle Linux는: sudo dnf install -y xorg-x11-server-Xvfb
  bunx playwright install --with-deps chromium
  ```
  `--with-deps`가 Chromium의 공유 라이브러리까지 받아 줍니다. 서비스 `PATH`에 `Xvfb`가 없으면 `PATH`를 맞추거나 `/usr/bin`에 설치하세요(런처는 `Bun.which("Xvfb")`로 찾습니다).
- **쿠키 가져오기.** 본인 브라우저에서 muse.ai에 로그인한 뒤 DevTools → Network에서 `muse.ai` 요청을 골라 계정의 **편집 → 고급: 인증값 직접 입력**을 열어 `Cookie` 요청 헤더를 **Cookie header**에 붙여넣거나, 내보낸 쿠키 JSON을 **Cookies JSON**에 넣고 **저장하고 확인**을 누릅니다.

두 방식 모두 갱신된 세션 쿠키를 계정에 다시 저장하며, 매 작업 전에 Muse 자가복구가 세션을 갱신하고 작업 VM을 깨웁니다.

`muse-image` 작업은 매번 새 Muse 스레드를 열고, Muse 앱은 이를 프롬프트를 제목으로 한 사이드 챗으로 남깁니다. 콘솔에서 계정의 **대화 유지** 스위치를 끄면 작업이 성공한 뒤 그 사이드 챗을 삭제합니다. 삭제는 되돌릴 수 없어 기본값은 켜짐(유지)이며, Muse가 현재 열린 스레드로 표시한 행 하나만 지웁니다. 실패하거나 결과가 불확실한 작업의 사이드 챗은 남습니다. 삭제 여부는 이 스위치만으로 정하며, 예전 `DOTS2API_MUSE_PRUNE_THREADS` 환경변수는 더 이상 읽지 않습니다.

### 채팅

콘솔의 **API 안내**에서 API 키를 확인한 뒤 호출합니다.

```bash
export DOTS2API_KEY='the key shown in the console'
curl http://127.0.0.1:3010/v1/models -H "Authorization: Bearer $DOTS2API_KEY"
```

```bash
curl http://127.0.0.1:3010/v1/chat/completions \
  -H "Authorization: Bearer $DOTS2API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"dots-agent","messages":[{"role":"user","content":"Introduce yourself in one line."}]}'
```

- 컨텍스트 운용값은 **272,000토큰**입니다. 지정값이며 측정치가 아니고 `/v1/models`의 `context_window`로 나옵니다. 출력, 시스템 지시, 도구 정의도 이 예산에 포함하세요.
- 도구 호출은 프롬프트 기반 JSON 브리지이며 네이티브 도구 API가 아닙니다(`X-Dots2api-Tools: prompted`). `strict: true`, `response_format`, `/v1/responses`는 422입니다. 2026-10-04에 이 방식의 도구 왕복이 3/3 성공했으나 표본이 작습니다.
- `stream: true`는 작업이 끝난 뒤 결과를 SSE로 한 번에 보냅니다(`X-Dots2api-Streaming: buffered`). 토큰 수를 알 수 없어 `usage`를 만들지 않으며(`X-Dots2api-Usage: unknown`), `max_tokens`는 참고값입니다.
- 모든 응답의 `X-Dots2api-Job-Id`로 `GET /api/jobs/:id`에서 작업 기록을 찾을 수 있습니다.

### 이미지 생성

```bash
curl -sS http://127.0.0.1:3010/v1/images/generations \
  -H "Authorization: Bearer $DOTS2API_KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"a silver sports car on a beach, photorealistic, golden hour","size":"1536x1024","quality":"high"}' \
  | jq -r '.data[0].b64_json' | base64 -d > out.png
```

- 요청: `prompt`(필수), `n`(1~4, 기본 1), `size`(`auto`, `1024x1024`, `1536x1024`, `1024x1536`), `quality`(`auto`, `low`, `medium`, `high`), `response_format`(`b64_json` 기본 / `url`). 그 밖의 필드는 400입니다.
- 응답: OpenAI 형식의 `data[]`(`b64_json` 또는 `url`, Dot이 실제로 쓴 `revised_prompt`), `output_format: "png"`, 실제 `size`. `url`은 `GET /api/jobs/:id/images/0` 주소이며 **API 키가 필요**합니다.
- 한 장에 약 1분이 걸리고, `n`장은 같은 Dot 스레드에서 한 장씩 차례로 만듭니다. 마지막까지 못 만들면 이미 만든 장은 돌려주고 `X-Dots2api-Images-Requested`와 `X-Dots2api-Images-Returned` 헤더로 알립니다.
- 참조 이미지 편집은 `dots-image` 또는 `muse-image`와 multipart 업로드로 `POST /v1/images/edits`를 호출합니다:

```bash
curl -sS http://127.0.0.1:3010/v1/images/edits \
  -H "Authorization: Bearer $DOTS2API_KEY" \
  -F model=dots-image -F 'image=@reference.png' \
  -F 'prompt=Keep the subject, replace the background with a beach' \
  -F response_format=b64_json
```

- `image` 또는 `image[]`로 PNG/JPEG/WebP 1~8장을 전달하며 이미지 전체 합계는 32 MiB 이하입니다(multipart 본문 한도 33 MiB). 파일 시그니처로 형식을 판별합니다. 다른 옵션과 응답은 생성 API와 같습니다. `dots-image`는 참조 이미지 바이트를 프롬프트 문자열이 아닌 별도 app-server 이미지 입력으로 전송하고, `muse-image`는 Muse 컴포저로 업로드하고, 컴포저가 모든 참조 이미지를 첨부 완료로 표시한 뒤에만 프롬프트를 보냅니다(이미지마다 미리보기와 삭제 버튼이 생기고 전송 버튼이 활성화됨). 그렇게 되지 않으면 참조 없이 편집하지 않고, 아무것도 보내기 전에 작업을 `muse_attachment`(502)로 실패시킵니다. 참조 이미지 바이트는 작업 기록에 저장하지 않습니다.
- 마스크, 변형, JSON 이미지 URL은 지원하지 않습니다. 2026-10-10에 실제 Dot으로 한 번 확인했습니다. 빨간 원이 있는 참조 이미지에 배경만 바꿔 달라고 하자 약 45초 만에 200을 돌려주었고, 원은 그대로 두고 배경만 바꿨습니다. 같은 날 실제 Muse로도 한 번 확인했습니다. 중심에서 벗어난 빨간 원, 파란 삼각형, 검은 막대가 든 참조 이미지로 요청하자 약 55초 만에 200을 돌려주었고, 원과 막대는 중심 3%·크기 4% 이내로 유지된 채 배경만 바뀌었습니다.

### 작업 API

긴 작업은 `POST /api/jobs {"provider":"dots","prompt":"..."}`로 비동기 전송하고 `GET /api/jobs/:id`로 확인합니다. 계정이 작업 중일 때 접수된 작업은 순서가 오기 전까지 `status: "queued"`로 보고됩니다. 연결 상태가 바뀌면 `GET /api/events`가 SSE `change` 이벤트로 알려 줍니다.

## 동작 방식

1. 클라이언트가 Bearer 키로 `/v1/...`을 부르거나, 콘솔이 같은 출처에서 `/api/...`를 부릅니다.
2. 게이트웨이가 이미 작업 중이 아닌, 켜져 있는 계정을 고릅니다. 작업 중인 계정으로 들어온 작업은 대기열에 넣어 앞선 작업이 끝난 뒤 실행합니다.
3. Dots provider가 `wss://codex-cloud-backend.chatgpt.com`에 연결해 Codex 클라이언트가 쓰는 app-server JSON-RPC로 내 기존 Aeon 스레드와 통신합니다.
4. 작업과 그 상태는 SQLite에 저장됩니다.
5. 채팅 결과는 OpenAI JSON이나 SSE로 돌려주고, 이미지는 파일 서명을 확인해 `images/<작업 ID>/`에 저장합니다.
6. 타임아웃이나 재시작으로 원격 실행 여부를 알 수 없으면 작업을 `unknown`으로 표시하고 자동으로 다시 보내지 않습니다.

## 저장소 구조

```text
src/providers/dots.ts  Dot connection, turns, image receipt
src/dots-auth/         device login and token refresh
src/gateway.ts         account choice, per-account concurrency, job state
src/store.ts           SQLite persistence and encryption
src/api.ts             HTTP endpoints (src/images-api.ts for images)
src/web/               React console (DESIGN.md is its design contract)
```

### 개발

```bash
bun run dev
bun run typecheck
bun test
```

테스트는 fixture 기반이라 실제 Dot에 접속하지 않습니다. 로그인, 도구 왕복, 이미지 생성은 2026-10-04에 실제 계정으로 따로 확인했고 받은 PNG 15장 이상을 열어 봤지만, 이후의 서비스 변경이나 한도 차감까지 보장하지는 않습니다.

## 현재 한계

- **비공식 경로입니다.** Dots에는 공개 모델 API가 없어서 dots2api는 `wss://codex-cloud-backend.chatgpt.com`의 app-server JSON-RPC를 쓰고 Codex 클라이언트로 식별하는 `User-Agent`와 `originator` 헤더를 보냅니다. OpenAI가 이 경로를 바꾸거나 막을 수 있고 약관이나 계정 제한 위험은 사용자가 감수해야 하니, 받아들일 수 없으면 쓰지 마세요.
- **개인용입니다.** 내 Dot 계정 하나 또는 몇 개를 쓰는 용도이며 사용자 구분, 요청 제한, 과금이 없고 로컬 파일을 읽을 수 있는 프로세스로부터 비밀을 지키는 금고도 아닙니다. 다른 사람에게 서비스하거나 계정을 재판매하지 마세요.
- **이미지 설정은 참고값입니다.** 크기와 품질은 Dot이 직접 정하므로 `size`와 `quality`는 말로 요청할 뿐이며 관찰한 크기는 1254×1254와 1536×1024였습니다. 글로만 답하면 502(`image_not_generated`)이고 이미지가 한도에서 어떻게 계산되는지는 확인하지 못했으니 대량 생성 전에 한도를 확인하세요.
- **사용량 수치가 없습니다.** 채팅은 토큰 단위 스트리밍이 아니라 버퍼링되고 `usage`도 만들지 않으며, Dot 대화는 ChatGPT 한도에 포함되지 않는다고 알려져 있으나 심층 작업 한도는 있습니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 보세요.

---

<p align="center"><em>dots2api — 내 Dot을 위한 개인용 게이트웨이.</em></p>
