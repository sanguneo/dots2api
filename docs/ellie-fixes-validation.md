# Ellie worker fixes: regression evidence

Baseline on unchanged production, Bun 1.4.3, 2026-11-17:

```text
bun test --timeout 30000 ./tests/muse-thread-delete.test.ts ./tests/muse-submission.test.ts
16 pass, 8 fail, 24 tests across 2 files, exit 1
```

Exact failed expectations:

- `rejects non-worker deletion key tg123 and preserves its remote chat`:
  `Expected: 400`, `Received: 200`.
- Same test for `topic` and `W-task`: `Expected: 400`, `Received: 200`.
- `retries replaced thread after failed deletion and storage restart`:
  expected `[["old", "deleted"]]`, received `[]`.
- Same test for a thrown deletion error: expected `[["old", "deleted"]]`,
  received `[]`.
- `retains every replacement made before DELETE starts`:
  expected `["intermediate", "new", "old"]`, received `["new"]`.
- `lost click acknowledgement respects retryAccepted=false before acceptance`:
  submission count `Expected: 1`, `Received: 2`; no accepted callback fired.
- Same test with legacy retry behavior (`retryAccepted=undefined`):
  submitted event count `Expected: 2`, `Received: 0`.

The click fixture intercepts the real Node worker's Playwright Send operation,
lets the localhost page handle it, then throws before the accepted callback.
A separate Bun driver supplies the worker's startup environment, avoiding
runtime environment inheritance differences. All provider traffic is local.

The earlier exploratory run could not inject this error because the worker
inherited startup environment rather than the test's runtime `NODE_OPTIONS`.
Its acceptance assertion failed instead; it is not the item 7 regression proof.

## Same-account concurrency decision

Keep account serialization and use the relay delay notice. `src/gateway.ts`
chains jobs by account (`submit`, around lines 304-308). Each browser job
independently calls `openBrowser`, which launches a persistent context at
`resolve(context.dataDir, "muse", context.accountId)` in
`src/providers/muse/engine.ts` (around lines 610-618), and closes that context
in the job's `finally` (around lines 588-590). There is no shared browser owner
or page pool. Concurrent jobs would launch Chromium against the same locked
profile; allocating safe pages requires changing browser ownership and lifetime,
not just adding a queue lane.

`tests/muse-serialization.test.ts` pins this existing behavior with an
event-controlled fake adapter: while `w-task` is held, `tg123` is queued on
the same account; its adapter starts only after the worker finishes. This is
a passing baseline characterization for the fallback, not a parallelism fix.
No account header, environment routing, or queue change was made.

Targeted checks after the fixes:

```text
bun test --timeout 30000 ./tests/muse-thread-delete.test.ts ./tests/muse-submission.test.ts ./tests/muse-thread-lifecycle.test.ts ./tests/sessions.test.ts
48 pass, 0 fail, 4 files, exit 0

bun test --timeout 30000 ./tests/muse-serialization.test.ts
1 pass, 0 fail, 1 file, exit 0
```

The weak retry-flag check now records `context.retryAccepted` and asserts
`[false]` outside the adapter, so a generic failure cannot satisfy it.
Optional work left unchanged: DELETE's total queue wait has no deadline
(review item 10), and the existing lifecycle test still waits on its
acceptance event before asserting its one-second browser timeout (item 12).
