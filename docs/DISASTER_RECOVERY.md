# Disaster Recovery and Migration

## Recovery goals

- Target RPO: up to room log flush interval (append-on-accept, effectively near-zero for local disk).
- Target RTO: under 15 minutes for single relay node replacement with room log restore.

## Durable data

- Per-room append-only JSONL files in `DATA_DIR/rooms`.
- Each event has monotonic `seq` and CRDT op payload.
- Trimming and compaction rewrite canonical retained history without changing causal order.

## Backup policy

1. Snapshot `DATA_DIR/rooms` every 15 minutes.
2. Keep 48 hourly snapshots + 14 daily snapshots.
3. Encrypt snapshots at rest and in transit.
4. Validate restore once per week in staging.

## Restore procedure

1. Stop relay instances for impacted tenant/room set.
2. Restore `DATA_DIR/rooms` from selected snapshot.
3. Start relay and verify:
   - `/readyz` returns `ok: true`.
   - reconnect client receives `history` and converges.
   - `counters.duplicateOps` does not spike abnormally after reconnect.
4. Run smoke: `npm run test:e2e:smoke` against restored node.

## Protocol/version migration

1. Introduce `v+1` server with dual-read/dual-write compatibility.
2. Keep writing canonical records compatible with previous version during rollout.
3. Gradually move clients to `v+1`.
4. Monitor old-version share in metrics/logs; only then drop old support.

## Data schema migration for room logs

1. Add backward reader for previous schema.
2. Load room into in-memory canonical CRDT state.
3. Rewrite compacted JSONL with new canonical schema.
4. Validate by replaying rewritten log into a fresh process and comparing canonical state digest.

## Disaster game-day scenarios

- Node crash during peak fanout.
- Partial room file corruption (bad JSON line).
- Redis bus outage while local relay remains healthy.
- Long client offline branch reconnecting after trim/compaction.

Run game-day quarterly and record runbook updates.