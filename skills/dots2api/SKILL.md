---
name: dots2api
description: Chat with your own Dots or Muse account, continue a named Muse conversation, generate images, edit with reference images, and download returned images/files through a dots2api gateway. Use for dots-agent, muse-agent, dots-image, muse-image, dots2api, Dots/Muse conversation, or installing an optional Telegram bot relay.
compatibility: Requires Bun and a dots2api server with the user's own connected account and API key. The installed client is bundled; no Node packages or private endpoints are needed.
---

# dots2api

Use the bundled client for both conversation and images. Resolve `scripts/client.js`
relative to this skill's directory. Read `references/setup.md` when no server or key
is configured, or when the user wants their own server or Telegram bot.

## First use

Never guess credentials or use another person's server. The default address is
`http://127.0.0.1:3010`. Configure the user's server and API key file:

```bash
bun "<skill-dir>/scripts/client.js" configure --base-url http://127.0.0.1:3010 --key-file "/private/dots2api-key.txt"
bun "<skill-dir>/scripts/client.js" models
```

Configuration lives outside the skill under `~/.config/dots2api/client.json`
(or `$XDG_CONFIG_HOME/dots2api/client.json`). It stores the address and key-file
path, never the key. `DOTS2API_API_KEY`, `DOTS2API_BASE_URL`, and `DOTS2API_KEY_FILE`
can override saved settings; `--config`, `--base-url`, and `--key-file` are also available.
Do not print, commit, send in a chat, or include the key in a command-line argument.

## Conversation

```bash
bun "<skill-dir>/scripts/client.js" chat --model muse-agent --session research-1 --prompt "Help me compare these approaches."
bun "<skill-dir>/scripts/client.js" chat --model muse-agent --session research-1 --prompt "Expand the second approach." --save-dir ./answers
bun "<skill-dir>/scripts/client.js" chat --model dots-agent --prompt-file ./question.txt
```

- Use a stable, distinct `--session` key for each Muse conversation (1-64 ASCII
  letters, digits, `.`, `_`, `:`, `-`). Reuse it to continue; change it to start
  another topic. Muse's server-side conversation can expire after inactivity.
- Dots talks to the connected account's primary Dot conversation. It does not
  provide isolated topics through `--session`.
- Output is JSON containing `text` and any saved `files`. With `--save-dir`,
  generated gateway images and attached file blocks are saved locally. View an
  image before reporting its contents; read a returned file before summarizing it.
- `muse-agent` has no client tool-call bridge. Do not promise local file or shell
  access. Uploaded reference images use the `image` command, not `chat`.

## Generate and edit images

```bash
bun "<skill-dir>/scripts/client.js" image --model dots-image --prompt-file ./prompt.txt --out ./generated/scene
bun "<skill-dir>/scripts/client.js" image --model muse-image --prompt "A rainy bookshop at dawn" --out ./generated/bookshop
bun "<skill-dir>/scripts/client.js" image --model muse-image --image ./reference.png --prompt "Keep the subject, replace only the background with a snowy garden." --out ./generated/edit
```

References: repeat `--image` for 1-8 PNG/JPEG/WebP files, at most 32 MiB total.
Optional `--n` is 1-4; `--size` is `auto`, `1024x1024`, `1536x1024`, or
`1024x1536`; `--quality` is `auto`, `low`, `medium`, or `high`. Providers may
treat size and quality as hints. A named `--session` can reuse a Muse image topic.
The client detects the real format and saves `.png`, `.jpg`, or `.webp` accordingly.
Read the JSON `files` paths rather than assuming the requested extension.

## Long requests and failures

Run long generations using the host agent's background execution and completion
subscription. Inspect each returned image and send it to the user only when asked.
The client bounds requests and never retries generation or message submission.
Timeouts and `upstream_unconfirmed` can leave work running remotely: check server
job history before trying again. Do not generate a replacement blindly.

Installing this skill does not log into Dots, Muse, Telegram, or expose a server.
These remain the user's own accounts and explicit setup actions.
