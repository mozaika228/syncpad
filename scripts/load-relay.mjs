import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

const RELAY_PORT = Number(process.env.BENCH_PORT || 8080);
const TENANT = process.env.BENCH_TENANT || "bench";
const ROOM = process.env.BENCH_ROOM || "load";
const URL = process.env.RELAY_URL || `ws://127.0.0.1:${RELAY_PORT}/?tenant=${TENANT}&room=${ROOM}&user=`;

const CLIENTS = Number(process.env.BENCH_CLIENTS || 20);
const OPS_PER_CLIENT = Number(process.env.BENCH_OPS_PER_CLIENT || 200);
const ACK_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 20000);
const SPAWN_RELAY = String(process.env.BENCH_SPAWN_RELAY || "0") === "1";
const RESULT_FILE = process.env.BENCH_RESULT_FILE || "";

function now() {
  return performance.now();
}

async function waitRelayReady(server) {
  let ready = false;
  server.stdout.on("data", (chunk) => {
    if (String(chunk).includes("SyncPad relay listening")) ready = true;
  });

  for (let i = 0; i < 50 && !ready; i += 1) {
    await sleep(100);
  }

  if (!ready) {
    throw new Error("relay did not become ready in time");
  }
}

function maybeSpawnRelay() {
  if (!SPAWN_RELAY) return null;
  return spawn(process.execPath, ["server/src/index.js"], {
    env: { ...process.env, PORT: String(RELAY_PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function connectClient(id) {
  const ws = new WebSocket(`${URL}${id}`);

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.send(
    JSON.stringify({
      v: 1,
      kind: "hello",
      tenantId: TENANT,
      roomId: ROOM,
      userId: `u${id}`,
      sinceSeq: 0,
      siteId: `s${id}`
    })
  );

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hello timeout")), 4000);
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.kind === "history") {
        clearTimeout(t);
        resolve();
      }
    });
  });

  return ws;
}

async function runBench() {
  const sockets = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    sockets.push(await connectClient(i + 1));
  }

  let ackCount = 0;
  let sentCount = 0;
  const expectedAcks = CLIENTS * OPS_PER_CLIENT;
  const start = now();

  const ackDone = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("benchmark timeout")), ACK_TIMEOUT_MS);

    for (const ws of sockets) {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.kind !== "ack") return;
        ackCount += 1;
        if (ackCount >= expectedAcks) {
          clearTimeout(timeout);
          resolve();
        }
      });
    }
  });

  for (let c = 0; c < CLIENTS; c += 1) {
    const ws = sockets[c];
    for (let i = 0; i < OPS_PER_CLIENT; i += 1) {
      sentCount += 1;
      ws.send(
        JSON.stringify({
          v: 1,
          kind: "op",
          tenantId: TENANT,
          roomId: ROOM,
          op: {
            type: "text_insert",
            opId: { lamport: i + 1, site: `s${c + 1}` },
            block: { lamport: 0, site: "block-genesis" },
            after: { lamport: 0, site: "char-root" },
            value: "x",
            attrs: {}
          }
        })
      );
    }
  }

  await ackDone;

  const elapsedMs = now() - start;
  const opsPerSec = Number(((sentCount / elapsedMs) * 1000).toFixed(1));

  const result = {
    clients: CLIENTS,
    opsPerClient: OPS_PER_CLIENT,
    sentCount,
    ackCount,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    opsPerSec,
    ackRatio: Number((ackCount / sentCount).toFixed(4))
  };

  sockets.forEach((s) => s.close());
  return result;
}

async function run() {
  const relay = maybeSpawnRelay();
  try {
    if (relay) await waitRelayReady(relay);

    const result = await runBench();
    const pretty = JSON.stringify(result, null, 2);
    console.log(pretty);

    if (RESULT_FILE) {
      await writeFile(RESULT_FILE, `${JSON.stringify(result)}\n`, "utf8");
    }
  } finally {
    if (relay) relay.kill("SIGTERM");
  }
}

run().catch((err) => {
  console.error("load benchmark failed", err);
  process.exit(1);
});