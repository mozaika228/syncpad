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
- **Client UI:**
  - Collaborative block editor
  - Block type controls and inline formatting controls
  - CRDT-native undo/redo (`Ctrl/Cmd+Z`, `Ctrl+Y` / `Cmd+Shift+Z`) implemented as inverse CRDT operations
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
- metrics: `http://localhost:8080/metrics`

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

## Protocol (MVP)

- client -> server:
  - `{ kind: "hello", room, sinceSeq, siteId }`
  - `{ kind: "op", room, op }`
- server -> client:
  - `{ kind: "history", roomId, fromSeq, toSeq, events: [{ seq, op }] }`
  - `{ kind: "op", roomId, seq, op }`
  - `{ kind: "ack", roomId, seq, opId }`
  - `{ kind: "presence", roomId, users }`

## Current limits

- Relay history is in-memory only (no server-side durable persistence yet)
- Server-side snapshot compaction is not implemented yet (current GC/compaction is client-local)
- Undo restore for deleted blocks currently recreates block shell (type) without restoring full deleted block text payload
- Block split/merge UX is intentionally minimal in this iteration
- Multi-node broadcast bus (Redis/NATS/Kafka) is not wired yet; current scalability improvements are single-node relay hardening
