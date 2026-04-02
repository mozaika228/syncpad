import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.SMOKE_PORT || 8091);
const WS_URL = `ws://127.0.0.1:${PORT}/?tenant=smoke&room=room1&user=u`;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 15000);

function onceMessage(ws, predicate, label, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const seenKinds = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`[${label}] timeout waiting for message (seen kinds: ${seenKinds.join(",")})`));
    }, timeoutMs);

    function onMessage(data) {
      try {
        const msg = JSON.parse(data.toString());
        seenKinds.push(msg.kind || "unknown");
        if (!predicate(msg)) return;
        cleanup();
        resolve(msg);
      } catch {
        // ignore parse errors
      }
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
    }

    ws.on("message", onMessage);
  });
}

function waitForAnyKind(ws, kinds, label, timeoutMs = TIMEOUT_MS) {
  const allowed = new Set(kinds);
  return onceMessage(ws, (m) => allowed.has(m.kind), label, timeoutMs);
}

async function waitRelayReady(server) {
  let ready = false;
  server.stdout.on("data", (chunk) => {
    if (String(chunk).includes("SyncPad relay listening")) ready = true;
  });

  for (let i = 0; i < 80 && !ready; i += 1) {
    await sleep(100);
  }

  if (!ready) {
    throw new Error("relay did not become ready in time");
  }
}

async function run() {
  const wsPkg = await import("ws");
  const WebSocket = wsPkg.WebSocket;

  const server = spawn(process.execPath, ["server/src/index.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitRelayReady(server);

    const a = new WebSocket(`${WS_URL}1`);
    const b = new WebSocket(`${WS_URL}2`);

    await Promise.all([
      new Promise((res, rej) => {
        a.once("open", res);
        a.once("error", rej);
      }),
      new Promise((res, rej) => {
        b.once("open", res);
        b.once("error", rej);
      })
    ]);

    const helloA = { v: 1, kind: "hello", tenantId: "smoke", roomId: "room1", userId: "u1", sinceSeq: 0, siteId: "s1" };
    const helloB = { v: 1, kind: "hello", tenantId: "smoke", roomId: "room1", userId: "u2", sinceSeq: 0, siteId: "s2" };

    const waitHandshakeA = waitForAnyKind(a, ["history", "awareness_snapshot", "presence"], "handshake-a");
    const waitHandshakeB = waitForAnyKind(b, ["history", "awareness_snapshot", "presence"], "handshake-b");

    a.send(JSON.stringify(helloA));
    b.send(JSON.stringify(helloB));

    await Promise.all([waitHandshakeA, waitHandshakeB]);

    const waitAckA = onceMessage(a, (m) => m.kind === "ack", "ack-a");

    a.send(
      JSON.stringify({
        v: 1,
        kind: "op",
        tenantId: "smoke",
        roomId: "room1",
        op: {
          type: "block_insert",
          opId: { lamport: 1, site: "s1" },
          after: { lamport: 0, site: "block-genesis" },
          blockType: "paragraph"
        }
      })
    );

    await waitAckA;

    a.close();
    b.close();
    console.log("E2E smoke passed");
  } finally {
    server.kill("SIGTERM");
  }
}

run().catch((err) => {
  console.error("E2E smoke failed", err);
  process.exit(1);
});