# SRE Operations Guide

## SLOs

- Relay availability: 99.9% monthly for `/healthz` and websocket upgrade path.
- End-to-end op acknowledge latency (p95): < 250 ms under nominal load.
- Reconnect recovery: client catches up (`history` + live stream) within 5 seconds for rooms <= `MAX_HISTORY`.

## Dashboards

Track from `/metrics`:

- Throughput:
  - `counters.messagesBroadcast`
  - `counters.historyRequests`
- Reliability:
  - `counters.messagesDroppedBackpressure`
  - `counters.socketTerminatedHeartbeat`
  - `counters.roomsEvicted`
- Security/abuse:
  - `counters.authRejected`
  - `counters.schemaRejected`
  - `counters.rateLimited`
- CRDT health:
  - `counters.duplicateOps` (should grow slowly; spikes imply resend storms)

## Alert thresholds

- Critical:
  - `messagesDroppedBackpressure > 0` for 5 consecutive minutes.
  - `authRejected` sudden spike > 5x baseline.
  - `readyz` non-200 for > 2 minutes.
- Warning:
  - `rateLimited` > 100/minute per tenant for 10 minutes.
  - `socketTerminatedHeartbeat` > 2% of active clients.

## Abuse response playbook

1. Identify tenant/room with elevated rejects or rate limits.
2. Tighten temporary quotas (`MAX_OPS_PER_SECOND_PER_SOCKET`, `MAX_BYTES_PER_SECOND_PER_SOCKET`).
3. If needed, rotate tenant token and invalidate old token.
4. Add offending origin/IP to edge-level deny list.
5. Revert temporary limits after traffic normalizes.

## Capacity review

Weekly:

1. Run relay benchmark in CI and compare artifact trend.
2. Review p95 ack latency and backpressure counters.
3. Adjust room/client quotas if sustained utilization > 70%.

## Release gate

A release is blocked if any are true:

- `npm run ci` fails.
- `npm run test:e2e:smoke` fails.
- Perf gate (`npm run bench:gate`) fails against configured budget.