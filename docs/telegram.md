# Optional Telegram bot

Run your own Dots/Muse assistant in Telegram, with text conversation and returned
images/files. This relay uses your own bot, accounts and explicit allowlists.
It is independent from installing the agent skill.

1. Create a Telegram bot using BotFather. Save the token in a private file
   (`chmod 600`). Find your numeric Telegram user ID.
2. Connect your Dots/Muse account in the dots2api console and save that server's
   API key to another private file.
3. Copy `examples/telegram.json` into a private directory. Replace `allowedUserIds`
   with your actual numeric user ID. For a group, add its numeric ID to
   `allowedChatIds`; an allowed user must mention the bot or reply to it there.
4. Set the file references below, then start the relay from the repository:

```json
{
  "gateway": {
    "baseURL": "http://127.0.0.1:3010",
    "apiKey": { "file": "./gateway-key.txt" }
  },
  "telegram": { "botToken": { "file": "./telegram-token.txt" } },
  "allowedUserIds": [123456789],
  "allowedChatIds": [],
  "model": "muse-agent",
  "systemPrompt": "You are a helpful assistant.",
  "stateDir": "./telegram-state"
}
```

`123456789` is an example, not an account supplied by this project. All relative
paths are resolved beside the config file. Each secret reference accepts exactly
one of `{ "file": "..." }` or `{ "env": "ENVIRONMENT_VARIABLE_NAME" }`.
With a service, prefer files: a systemd service does not inherit your shell's
exported variables.

```bash
bun run telegram --config /absolute/private/telegram.json
```

For a Linux user service, after installing the server:

```bash
cd ~/.local/share/dots2api/app
bash install-telegram.sh --config /absolute/private/telegram.json
journalctl --user -u dots2api-telegram
```

This starts the bot only when you explicitly run the installer. To write a unit
without starting it, add `--no-start`. Only one `getUpdates` poller may use the
same bot token. Keep one state directory per bot.

## Conversation and permissions

- DMs are accepted only from `allowedUserIds`.
- Groups require both an allowed sender and an allowed chat. Mention the bot's
  actual `@username`, or reply to its message.
- Other bots are ignored by default. To enable them, set `allowBotMessages: true`,
  add their numeric IDs to the user allowlist, and explicitly mention this bot.
- `model` is `muse-agent` (default) or `dots-agent`. A stable conversation key is
  used per bot/chat for Muse. Dots uses its primary Dot conversation and does not
  isolate chats through that key; use Muse when independent topics are needed.
- Returned gateway images are downloaded with the gateway key and uploaded to
  Telegram. File attachments are also sent. Only a definite photo rejection
  permits a document fallback; uncertain sends are not repeated.
- Incoming photo analysis is not supported by this chat API. The relay tells the
  sender it has not seen the picture. Use the skill's reference-edit command for
  image editing.

`requestTimeoutMs` defaults to 300000; `pollTimeoutSeconds` defaults to 25.
`telegram.apiBaseURL` can point to a compatible Bot API proxy. The default is
`https://api.telegram.org`. The gateway address must be an HTTP(S) origin.
Neither tokens nor response bodies are included in error messages.

## Restart after an uncertain outcome

`state.json` persists the acknowledged update offset. Before a generation or
send, a pending record is written. If the process cannot tell whether that work
finished, it stops and leaves `pending` in state. It will not regenerate an image
or send another answer automatically.

Stop the service first. Inspect Telegram and the gateway job history. If that
update should be considered handled, set `offset` to `pending.updateId + 1` and
`pending` to `null` in a backed-up state file, then restart. If an intentional
resubmission is needed, clearing `pending` without advancing the offset allows
that update to run again; decide this only after checking the remote outcome.
Do not delete all state to recover a single message.

After an unclean process death, `relay.lock` may remain. Confirm that the old
process is gone before removing that empty lock directory. Normal shutdown
removes it. Never run multiple relay services against the same state.
