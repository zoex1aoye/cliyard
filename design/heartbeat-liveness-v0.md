# Heartbeat Liveness v0

## Finding

A real Claude Code + DeepSeek Task Architect run emitted frequent
`system/thinking_tokens` records for longer than the status stale threshold.
The adapter treated those records as provider activity, but did not map them to
an emitted progress event. The heartbeat timer also suppressed itself whenever
any provider bytes were recent. The result was:

```text
worker still active
  → thinking token records keep arriving
  → no mapped event and no heartbeat
  → supervisor status reports stale: true
```

## Fix

While the Claude child process is alive, emit one heartbeat every configured
heartbeat interval. The heartbeat reports:

- `"provider active"` when any provider JSON record arrived since the previous
  heartbeat, including records that are not otherwise surfaced;
- `"waiting for provider output"` when no provider record arrived.

The event remains `type: "heartbeat"`, phase `thinking` for active provider
traffic and `waiting` for silence. It remains advisory and cannot affect
acceptance.

No token-level event is emitted. Heartbeats are bounded by the configured
interval and clear when the child exits.

## Acceptance

1. A provider that emits only unmapped `system/thinking_tokens` still produces
   periodic visible heartbeats.
2. The active heartbeat phase/message differs from silence.
3. Heartbeats stop after the child exits.
4. Existing stream/result/retry/status tests remain green.
5. Documentation records the real-run finding and the bounded fix.

