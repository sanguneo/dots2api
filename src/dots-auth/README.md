# Dots authentication integration

Import `DotsAuth` from `src/dots-auth.ts`. Create one instance for the serving
process and inject it into the gateway. It does not open a database, inspect
desktop credentials, launch a browser, or submit a Dot prompt.

## Device login

```typescript
const auth = new DotsAuth();
const start = await auth.start(localAccountId, signal);
// Safe browser response: verificationUrl, userCode, expiresAt, pollIntervalMs.
const result = await auth.finish(localAccountId, signal);
// pending: { status: "pending", retryAfterMs }
// connected: { status: "connected", credentials }
```

`expiresAt` in the start result is an epoch-millisecond number. The device login
expires after 15 minutes. Respect `retryAfterMs` when pending; the service also
enforces the issuer's polling interval. A finish call performs one poll, not a
background polling loop. Simultaneous finish calls share one code exchange.
Restarting login replaces and aborts the old session.

Hold the gateway's account operation lease through each start/finish HTTP call.
Release it while waiting for the person to authenticate. On successful finish,
persist the returned credential set, then check the account's primary Dot. Do not
return credentials from the HTTP API. Login alone does not verify Dot access.
Call `clear(id)` on cancellation/deletion, and `close()` at server shutdown.

## Refresh ownership

```typescript
const credentials = await auth.refresh(localAccountId, {
  read: () => store.credentials(localAccountId),
  save: (value) => {
    store.saveAccount(gateway.account(localAccountId), value);
  },
}, signal);
// Validate and use these credentials only after refresh resolves.
```

The parent holds its account lease across read, refresh, persistence, and use.
`read` must return the latest stored value, not a captured snapshot. `save` must
persist the complete value before resolving. Both callbacks may be asynchronous.
Call refresh before adapter validation, which may discard OAuth metadata.

Refresh runs within 60 seconds of expiry, using the earlier of JWT `exp` and
stored `expiresAt`. Unknown expiry on a renewable account forces refresh.
Access-token-only accounts remain supported without any OAuth request. If their
expiry is known and elapsed, the service reports a reconnect-required 401.

Stored fields are strings: `accessToken`, `accountId`, `refreshToken`, optional
`idToken`, `expiresAt` (epoch milliseconds), and `refreshState`. Other fields such
as `endpoint` survive rotation.

The save callback runs twice during refresh:

1. Persist `refreshState: "refreshing"` before sending the rotating grant.
2. Persist returned tokens, including a rotated refresh token, with
   `refreshState: "ready"` before releasing the operation.

An explicit invalid/revoked grant persists `"revoked"`. Every failure after the
first save returns HTTP status 401, including network, cancellation, malformed
response, and final-save failures. A surviving `"refreshing"` marker requires
reconnection rather than replaying a possibly consumed token after restart.
Fresh device credentials include `"ready"` to replace that marker.

Concurrent refresh callers for the same local account share the first caller's
operation and cancellation. The parent must exclude other processes and CLI
clients from this grant; do not share or duplicate a refresh token across
accounts. The service's lock is process-local, not a distributed lock.

## HTTP and protocol

Requests have a 20-second complete-response deadline and a 64 KiB body limit.
Redirects and retries are disabled. Errors carry fixed local messages, never
upstream bodies, token values, URLs with credentials, or attached HTTP causes.
Production accepts only `https://auth.openai.com`; explicit HTTP loopback issuers
and an injected clock are available for fixtures.

The protocol is taken from the official Codex implementation:

- [Device authorization](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs)
- [Authorization-code exchange](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)
- [Grant encoding](https://github.com/openai/codex/blob/main/codex-rs/login/src/oauth/client.rs)
- [Client ID, refresh, and revocation classification](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs)
- [Authentication documentation](https://developers.openai.com/codex/auth/)

No live account actions are required by the wire fixtures:

```sh
bun test tests/dots-auth*.test.ts
bun run typecheck
```
