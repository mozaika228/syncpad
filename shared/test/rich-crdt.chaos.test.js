import assert from "node:assert/strict";
import {
  GENESIS_BLOCK_ID,
  RichTextDocument,
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

function randomAttrs(rand) {
  return {
    bold: rand() < 0.35,
    italic: rand() < 0.35,
    underline: rand() < 0.35
  };
}

function generateValidOps(seed, count = 260) {
  const rand = makeRng(seed);
  const sites = ["sa", "sb", "sc", "sd"];
  const lamports = Object.fromEntries(sites.map((s) => [s, 0]));
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

  const blockTypes = ["paragraph", "heading1", "bullet"];

  for (let i = 0; i < count; i += 1) {
    const site = pick(rand, sites);
    const lamport = nextLamport(site);
    const choice = rand();
    const blocks = sim.getBlocks();
    const targetBlock = pick(rand, blocks);

    if (choice < 0.16) {
      emit(sim.makeInsertBlockAfter(targetBlock.id, pick(rand, blockTypes), site, lamport));
      continue;
    }

    if (choice < 0.23 && blocks.length > 1) {
      const deletable = blocks.filter((b) => idKey(b.id) !== idKey(GENESIS_BLOCK_ID));
      if (deletable.length > 0) emit(sim.makeDeleteBlock(pick(rand, deletable).id, site, lamport));
      continue;
    }

    if (choice < 0.3) {
      emit(sim.makeFormatBlockOp(targetBlock.id, pick(rand, blockTypes), site, lamport));
      continue;
    }

    const textLen = targetBlock.text.length;

    if (choice < 0.7) {
      const idx = randomInt(rand, 0, textLen);
      const ch = String.fromCharCode(randomInt(rand, 97, 122));
      emit(sim.makeInsertTextOp(targetBlock.id, idx, ch, site, lamport, randomAttrs(rand)));
      continue;
    }

    if (choice < 0.86 && textLen > 0) {
      emit(sim.makeDeleteTextOp(targetBlock.id, randomInt(rand, 0, textLen - 1), site, lamport));
      continue;
    }

    if (textLen > 0) {
      const attrs = {};
      if (rand() < 0.7) attrs.bold = rand() < 0.5;
      if (rand() < 0.7) attrs.italic = rand() < 0.5;
      if (rand() < 0.7) attrs.underline = rand() < 0.5;
      if (Object.keys(attrs).length === 0) attrs.bold = true;
      emit(sim.makeFormatTextOp(targetBlock.id, randomInt(rand, 0, textLen - 1), attrs, site, lamport));
    }
  }

  return ops;
}

function makeStormFeed(seed, allOps, dropRate, duplicateRate) {
  const rand = makeRng(seed);
  const shuffled = shuffle(rand, allOps).map(cloneOp);
  const result = [];

  for (const op of shuffled) {
    if (rand() < dropRate) continue;
    result.push(op);
    if (rand() < duplicateRate) result.push(cloneOp(op));
  }

  return shuffle(rand, result);
}

function applyOps(doc, ops) {
  for (const op of ops) doc.applyOperation(cloneOp(op));
}

runTest("rich chaos: offline branches converge after anti-entropy replay", () => {
  const seeds = [1337, 2001, 48109, 900001];

  for (const seed of seeds) {
    const allOps = generateValidOps(seed, 300);

    const r1 = new RichTextDocument();
    const r2 = new RichTextDocument();
    const r3 = new RichTextDocument();

    const branch1 = makeStormFeed(seed + 1, allOps, 0.24, 0.18);
    const branch2 = makeStormFeed(seed + 2, allOps, 0.18, 0.24);
    const branch3 = makeStormFeed(seed + 3, allOps, 0.3, 0.3);

    applyOps(r1, branch1);
    applyOps(r2, branch2);
    applyOps(r3, branch3);

    applyOps(r1, shuffle(makeRng(seed + 101), allOps));
    applyOps(r2, shuffle(makeRng(seed + 102), allOps.concat(allOps.slice(0, 120))));
    applyOps(r3, shuffle(makeRng(seed + 103), allOps.concat(allOps.slice(120, 220))));

    const s1 = getCanonicalState(r1);
    const s2 = getCanonicalState(r2);
    const s3 = getCanonicalState(r3);

    assert.deepEqual(s2, s1, `seed ${seed}: replica2 diverged`);
    assert.deepEqual(s3, s1, `seed ${seed}: replica3 diverged`);

    assert.equal(s1.pending.blockInserts, 0, `seed ${seed}: blockInserts pending`);
    assert.equal(s1.pending.blockDeletes, 0, `seed ${seed}: blockDeletes pending`);
    assert.equal(s1.pending.blockFormats, 0, `seed ${seed}: blockFormats pending`);
    assert.equal(s1.pending.textByBlock, 0, `seed ${seed}: textByBlock pending`);
  }
});

console.log("Rich CRDT chaos checks passed.");