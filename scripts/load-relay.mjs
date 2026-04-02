import { WebSocket } from "ws";

const URL = process.env.RELAY_URL || "ws://127.0.0.1:8080/?tenant=bench&room=load&user=";
const CLIENTS = Number(process.env.BENCH_CLIENTS || 20);
const OPS_PER_CLIENT = Number(process.env.BENCH_OPS_PER_CLIENT || 200);

function now() {
  return performance.now();
}

async function connectClient(id) {
  const ws = new WebSocket(`${URL}${id}`);

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.send(JSON.stringify({
    v: 1,
    kind: "hello",
    tenantId: "bench",
    roomId: "load",
    userId: `u${id}`,
    sinceSeq: 0,
    siteId: `s${id}`
  }));

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

async function run() {
  const sockets = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    sockets.push(await connectClient(i + 1));
  }

  let ackCount = 0;
  let sentCount = 0;
  const start = now();

  const ackPromises = sockets.map((ws) =>
    new Promise((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.kind === "ack") {
          ackCount += 1;
          if (ackCount >= CLIENTS * OPS_PER_CLIENT) resolve();
        }
      });
    })
  );

  for (let c = 0; c < CLIENTS; c += 1) {
    const ws = sockets[c];
    for (let i = 0; i < OPS_PER_CLIENT; i += 1) {
      sentCount += 1;
      ws.send(
        JSON.stringify({
          v: 1,
          kind: "op",
          tenantId: "bench",
          roomId: "load",
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

  await Promise.race([
    Promise.all(ackPromises),
    new Promise((_, reject) => setTimeout(() => reject(new Error("benchmark timeout")), 20000))
  ]);

  const elapsedMs = now() - start;
  const opsPerSec = ((sentCount / elapsedMs) * 1000).toFixed(1);

  console.log(JSON.stringify({ clients: CLIENTS, opsPerClient: OPS_PER_CLIENT, sentCount, elapsedMs, opsPerSec }, null, 2));

  sockets.forEach((s) => s.close());
}

run().catch((err) => {
  console.error("load benchmark failed", err);
  process.exit(1);
});
