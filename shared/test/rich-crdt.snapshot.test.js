import assert from "node:assert/strict";
import {
  RichTextDocument,
  countTombstones,
  createCompactedSnapshot,
  getCanonicalState,
  restoreFromCompactedSnapshot
} from "../src/rich-crdt.js";

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function run(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (err) {
    console.error(`[FAIL] ${name}`);
    throw err;
  }
}

run("compacted snapshot preserves visible document", () => {
  const doc = new RichTextDocument();
  let l = 1;

  const b0 = doc.getBlocks()[0].id;
  const i1 = doc.makeInsertTextOp(b0, 0, "H", "s1", l++, { bold: true });
  const i2 = doc.makeInsertTextOp(b0, 1, "i", "s1", l++, { italic: true });
  const b1 = doc.makeInsertBlockAfter(b0, "heading1", "s1", l++);

  doc.applyOperation(i1);
  doc.applyOperation(i2);
  const d1 = doc.makeDeleteTextOp(b0, 0, "s1", l++);
  doc.applyOperation(d1);
  doc.applyOperation(b1);

  const newBlockId = b1.opId;
  doc.applyOperation(doc.makeInsertTextOp(newBlockId, 0, "X", "s1", l++, {}));
  doc.applyOperation(doc.makeFormatBlockOp(newBlockId, "bullet", "s1", l++));

  const beforeVisible = doc.getBlocks();
  const beforeTombstones = countTombstones(doc).total;
  assert.ok(beforeTombstones > 0);

  const snapshot = createCompactedSnapshot(doc, { seq: 42, lamport: 99 });
  const restored = restoreFromCompactedSnapshot(snapshot);

  assert.deepEqual(restored.getBlocks(), beforeVisible);
  assert.equal(restored.getText(), doc.getText());

  const afterTombstones = countTombstones(restored).total;
  assert.equal(afterTombstones, 0);
});

run("restored snapshot accepts future operations consistently", () => {
  const doc = new RichTextDocument();
  let l = 1;
  const first = doc.getBlocks()[0].id;

  doc.applyOperation(doc.makeInsertTextOp(first, 0, "a", "s1", l++, {}));
  doc.applyOperation(doc.makeInsertTextOp(first, 1, "b", "s1", l++, {}));

  const snapshot = createCompactedSnapshot(doc, { seq: 10, lamport: l });
  const restored = restoreFromCompactedSnapshot(snapshot);

  const op1 = doc.makeInsertTextOp(first, 2, "c", "s2", 50, { underline: true });
  const op2 = doc.makeFormatTextOp(first, 1, { bold: true }, "s2", 51);

  restored.applyOperation(clone(op1));
  restored.applyOperation(clone(op2));
  doc.applyOperation(clone(op1));
  doc.applyOperation(clone(op2));

  assert.equal(restored.getText(), doc.getText());
  assert.deepEqual(restored.getBlocks(), doc.getBlocks());

  const a = getCanonicalState(restored);
  const b = getCanonicalState(doc);
  assert.equal(a.text, b.text);
});

console.log("Snapshot compaction checks passed.");
