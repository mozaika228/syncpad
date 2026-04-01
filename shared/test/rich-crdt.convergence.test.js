import assert from "node:assert/strict";
import {
  GENESIS_BLOCK_ID,
  RichTextDocument,
  compareId,
  getCanonicalState,
  idKey
} from "../src/rich-crdt.js";

function makeRng(seed) {
  let state = seed >>> 0;
  return function rand() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function randomInt(rand, min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function pick(rand, arr) {
  return arr[randomInt(rand, 0, arr.length - 1)];
}

function shuffle(rand, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(rand, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function cloneOp(op) {
  return JSON.parse(JSON.stringify(op));
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}`);
    throw error;
  }
}

function generateOps(seed, count = 350) {
  const rand = makeRng(seed);
  const sites = ["a", "b", "c"];
  const lamports = { a: 0, b: 0, c: 0 };
  const sim = new RichTextDocument();
  const ops = [];

  function nextLamport(site) {
    lamports[site] += 1;
    return lamports[site];
  }

  function emit(op) {
    if (!op) return;
    ops.push(op);
    sim.applyOperation(cloneOp(op));
  }

  function randomAttrs() {
    return {
      bold: rand() < 0.4,
      italic: rand() < 0.4,
      underline: rand() < 0.4
    };
  }

  const blockTypes = ["paragraph", "heading1", "bullet"];

  for (let i = 0; i < count; i += 1) {
    const site = pick(rand, sites);
    const lamport = nextLamport(site);
    const choice = rand();
    const blocks = sim.getBlocks();
    const targetBlock = pick(rand, blocks);

    if (choice < 0.18) {
      emit(sim.makeInsertBlockAfter(targetBlock.id, pick(rand, blockTypes), site, lamport));
      continue;
    }

    if (choice < 0.24 && blocks.length > 1) {
      const deletable = blocks.filter((b) => idKey(b.id) !== idKey(GENESIS_BLOCK_ID));
      if (deletable.length > 0) {
        emit(sim.makeDeleteBlock(pick(rand, deletable).id, site, lamport));
      }
      continue;
    }

    if (choice < 0.33) {
      emit(sim.makeFormatBlockOp(targetBlock.id, pick(rand, blockTypes), site, lamport));
      continue;
    }

    const textLen = targetBlock.text.length;

    if (choice < 0.72) {
      const idx = randomInt(rand, 0, textLen);
      const ch = String.fromCharCode(randomInt(rand, 97, 122));
      emit(sim.makeInsertTextOp(targetBlock.id, idx, ch, site, lamport, randomAttrs()));
      continue;
    }

    if (choice < 0.88) {
      if (textLen > 0) {
        const idx = randomInt(rand, 0, textLen - 1);
        emit(sim.makeDeleteTextOp(targetBlock.id, idx, site, lamport));
      }
      continue;
    }

    if (textLen > 0) {
      const idx = randomInt(rand, 0, textLen - 1);
      const attrs = {};
      if (rand() < 0.7) attrs.bold = rand() < 0.5;
      if (rand() < 0.7) attrs.italic = rand() < 0.5;
      if (rand() < 0.7) attrs.underline = rand() < 0.5;
      if (Object.keys(attrs).length === 0) attrs.bold = true;
      emit(sim.makeFormatTextOp(targetBlock.id, idx, attrs, site, lamport));
    }
  }

  return ops;
}

runTest("rich block ordering deterministic for concurrent inserts", () => {
  const d1 = new RichTextDocument();
  const d2 = new RichTextDocument();

  const op1 = d1.makeInsertBlockAfter(GENESIS_BLOCK_ID, "heading1", "site-b", 1);
  const op2 = d1.makeInsertBlockAfter(GENESIS_BLOCK_ID, "bullet", "site-a", 1);

  d1.applyOperation(op1);
  d1.applyOperation(op2);

  d2.applyOperation(op2);
  d2.applyOperation(op1);

  assert.deepEqual(getCanonicalState(d1), getCanonicalState(d2));
});

runTest("rich convergence under permutations with duplicates", () => {
  const seeds = [11, 29, 61, 73, 199, 901];

  for (const seed of seeds) {
    const ops = generateOps(seed, 380);
    const r1 = new RichTextDocument();
    const r2 = new RichTextDocument();
    const r3 = new RichTextDocument();

    applyOps(r1, shuffle(makeRng(seed + 1), ops));
    applyOps(r2, shuffle(makeRng(seed + 2), ops));
    applyOps(r3, shuffle(makeRng(seed + 3), ops.concat(ops.slice(0, 120).map(cloneOp))));

    const s1 = getCanonicalState(r1);
    const s2 = getCanonicalState(r2);
    const s3 = getCanonicalState(r3);

    assert.deepEqual(s2, s1, `seed ${seed}: replica2 diverged`);
    assert.deepEqual(s3, s1, `seed ${seed}: replica3 diverged`);

    assert.equal(s1.pending.blockInserts, 0, `seed ${seed}: block inserts pending`);
    assert.equal(s1.pending.blockDeletes, 0, `seed ${seed}: block deletes pending`);
    assert.equal(s1.pending.blockFormats, 0, `seed ${seed}: block formats pending`);
    assert.equal(s1.pending.textByBlock, 0, `seed ${seed}: text ops pending`);

    const byParent = new Map();
    for (const block of s1.canonicalBlocks) {
      const parentKey = idKey(block.after);
      if (!byParent.has(parentKey)) byParent.set(parentKey, []);
      byParent.get(parentKey).push(block.id);
    }
    for (const children of byParent.values()) {
      const sorted = children.slice().sort(compareId);
      assert.deepEqual(children, sorted, `seed ${seed}: child order mismatch`);
    }
  }
});

function applyOps(doc, ops) {
  for (const op of ops) doc.applyOperation(cloneOp(op));
}

console.log("All rich CRDT convergence checks passed.");
