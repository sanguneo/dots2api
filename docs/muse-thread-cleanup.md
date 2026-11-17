# Muse thread cleanup

A successful Muse Chat Completions response (buffered or SSE) includes
`X-Muse-Thread-Id`, the remote chat id. The existing `X-Dots2api-Job-Id`
header can also be used with `GET /api/jobs/:id`; `job.remoteId` is saved
when the provider accepts the job, before its answer finishes.

`DELETE /api/muse-threads/:key` deletes gateway-owned Muse side chats matching
the exact caller key, across accounts and both chat/image kinds. It uses the
same remote deletion operation as the idle sweeper. It does not search or
delete arbitrary provider chats.

The route uses the existing API protection: local host only, matching Origin
when supplied, and either the gateway bearer key or a same-origin browser
request. Keys follow the creation contract: 1 to 64 characters from
`A-Z a-z 0-9 . _ : -`. Encode the path segment.

Response:

```json
{
  "key": "w-task-123",
  "threads": [
    {
      "accountId": "account-uuid",
      "kind": "chat",
      "key": "w-task-123",
      "threadId": "remote-thread-id",
      "lastUsedAt": 123456789,
      "status": "deleted"
    }
  ]
}
```

Status is `deleted`, `gone` (already absent remotely), or `failed`.
HTTP 200 means all known chats were removed or already absent; an unknown
or already cleaned key returns `threads: []`. HTTP 502 means one or more
chats could not be removed. Failed entries keep their mappings for retry;
their ids remain in the response. An unavailable/quarantined account fails
cleanup rather than touching potentially active remote work.

Deletion waits behind all work already submitted on Muse accounts. This
includes queued jobs whose chat has not been created yet. New submissions
with the same key receive HTTP 409 `thread_deleting` until deletion finishes.
Concurrent DELETE requests share cleanup. Unrelated keys remain intact.
After completion the key can be reused for a fresh chat.

Keyed chats are persisted when Muse accepts them, so interrupted or failed
jobs can be cleaned after restart.
An accepted keyed job is not automatically replayed after an uncertain failure,
so cleanup cannot lose an earlier chat to a replacement attempt.
Cleanup intent itself is not persisted:
callers must retain unfinished keys and retry DELETE after a restart or
HTTP timeout. A DELETE can wait for queued work plus remote deletion; timing
out the HTTP caller does not cancel the gateway's cleanup. No polling route
or early pending response is used.
