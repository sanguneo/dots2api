# Setup

The skill is a client for the open-source `sanguneo/dots2api` fork. Each person
connects their own Dots/Muse account. No shared account, server address or
credential is included.

## Existing server

Install Bun, then from the repository:

```bash
bun install --frozen-lockfile
bash install-skill.sh
```

The default skill directory is `~/.agents/skills/dots2api`. For an agent that
reads a different directory, use `bash install-skill.sh --dir /its/skills/dots2api`.
The bundled client continues to work without the source checkout or node_modules.
Ask the user for their server URL and the path to their API key file, then run
the `configure` and `models` commands in SKILL.md. Never request a key in a
public conversation.

## Own server

Linux with user systemd: install Bun 1.3+ and clone `sanguneo/dots2api`. Run
`bash install.sh --port 3010`. The installer installs the service and the client
skill. On another computer install just the skill with `install-skill.sh`.
The server binds loopback; access it remotely using an SSH tunnel:

```bash
ssh -N -L 3010:127.0.0.1:3010 user@your-server
```

Open `http://127.0.0.1:3010` in your browser. Add your account in Accounts:

- Dots: approve the device login using your ChatGPT account that has a Dot.
- Muse: use the remote browser to sign into your own Muse account, then confirm
  connection. Muse requires Node.js 22+, Chromium and, for remote login, Xvfb.
  On Debian/Ubuntu install `xvfb` and the Chromium system dependencies, then use
  `bash install.sh --with-muse`. The installer checks missing prerequisites and
  explains them; it does not silently change system packages or use sudo.

Read your gateway key in the console's API guide and save it to a private file.
Run `models`, a short `chat`, and one `image` request. Open the saved image.
Real account approval cannot be automated or replaced with test credentials.

For macOS or Windows with Bun, `bun run start` runs the server from the source
checkout. The Linux service installer is not supported there. The portable client
skill can be installed with a bash shell and Bun. Headless Muse's Xvfb login
instructions apply to Linux, not a claim of cross-platform browser setup.

## Optional Telegram

The repository's `examples/telegram.json` and `src/telegram/main.ts` provide an
optional relay for your own bot. Keep the bot token and gateway key in private
files, configure your own allowed users/chats, and run:

```bash
bun src/telegram/main.ts --config /private/telegram.json
```

This process runs beside dots2api; installing a skill does not start a bot.
Use the exact configuration documented in the repository's Telegram guide.
Never run two getUpdates pollers with the same bot token. Do not copy someone
else's IDs, persona, tokens, state or Telegram service configuration.
