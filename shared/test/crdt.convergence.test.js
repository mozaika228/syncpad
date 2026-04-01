import assert from "node:assert/strict";
import {
  RgaDocument,
  ROOT_ID,
  compareId,
  getCanonicalState,
  idKey
} from "../src/crdt.js";

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

function generateOperationSet(seed, count = 300) {
  const rand = makeRng(seed);
  const sites = ["site-a", "site-b", "site-c"];
  const lamports = Object.fromEntries(sites.map((site) => [site, 0]));
  const knownIds = [ROOT_ID];
  const ops = [];

  function nextId(site) {
    lamports[site] += 1;
    return { lamport: lamports[site], site };
  }

  function randomAttrs() {
    return {
      bold: rand() < 0.4,
      italic: rand() < 0.4,
      underline: rand() < 0.4
    };
  }

  for (let i = 0; i < count; i += 1) {
    const site = pick(rand, sites);
    const opId = nextId(site);
    const opChoice = rand();

    if (opChoice < 0.6) {
      const after = pick(rand, knownIds);
      const value = String.fromCharCode(randomInt(rand, 97, 122));
      const op = { type: "insert", opId, after, value, attrs: randomAttrs() };
      ops.push(op);
      knownIds.push(opId);
      continue;
    }

    if (knownIds.length <= 1) {
      const op = {
        type: "insert",
        opId,
        after: ROOT_ID,
        value: "x",
        attrs: randomAttrs()
      };
      ops.push(op);
      knownIds.push(opId);
      continue;
    }

    const target = pick(rand, knownIds.slice(1));
    if (opChoice < 0.8) {
      ops.push({ type: "delete", opId, target });
    } else {
      const attrs = {};
      if (rand() < 0.7) attrs.bold = rand() < 0.5;
      if (rand() < 0.7) attrs.italic = rand() < 0.5;
      if (rand() < 0.7) attrs.underline = rand() < 0.5;
      if (Object.keys(attrs).length === 0) attrs.bold = true;
      ops.push({ type: "format", opId, target, attrs });
    }
  }

  return ops;
}

function applyOps(doc, ops) {
  for (const op of ops) {
    doc.applyOperation(cloneOp(op));
  }
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

runTest("deterministic sibling ordering for concurrent inserts", () => {
  const docA = new RgaDocument();
  const docB = new RgaDocument();

  const op1 = {
    type: "insert",
    opId: { lamport: 1, site: "site-b" },
    after: ROOT_ID,
    value: "B",
    attrs: {}
  };
  const op2 = {
    type: "insert",
    opId: { lamport: 1, site: "site-a" },
    after: ROOT_ID,
    value: "A",
    attrs: {}
  };

  applyOps(docA, [op1, op2]);
  applyOps(docB, [op2, op1]);

  assert.equal(docA.getText(), "AB");
  assert.equal(docB.getText(), "AB");
  assert.deepEqual(getCanonicalState(docA), getCanonicalState(docB));
});

runTest("idempotence under duplicate deliveries", () => {
  const baseOps = generateOperationSet(1001, 200);
  const dupOps = baseOps.concat(baseOps.slice(0, 120).map(cloneOp));

  const d1 = new RgaDocument();
  const d2 = new RgaDocument();
  applyOps(d1, dupOps);
  applyOps(d2, baseOps);

  assert.deepEqual(getCanonicalState(d1), getCanonicalState(d2));
});

runTest("convergence under random permutations", () => {
  const seeds = [7, 21, 77, 1301, 2029, 4096, 99173, 500001];

  for (const seed of seeds) {
    const ops = generateOperationSet(seed, 400);
    const rand1 = makeRng(seed + 1);
    const rand2 = makeRng(seed + 2);
    const rand3 = makeRng(seed + 3);

    const replicas = [new RgaDocument(), new RgaDocument(), new RgaDocument()];
    applyOps(replicas[0], shuffle(rand1, ops));
    applyOps(replicas[1], shuffle(rand2, ops));

    const dupPlusShuffle = shuffle(rand3, ops.concat(ops.slice(0, 150).map(cloneOp)));
    applyOps(replicas[2], dupPlusShuffle);

    const state0 = getCanonicalState(replicas[0]);
    const state1 = getCanonicalState(replicas[1]);
    const state2 = getCanonicalState(replicas[2]);

    assert.deepEqual(state1, state0, `seed ${seed}: replica1 diverged`);
    assert.deepEqual(state2, state0, `seed ${seed}: replica2 diverged`);

    assert.equal(state0.pending.inserts, 0, `seed ${seed}: pending inserts left`);
    assert.equal(state0.pending.deletes, 0, `seed ${seed}: pending deletes left`);
    assert.equal(state0.pending.formats, 0, `seed ${seed}: pending formats left`);

    const nodeIds = state0.nodes.map((n) => idKey(n.id));
    const uniqueIds = new Set(nodeIds);
    assert.equal(uniqueIds.size, nodeIds.length, `seed ${seed}: duplicate node ids`);

    const byParent = new Map();
    for (const node of state0.nodes) {
      const parentKey = idKey(node.after);
      if (!byParent.has(parentKey)) byParent.set(parentKey, []);
      byParent.get(parentKey).push(node.id);
    }

    for (const children of byParent.values()) {
      const sorted = children.slice().sort(compareId);
      assert.deepEqual(children, sorted, `seed ${seed}: sibling order is not sorted`);
    }
  }
});

console.log("All CRDT convergence checks passed.");
