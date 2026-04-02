# SyncPad

SyncPad is a standalone real-time collaborative editor with custom CRDTs (no Yjs/Automerge/ShareDB/Fluid).

## What is implemented

- **Rich document CRDT (block + inline):**
  - Block sequence CRDT: paragraph / heading / bullet blocks
  - Per-block inline CRDT with per-character marks (`bold`, `italic`, `underline`)
  - Deterministic concurrent merge by `(lamport, site)` ordering
  - Tombstone deletes and out-of-order delivery recovery via pending queues
- **Network layer:**
  - Local-first apply for instant UX
  - Offline-first outbox with durable local op-log (`localStorage`)
  - Reconnect sync via incremental history replay (`sinceSeq`) + idempotent dedupe
  - WebSocket relay assigns monotonic `seq`, sends `ack` and missing history
  - Local tombstone GC + log compaction into compact snapshot when safe (outbox empty)
  - Scalable relay hardening: bounded history + `baseSeq`, room TTL eviction, heartbeat ping/pong, backpressure-aware send
  - Multi-tenant/security hardening: tenant isolation, hello-before-op policy, payload schema validation, per-socket rate limiting, optional token auth, origin allowlist
- **Client UI:**
  - Collaborative block editor
  - Block type controls and inline formatting controls
  - CRDT-native undo/redo (`Ctrl/Cmd+Z`, `Ctrl+Y` / `Cmd+Shift+Z`) implemented as inverse CRDT operations
  - Awareness layer (separate from CRDT): live remote cursor/selection presence per block
  - Structured rich preview driven from CRDT state

## Project structure

- `client/` - React + Vite UI
- `server/` - Node.js WebSocket relay (`ws`)
- `shared/` - CRDT core

## Run locally

```bash
npm install
npm run dev
```

Services:

- client: `http://localhost:5173`
- ws relay: `ws://localhost:8080`
- health: `http://localhost:8080/healthz`
- ready: `http://localhost:8080/readyz`
- metrics: `http://localhost:8080/metrics`

Client can pass tenant/session context via query params:

- `http://localhost:5173/?tenant=acme&room=roadmap&user=alice&token=tokenA`

## Formalization and convergence validation

- Sequence CRDT spec: `docs/CRDT_SPEC.md`
- Plain sequence convergence tests: `shared/test/crdt.convergence.test.js`
- Rich block+inline convergence tests: `shared/test/rich-crdt.convergence.test.js`
- Snapshot compaction checks: `shared/test/rich-crdt.snapshot.test.js`

Run checks directly:

```bash
node shared/test/crdt.convergence.test.js
node shared/test/rich-crdt.convergence.test.js
node shared/test/rich-crdt.snapshot.test.js
```

Engineering runbook:

- `docs/ENGINEERING_RUNBOOK.md`

Unified project commands:

```bash
npm run check
npm run test
npm run ci
```

## Protocol (MVP)

- client -> server:
  - `{ kind: "hello", tenantId, roomId, userId, authToken, sinceSeq, siteId }`
  - `{ kind: "op", tenantId, roomId, op }`
  - `{ kind: "awareness", tenantId, roomId, awareness: { blockKey, start, end, focused } }`
- server -> client:
  - `{ kind: "history", tenantId, roomId, fromSeq, toSeq, baseSeq, truncated, events: [{ seq, op }] }`
  - `{ kind: "op", tenantId, roomId, seq, op }`
  - `{ kind: "ack", tenantId, roomId, seq, opId }`
  - `{ kind: "presence", tenantId, roomId, users }`
  - `{ kind: "awareness_snapshot", tenantId, roomId, users: [...] }`
  - `{ kind: "awareness_update", tenantId, roomId, user }`
  - `{ kind: "awareness_remove", tenantId, roomId, socketId, siteId, userId }`
  - `{ kind: "error", code, reason }`

## Security / Multi-tenant env

- `RELAY_AUTH_TOKEN=<token>`: one shared token for all tenants.
- `TENANT_TOKENS_JSON={\"tenantA\":\"tokenA\",\"tenantB\":\"tokenB\"}`: per-tenant tokens (takes precedence over global token).
- `ALLOWED_ORIGINS=http://localhost:5173,https://yourapp.example`: WebSocket Origin allowlist.
- `MAX_OPS_PER_SECOND_PER_SOCKET=400`: per-socket op rate limiter.
- `MAX_BYTES_PER_SECOND_PER_SOCKET=524288`: per-socket byte rate limiter.
- `MAX_ROOMS_PER_TENANT=500`, `MAX_CLIENTS_PER_TENANT=2000`: tenant quotas.
- Complete env template: `.env.example`

## Performance tuning

- Client:
  - CRDT apply now batches UI commits via `requestAnimationFrame` (reduces rerender storms during history replay and burst typing).
  - Local persistence (`op-log`, `outbox`) is debounced and flushed on `beforeunload`.
- Server relay:
  - Broadcast path serializes payload once per fanout (instead of `JSON.stringify` per socket).
  - Backpressure drop guard remains enabled (`MAX_BUFFERED_BYTES`).

## Current limits

- Relay history is in-memory only (no server-side durable persistence yet)
- Awareness is ephemeral and in-memory only (no replay from durable store by design)
- Server-side snapshot compaction is not implemented yet (current GC/compaction is client-local)
- Undo restore for deleted blocks currently recreates block shell (type) without restoring full deleted block text payload
- Block split/merge UX is intentionally minimal in this iteration
- Multi-node broadcast bus (Redis/NATS/Kafka) is not wired yet; current scalability improvements are single-node relay hardening
