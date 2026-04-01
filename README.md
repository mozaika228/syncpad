# SyncPad

SyncPad is a standalone real-time collaborative text editor MVP with a custom CRDT implementation (RGA style) and a dumb WebSocket relay.

## What is implemented

- Custom text CRDT (no Yjs/Automerge/ShareDB/Fluid):
  - per-character identifiers: `{ lamport, site }`
  - deterministic merge for concurrent inserts
  - tombstone deletes
  - out-of-order operation handling via pending queues
- Rich-text attributes as CRDT operations:
  - `bold`, `italic`, `underline` stored and merged per character
  - LWW merge by operation id ordering (Lamport + site)
- Realtime synchronization:
  - local-first apply for instant UX
  - WebSocket operation broadcast through a minimal relay server
  - in-memory op history replay for reconnect/new clients
- React client UI:
  - collaborative editor area
  - rich-text preview panel generated from CRDT attributes

## Project structure

- `client/` - React + Vite UI
- `server/` - Node.js WebSocket relay (`ws`)
- `shared/` - CRDT core used by both client and server-side protocol payloads

## Run locally

```bash
npm install
npm run dev
```

Services:

- client: `http://localhost:5173`
- ws relay: `ws://localhost:8080`

Open two browser tabs/windows and type simultaneously to observe convergence.

## CRDT formalization and convergence validation

- Formal spec and proof sketch: `docs/CRDT_SPEC.md`
- Deterministic canonical-state checks and fuzz tests: `shared/test/crdt.convergence.test.js`
- Test command:

```bash
npm run test:crdt
```

## Protocol (MVP)

- client -> server: `{ kind: "op", room, op }`
- server -> client:
  - `{ kind: "history", roomId, ops }`
  - `{ kind: "op", roomId, op }`
  - `{ kind: "presence", roomId, users }`

## Limitations / next steps

- No persistence yet (history in memory only)
- No operational compression/GC for tombstones
- No CRDT-native undo/redo stack yet
- Text input diffing currently based on single-span change in textarea
- Formatting acts on selected character range and is shown in preview panel

## Why this converges

- All operations are commutative/idempotent by unique op ids
- Sibling insertion order is deterministic (`lamport`, then `site`)
- Deletes/format changes for missing nodes are deferred and replayed when dependency appears
- Every client applies the same set of operations with the same ordering rules
