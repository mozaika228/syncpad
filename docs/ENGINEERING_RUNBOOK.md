# SyncPad Engineering Runbook

## Quality gates

- Static syntax check:

```bash
npm run check
```

- CRDT test suite:

```bash
npm run test
```

- Full local CI pass:

```bash
npm run ci
```

- Optional validation:

```bash
npm run test:e2e:smoke
npm run bench:relay
npm run bench:gate
```

## Operational endpoints

- `GET /healthz` - liveness + room/client count.
- `GET /metrics` - runtime counters and active config.

## Deployment checklist

1. Set authentication and tenant controls:
   - `RELAY_AUTH_TOKEN` or `TENANT_TOKENS_JSON`
   - `ALLOWED_ORIGINS`
   - Protocol version currently fixed to `v=1`
2. Set resource limits:
   - `MAX_ROOM_CLIENTS`, `MAX_ROOMS_PER_TENANT`, `MAX_CLIENTS_PER_TENANT`
   - `MAX_HISTORY`, `MAX_BUFFERED_BYTES`, `MAX_MESSAGE_BYTES`
   - `MAX_OPS_PER_SECOND_PER_SOCKET`, `MAX_BYTES_PER_SECOND_PER_SOCKET`
3. Set reliability controls:
   - `HEARTBEAT_INTERVAL_MS`, `ROOM_IDLE_TTL_MS`, `ROOM_GC_INTERVAL_MS`
   - Optional Redis bus: `RELAY_REDIS_URL` (+ channel/seq prefixes)
4. Verify `/healthz` and `/metrics` in staging before traffic.
5. Verify room durability:
   - create ops,
   - restart relay,
   - ensure reconnect clients can recover from persisted room history.
6. Confirm release gate:
   - `npm run ci`
   - `npm run test:e2e:smoke`
   - benchmark + perf budget gate pass.

## Incident quick triage

1. Check `counters.rateLimited`, `counters.messagesDroppedBackpressure`, `counters.authRejected` in `/metrics`.
2. If backpressure rises, lower fanout pressure or tighten quotas.
3. If auth rejects spike, verify tenant token mapping and client query params.
4. If reconnect loops occur, inspect `baseSeq/truncated` and client `sinceSeq` continuity.

## Shutdown behavior

Relay handles `SIGINT`/`SIGTERM` with graceful close:

- stops accepting new upgrades,
- closes active sockets,
- exits after close timeout.

## Companion docs

- DR and migration: `docs/DISASTER_RECOVERY.md`
- SLO/alerts/abuse: `docs/SRE_OPERATIONS.md`
