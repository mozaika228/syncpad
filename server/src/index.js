import http from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8080);
const wsPath = process.env.WS_PATH || "/";

const maxHistory = Number(process.env.MAX_HISTORY || 50000);
const maxRoomClients = Number(process.env.MAX_ROOM_CLIENTS || 200);
const maxMessageBytes = Number(process.env.MAX_MESSAGE_BYTES || 128 * 1024);
const maxBufferedBytes = Number(process.env.MAX_BUFFERED_BYTES || 2 * 1024 * 1024);
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 30000);
const roomIdleTtlMs = Number(process.env.ROOM_IDLE_TTL_MS || 10 * 60 * 1000);
const roomGcIntervalMs = Number(process.env.ROOM_GC_INTERVAL_MS || 60 * 1000);

const rooms = new Map();

const metrics = {
  connectionsAccepted: 0,
  connectionsRejected: 0,
  messagesReceived: 0,
  messagesBroadcast: 0,
  messagesDroppedBackpressure: 0,
  historyRequests: 0,
  duplicateOps: 0,
  roomsEvicted: 0,
  socketTerminatedHeartbeat: 0
};

function idKey(id) {
  return `${id?.lamport}:${id?.site}`;
}

function now() {
  return Date.now();
}

function getOrCreateRoom(roomId) {
  const existing = rooms.get(roomId);
  if (existing) {
    existing.lastActiveAt = now();
    return existing;
  }

  const room = {
    id: roomId,
    clients: new Set(),
    history: [],
    nextSeq: 1,
    baseSeq: 1,
    seenOps: new Map(),
    createdAt: now(),
    lastActiveAt: now()
  };
  rooms.set(roomId, room);
  return room;
}

function roomStats() {
  let clientCount = 0;
  for (const room of rooms.values()) {
    clientCount += room.clients.size;
  }
  return { roomCount: rooms.size, clientCount };
}

function safeSend(socket, payload) {
  if (socket.readyState !== socket.OPEN) return false;
  if (socket.bufferedAmount > maxBufferedBytes) {
    metrics.messagesDroppedBackpressure += 1;
    return false;
  }

  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function broadcast(room, payload) {
  for (const socket of room.clients) {
    const sent = safeSend(socket, payload);
    if (sent) metrics.messagesBroadcast += 1;
  }
}

function sendPresence(room) {
  broadcast(room, { kind: "presence", roomId: room.id, users: room.clients.size });
}

function historySliceFromSeq(room, sinceSeq) {
  if (room.history.length === 0) {
    return { events: [], truncated: false };
  }

  if (sinceSeq < room.baseSeq - 1) {
    return { events: room.history.slice(), truncated: true };
  }

  const offset = sinceSeq - room.baseSeq + 1;
  const start = Math.max(0, Math.min(offset, room.history.length));
  return { events: room.history.slice(start), truncated: false };
}

function trimHistory(room) {
  if (room.history.length <= maxHistory) return;

  const overflow = room.history.length - maxHistory;
  const removed = room.history.splice(0, overflow);
  room.baseSeq += overflow;

  for (const entry of removed) {
    room.seenOps.delete(idKey(entry.op.opId));
  }
}

function handleHello(socket, room, payload) {
  metrics.historyRequests += 1;

  const sinceRaw = Number(payload?.sinceSeq ?? 0);
  const sinceSeq = Number.isFinite(sinceRaw) ? Math.max(0, Math.floor(sinceRaw)) : 0;

  const { events, truncated } = historySliceFromSeq(room, sinceSeq);
  safeSend(socket, {
    kind: "history",
    roomId: room.id,
    fromSeq: sinceSeq,
    toSeq: room.nextSeq - 1,
    baseSeq: room.baseSeq,
    truncated,
    events
  });
}

function handleOp(socket, room, payload) {
  if (!payload?.op?.opId) return;

  const op = payload.op;
  const opKey = idKey(op.opId);

  if (room.seenOps.has(opKey)) {
    metrics.duplicateOps += 1;
    const seq = room.seenOps.get(opKey);
    safeSend(socket, { kind: "ack", roomId: room.id, seq, opId: op.opId, duplicate: true });
    return;
  }

  const seq = room.nextSeq;
  room.nextSeq += 1;
  room.lastActiveAt = now();

  const entry = { seq, op };
  room.history.push(entry);
  room.seenOps.set(opKey, seq);
  trimHistory(room);

  broadcast(room, { kind: "op", roomId: room.id, seq, op });
  safeSend(socket, { kind: "ack", roomId: room.id, seq, opId: op.opId });
}

function setupSocket(room, socket) {
  room.clients.add(socket);
  room.lastActiveAt = now();

  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  sendPresence(room);

  socket.on("message", (buffer, isBinary) => {
    metrics.messagesReceived += 1;

    if (isBinary) return;
    const raw = buffer.toString();
    if (raw.length > maxMessageBytes) return;

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    if (payload?.kind === "hello") {
      handleHello(socket, room, payload);
      return;
    }

    if (payload?.kind === "op") {
      handleOp(socket, room, payload);
    }
  });

  socket.on("close", () => {
    room.clients.delete(socket);
    room.lastActiveAt = now();
    sendPresence(room);
  });
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/healthz") {
    const stats = roomStats();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        ts: now(),
        wsPath,
        rooms: stats.roomCount,
        clients: stats.clientCount
      })
    );
    return;
  }

  if (url.pathname === "/metrics") {
    const stats = roomStats();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ts: now(),
        config: {
          port,
          wsPath,
          maxHistory,
          maxRoomClients,
          maxMessageBytes,
          maxBufferedBytes,
          heartbeatIntervalMs,
          roomIdleTtlMs,
          roomGcIntervalMs
        },
        stats,
        counters: metrics
      })
    );
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (url.pathname !== wsPath) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const roomId = url.searchParams.get("room") || "default";
  const room = getOrCreateRoom(roomId);

  if (room.clients.size >= maxRoomClients) {
    metrics.connectionsRejected += 1;
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\nroom_full");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    metrics.connectionsAccepted += 1;
    setupSocket(room, ws);
  });
});

const heartbeatTimer = setInterval(() => {
  for (const room of rooms.values()) {
    for (const socket of room.clients) {
      if (socket.isAlive === false) {
        metrics.socketTerminatedHeartbeat += 1;
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }
}, heartbeatIntervalMs);

const gcTimer = setInterval(() => {
  const ts = now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.clients.size > 0) continue;
    if (ts - room.lastActiveAt < roomIdleTtlMs) continue;

    rooms.delete(roomId);
    metrics.roomsEvicted += 1;
  }
}, roomGcIntervalMs);

server.on("close", () => {
  clearInterval(heartbeatTimer);
  clearInterval(gcTimer);
});

server.listen(port, () => {
  console.log(`SyncPad relay listening on http://localhost:${port} (ws path: ${wsPath})`);
});
