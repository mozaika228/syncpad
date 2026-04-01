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
  - WebSocket relay server broadcasts operations and replays room history
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

## Formalization and convergence validation

- Sequence CRDT spec: `docs/CRDT_SPEC.md`
- Plain sequence convergence tests: `shared/test/crdt.convergence.test.js`
- Rich block+inline convergence tests: `shared/test/rich-crdt.convergence.test.js`

Run checks directly:

```bash
node shared/test/crdt.convergence.test.js
node shared/test/rich-crdt.convergence.test.js
```

## Protocol (MVP)

- client -> server: `{ kind: "op", room, op }`
- server -> client:
  - `{ kind: "history", roomId, ops }`
  - `{ kind: "op", roomId, op }`
  - `{ kind: "presence", roomId, users }`

## Current limits

- Relay history is in-memory only (no durable persistence)
- No tombstone garbage collection / compaction yet
- Undo restore for deleted blocks currently recreates block shell (type) without restoring full deleted block text payload
- Block split/merge UX is intentionally minimal in this iteration
