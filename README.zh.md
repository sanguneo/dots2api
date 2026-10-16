<p align="center">
  <img src="docs/assets/banner.svg" alt="dots2api — 为你自己的 Dot 提供聊天与图像生成" width="880">
</p>

<p align="center">
  <strong>在个人服务器上，通过兼容 OpenAI 的 HTTP API 使用你自己的 OpenAI Dot。</strong>
</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.1.0-b57920?style=flat-square" alt="版本 0.1.0"></a>
  <a href="install.sh"><img src="https://img.shields.io/badge/Bun-1.3%2B-1f6f78?style=flat-square" alt="Bun 1.3 及以上"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-28231f?style=flat-square" alt="MIT 许可证"></a>
</p>

<!-- README-I18N:START -->

[English](./README.md) | **中文** | [한국어](./README.ko.md)

<!-- README-I18N:END -->

**[dots2api](https://github.com/yelixir-dev/dots2api)**（"Dot to API"）是一个个人网关，把你自己的 OpenAI **Dot** 开放为聊天补全（含工具调用）和图像生成，并附带用于管理账号、任务记录和生成图像的 Web 控制台。它提供 **`dots-agent`**（聊天）和两个图像模型：**`dots-image`**（你的 Dot）与 **`muse-image`**（你自己的 muse.ai 账号）。

[功能](#功能) · [安装](#安装) · [使用](#使用) · [工作原理](#工作原理) · [仓库结构](#仓库结构) · [当前限制](#当前限制) · [许可证](#许可证)

## 功能

- **OpenAI 风格的聊天。** 用 `dots-agent` 调用 `POST /v1/chat/completions`；`tools` 和 `tool_choice` 通过基于提示词的 JSON 桥接工作，返回的调用由你的客户端（例如 OmO）执行。
- **图像生成。** 用 `dots-image` 或 `muse-image` 调用 `POST /v1/images/generations`，接受 `prompt`、`n`（1–4）、`size`、`quality` 和 `response_format`（`b64_json` 或 `url`）；文件只接受 PNG、JPEG 或 WebP，按文件签名判断，每张不超过 32 MiB。`dots-image` 在 Dot 上运行，`muse-image` 通过你自己的 muse.ai 账号在隔离的 Chrome 配置文件中生成（需要 Node.js 22 或更高版本与 Chromium），通常返回 WebP。
- **提供商与账号开关。** 每个账号都有自己的启用开关，每个提供商（Dots、Muse）还有一个总开关，在不改动已存凭据的情况下阻止新任务路由到它。每个账号还有一个**保持对话**开关，默认开启：开启时 Dots 账号一直使用同一个对话；关闭时每个任务都在新对话中运行并在结束后归档，因此一个任务的提示词和图像不会带到下一个任务。
- **不重复提交的自愈。** 丢失代理的 Dot 线程可在执行前重新绑定；Muse 在运行前续签会话并唤醒工作 VM。会话检查只能恢复认证，不能证明上次任务已经结束。已接受或接受状态不确定的请求不会自动再次发送；只有确认在执行前被拒绝的请求才可以重试。
- **Web 控制台。** 运行在回环地址上的 React 控制台，包含账号、任务、带图像预览的任务详情，以及显示本地 API 密钥和 OmO `models.json` 示例的 API 指南。
- **设备码登录。** 在 `auth.openai.com/codex/device` 批准，可以在另一台电脑上完成；令牌只保存在服务器上，使用 AES-256-GCM 加密，并在到期前 60 秒刷新。
- **每个账号同时只执行一个任务，且按顺序执行。** 忙碌账号收到的新任务会以 `queued` 接受，并在当前任务结束后开始，因此并发请求不会共用同一个 Dot 线程；登录或检查占用账号时返回 `409 account_busy`，队列已满返回 `429 queue_full`，没有可用账号返回 `503`。
- **仅限回环地址。** 服务器只绑定 `127.0.0.1`，`/v1` 端点需要 Bearer API 密钥。

除了每个账号 20 个任务的限制，保留的任务输入还共享 128 MiB 配额（UTF-16 提示词字节和参考图像字节之和）。可用 `DOTS2API_QUEUE_BYTES` 按字节配置，最小 40 MiB；不足时在分配副本前返回 `429 queue_bytes_full`。这不是进程 RSS 上限，配置服务内存限制时还须预留浏览器、输出图像和编码副本的空间。关闭时停止接收新任务，等待已接收任务清理并持久化后再关闭 SQLite。由于无法保证提供商的编码格式，显式 `output_format` 返回 422；省略该字段则返回实际 PNG/JPEG/WebP 格式。

## 安装

需要带用户级 systemd 的 Linux 和 Bun 1.3 或更高版本。安装脚本不需要 root，不做构建，只安装运行时依赖。

```bash
git clone https://github.com/yelixir-dev/dots2api.git
cd dots2api
./install.sh --port 3010
```

安装脚本会把程序复制到 `~/.local/share/dots2api/app`，把数据放在 `~/.local/share/dots2api/data`，并启用名为 `dots2api` 的用户服务。再次运行只会更新程序并重启服务，不会动数据。如果在服务器上不保持登录，请运行一次 `sudo loginctl enable-linger "$USER"`，让服务持续运行。

若要直接从源码目录运行：

```bash
bun install
bun run start
```

打开 `http://127.0.0.1:3010`。可通过 `PORT` 和 `DOTS2API_DATA_DIR` 修改端口和数据目录。

```bash
PORT=3011 DOTS2API_DATA_DIR=/absolute/path/to/dots2api-data bun run start
```

在远程（无界面）服务器上，请先从你自己的电脑转发端口，再在本机打开 `http://127.0.0.1:3010`。

```bash
ssh -N -L 3010:127.0.0.1:3010 user@server
```

### 数据

- `dots2api.sqlite`：账号元数据、任务和本地 API 密钥。如果存在旧的 `bot2api.sqlite`，首次启动时会改用这个名称，其中的 **Grok Bot 账号、任务、图像会被删除**；Muse 与 Dots 数据会保留。
- `master.key`：凭据加密密钥。必须和数据库一起保管，否则无法恢复账号。
- `images/`：生成的图像，不会自动清理。
- `logs/muse-worker.log`：每次 Muse 工作进程运行记录一行不含凭据的信息（结果，失败时附截断的浏览器错误尾部），超过 256 KiB 时清空。
- 提示词、结果和图像可能包含敏感内容；请不要共享数据目录，也不要放进 Git。

## 使用

### 连接 Dot

1. 在控制台打开 **账号 → 添加账号**，输入标签和**现有的 Dot**（访问 `https://chatgpt.com/dots`，打开想用的 Dot，然后粘贴地址栏中的地址 `https://chatgpt.com/dots/<ID>`；只填 ID 也可以），然后点击**开始**。这一步会创建账号并同时开始设备登录。
2. 打开显示的 ChatGPT 链接（`auth.openai.com/codex/device`）并批准一次性代码。浏览器可以在与服务器不同的电脑上。控制台会轮询批准结果并自动完成连接，无需再点击。
3. dots2api 从不创建线程，除非线程报告 `threadSource: aeon`，否则拒绝连接。如果在连接成功前取消，创建了一半的账号会被删除。

令牌绝不会返回给浏览器。如果刷新被撤销或结果未知，请重新登录。**不要与 Codex CLI 或其他工具共用同一个 refresh token。** 已有账号仍可通过其**登录**按钮重新登录。完整约定见 [`src/dots-auth/README.md`](src/dots-auth/README.md)。

### 连接 Muse 账号

Muse 没有官方 OAuth 应用，因此通过保持 muse.ai 的登录会话来连接。在控制台选择 **账号 → 添加账号 → Muse** 并输入标签，下面的远程浏览器会直接打开。Cookie 字段仅作为编辑账号时的高级备用项保留。

- **远程浏览器（默认，无头服务器也可用）。** 添加 Muse 账号时会直接启动；已有账号可点开 **登录 → 启动远程浏览器**。服务器会在专用虚拟显示（Xvfb）上打开真正的 Chromium，并把画面实时传到控制台，画面太小时可用 **放大查看** 铺满窗口，在其中完成 Google 登录后点击 **完成登录并检查连接**。查看器走控制台自己的端口，无需额外的 SSH 隧道。
  在新的无头服务器（例如 Oracle Cloud）上，用 root 安装一次这两个依赖：
  ```bash
  sudo apt install -y xvfb        # Debian/Ubuntu；Oracle Linux 用：sudo dnf install -y xorg-x11-server-Xvfb
  bunx playwright install --with-deps chromium
  ```
  `--with-deps` 会一并安装 Chromium 的共享库。如果服务的 `PATH` 里没有 `Xvfb`，请调整 `PATH` 或安装到 `/usr/bin`（启动器用 `Bun.which("Xvfb")` 查找）。
- **导入 Cookie。** 在你自己的浏览器登录 muse.ai，打开 DevTools → Network，选一个 `muse.ai` 请求，打开账号的 **编辑 → 高级：手动输入凭据**，把它的 `Cookie` 请求头粘贴到 **Cookie header**（或把导出的 cookie JSON 粘到 **Cookies JSON**），然后点 **保存并检查**。

两种方式都会把续期后的会话 Cookie 写回账号，Muse 自愈会在每次任务前续签会话并唤醒工作 VM。

每个 `muse-image` 任务都会新开一个 Muse 线程，Muse 应用会把它保留为以提示词为标题的侧边聊天。在控制台关闭账号的**保持对话**开关，任务成功后会删除该侧边聊天。删除无法撤销，因此默认开启（保留）；它只删除 Muse 标记为当前打开线程的那一行，失败或结果不确定的任务会保留其侧边聊天。是否删除只由这个开关决定，旧的 `DOTS2API_MUSE_PRUNE_THREADS` 环境变量已不再读取。

### 聊天

在控制台的 **API 指南**中查看你的 API 密钥，然后：

```bash
export DOTS2API_KEY='the key shown in the console'
curl http://127.0.0.1:3010/v1/models -H "Authorization: Bearer $DOTS2API_KEY"
```

```bash
curl http://127.0.0.1:3010/v1/chat/completions \
  -H "Authorization: Bearer $DOTS2API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"dots-agent","messages":[{"role":"user","content":"Introduce yourself in one line."}]}'
```

- 工作上下文预算为 **272,000 个令牌**。这是指定值而非测量值，会作为 `context_window` 出现在 `/v1/models` 中。输出、系统指令和工具定义都要计入其中。
- 工具调用是基于提示词的 JSON 桥接，不是原生工具 API（`X-Dots2api-Tools: prompted`）。`strict: true`、`response_format` 和 `/v1/responses` 返回 422。2026-10-04 这种桥接的工具往返 3 次全部成功，样本很小。
- `stream: true` 会在任务完成后以 SSE 一次性发送结果（`X-Dots2api-Streaming: buffered`）。令牌数未知，因此不生成 `usage`（`X-Dots2api-Usage: unknown`），`max_tokens` 仅供参考。
- 每个响应都带有 `X-Dots2api-Job-Id`；用 `GET /api/jobs/:id` 查询对应任务。

### 图像生成

```bash
curl -sS http://127.0.0.1:3010/v1/images/generations \
  -H "Authorization: Bearer $DOTS2API_KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"a silver sports car on a beach, photorealistic, golden hour","size":"1536x1024","quality":"high"}' \
  | jq -r '.data[0].b64_json' | base64 -d > out.png
```

- 请求：`prompt`（必填）、`n`（1–4，默认 1）、`size`（`auto`、`1024x1024`、`1536x1024`、`1024x1536`）、`quality`（`auto`、`low`、`medium`、`high`）、`response_format`（默认 `b64_json`，或 `url`）。其他字段会返回 400。
- 响应：OpenAI 格式的 `data[]`（`b64_json` 或 `url`，以及 Dot 实际使用的 `revised_prompt`）、`output_format: "png"` 和真实的 `size`。`url` 指向 `GET /api/jobs/:id/images/0`，并且**需要 API 密钥**。
- 生成一张图大约需要一分钟，`n` 张图在同一个 Dot 线程中依次生成。如果最后几张失败，已完成的图像会照常返回，`X-Dots2api-Images-Requested` 和 `X-Dots2api-Images-Returned` 响应头会说明数量。
- 参考图像编辑使用 `dots-image` 或 `muse-image`，通过 multipart 上传调用 `POST /v1/images/edits`：

```bash
curl -sS http://127.0.0.1:3010/v1/images/edits \
  -H "Authorization: Bearer $DOTS2API_KEY" \
  -F model=dots-image -F 'image=@reference.png' \
  -F 'prompt=Keep the subject, replace the background with a beach' \
  -F response_format=b64_json
```

- 通过 `image` 或 `image[]` 提供 1–8 张 PNG/JPEG/WebP，图像总大小不超过 32 MiB（multipart 请求体上限 33 MiB）。格式按文件签名判断。其他选项和响应与生成接口相同。`dots-image` 通过独立的 app-server 图像输入传递参考图像，不嵌入提示词；`muse-image` 通过 Muse 输入框上传，只有在输入框把每张参考图都显示为已附加（每张都有预览和移除按钮，且发送按钮已启用）之后才发送提示词。否则任务会在发送任何内容之前以 `muse_attachment`（502）失败，而不是在没有参考图的情况下执行编辑。参考图像不会保存到任务历史中。
- 不支持蒙版、变体或 JSON 图像 URL。2026-10-10 已用真实 Dot 验证过一次：对带红色圆形的参考图只要求更换背景，约 45 秒返回 200，圆形保持不变，只有背景被替换。同一天也用真实 Muse 验证过一次：参考图包含偏心红圆、蓝色三角形和黑色长条，约 55 秒返回 200，圆和长条的中心偏差在 3% 以内、尺寸偏差在 4% 以内，只有背景被替换。

### 任务 API

用 `POST /api/jobs {"provider":"dots","prompt":"..."}` 异步提交长任务，再用 `GET /api/jobs/:id` 轮询。账号忙碌时提交的任务在轮到自己之前报告 `status: "queued"`。连接状态变化时，`GET /api/events` 会通过 SSE 推送 `change` 事件。

## 工作原理

1. 客户端带着 Bearer 密钥调用 `/v1/...`，或者控制台从同一来源调用 `/api/...`。
2. 网关选择一个已启用且当前没有任务在运行的账号；若账号忙碌，则把新任务排队，等当前任务结束后执行。
3. Dots provider 连接 `wss://codex-cloud-backend.chatgpt.com`，在你现有的 Aeon 线程上使用 Codex 客户端所用的 app-server JSON-RPC。
4. 任务及其状态保存在 SQLite 中。
5. 聊天输出以 OpenAI JSON 或 SSE 返回；图像会按文件签名检查，并保存到 `images/<job id>/`。
6. 超时或重启后远端结果未知时，任务标记为 `unknown`，绝不会自动重发。

## 仓库结构

```text
src/providers/dots.ts  Dot connection, turns, image receipt
src/dots-auth/         device login and token refresh
src/gateway.ts         account choice, per-account concurrency, job state
src/store.ts           SQLite persistence and encryption
src/api.ts             HTTP endpoints (src/images-api.ts for images)
src/web/               React console (DESIGN.md is its design contract)
```

### 开发

```bash
bun run dev
bun run typecheck
bun test
```

测试使用 fixture，从不连接真实的 Dot。登录、工具往返和图像生成于 2026-10-04 用真实账号单独检查过，包括打开了 15 张以上收到的 PNG 文件，但这不能保证之后服务的变化或额度影响。

## 当前限制

- **非官方途径。** Dots 没有公开的模型 API。dots2api 使用 `wss://codex-cloud-backend.chatgpt.com` 的 app-server JSON-RPC，并发送标识为 Codex 客户端的 `User-Agent` 和 `originator` 请求头。OpenAI 可能更改或封锁这条路径，条款或账号限制的风险由你自己承担；如果无法接受，请不要使用。
- **仅限个人使用。** 它为你自己的一个或几个 Dot 账号而设计，没有用户隔离、速率限制或计费，也不能防护能读取本地文件的进程。请不要向他人提供服务，也不要转售账号。
- **图像设置仅供参考。** 尺寸和质量由 Dot 自己决定，所以 `size` 和 `quality` 只是用文字提出请求；观察到的尺寸有 1254×1254 和 1536×1024。只回复文字时返回 502（`image_not_generated`），图像如何计入额度尚未确认，批量生成前请先确认额度。
- **没有用量数据。** 聊天是缓冲返回而非逐令牌流式，也不报告 `usage`；据说 Dot 聊天不计入 ChatGPT 额度，但存在深度工作的额度限制。

## 许可证

MIT。见 [LICENSE](LICENSE)。

---

<p align="center"><em>dots2api — 为你自己的 Dot 打造的个人网关。</em></p>
