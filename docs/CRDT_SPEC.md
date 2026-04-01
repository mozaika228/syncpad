# SyncPad CRDT Formal Specification (RGA Variant)

## 1. Model

The document is a replicated directed forest rooted at `ROOT_ID = (0, "root")`.

Each visible character is represented by node:

- `id = (lamport, site)` unique globally
- `after` parent node id
- `value` character payload
- `deleted` tombstone bit
- `attrs` mark map (`bold`, `italic`, `underline`)
- `attrClocks[attr]` last-writer clock for each mark

Operations:

- `insert(opId, after, value, attrs)`
- `delete(opId, target)`
- `format(opId, target, attrsPatch)`

`opId` is unique and totally ordered by:

1. `lamport` ascending
2. `site` lexicographic ascending

## 2. Deterministic Interpretation

For each parent node, children are sorted by `opId` order. Linearization is deterministic depth-first traversal from `ROOT_ID`.

Visible text is concatenation of nodes where `deleted = false`.

Formatting is LWW per attribute key using the same total order on `opId`.

## 3. Delivery Semantics and Pending Queues

Transport may deliver operations out of order, with duplicates.

- Unknown insert parent -> enqueue in `pendingInserts[parent]`
- Unknown delete target -> enqueue in `pendingDeletes[target]`
- Unknown format target -> enqueue in `pendingFormats[target]`
- Once dependency appears, deferred ops are replayed in deterministic opId order

Duplicate suppression: `seenOps` set by `opId`.

## 4. Invariants

I1. **Identifier uniqueness**: no two nodes share the same `id`.

I2. **Stable sibling order**: for any parent, child order is total and deterministic.

I3. **Idempotence**: applying same op multiple times has same effect as once.

I4. **Monotonic knowledge**: once op is seen, it remains seen; once node created, never removed (only tombstoned).

I5. **Deferred dependency closure**: if all causal predecessors are eventually delivered, all pending queues become empty.

I6. **LWW formatting determinism**: for each `(node, attr)`, final value equals max ordered format op on that key.

## 5. Convergence Argument (Sketch)

Given two replicas `A` and `B` that process the same operation multiset and all dependencies eventually arrive:

1. Inserts define identical node set by unique `opId` + duplicate suppression.
2. Parent-child relation for each insert is deterministic (`after` id in op payload).
3. Child ordering is deterministic total order by `opId`.
4. Deletes are monotonic (`deleted=true`) and commute.
5. Formats resolve by deterministic LWW order and commute.
6. Deferred queues only delay effect; replay order is deterministic.

Therefore both replicas derive the same canonical state and visible text.

## 6. Machine-Checked Properties in Repository

The test suite validates:

- permutation invariance under random operation reorderings
- idempotence under random duplicated deliveries
- convergence of full canonical state (not text only)
- eventual drain of pending queues when dependencies are present
- deterministic ordering for concurrent sibling inserts

Run:

```bash
npm run test:crdt
```

## 7. Limits of This Proof Level

This is an engineering proof sketch + randomized verification, not a formal proof assistant artifact (e.g., Coq/Isabelle/TLA+ model check). For stronger assurance, add executable spec/model checking in TLA+ and refinement tests against implementation.
