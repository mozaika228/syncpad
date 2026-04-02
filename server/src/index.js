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

const maxRoomsPerTenant = Number(process.env.MAX_ROOMS_PER_TENANT || 500);
const maxClientsPerTenant = Number(process.env.MAX_CLIENTS_PER_TENANT || 2000);
const maxOpsPerSecondPerSocket = Number(process.env.MAX_OPS_PER_SECOND_PER_SOCKET || 400);
const maxBytesPerSecondPerSocket = Number(process.env.MAX_BYTES_PER_SECOND_PER_SOCKET || 512 * 1024);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const globalAuthToken = process.env.RELAY_AUTH_TOKEN || "";
const tenantTokens = (() => {
  try {
    return JSON.parse(process.env.TENANT_TOKENS_JSON || "{}");
  } catch {
    return {};
  }
})();

const rooms = new Map();
const tenantStats = new Map();
let socketSeq = 0;

const metrics = {
  connectionsAccepted: 0,
  connectionsRejected: 0,
  authRejected: 0,
  originRejected: 0,
  rateLimited: 0,
  schemaRejected: 0,
  awarenessMessages: 0,
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

function sanitizeTenant(input) {
  const value = String(input || "public").trim();
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value) ? value : null;
}

function sanitizeRoom(input) {
  const value = String(input || "default").trim();
  return /^[a-zA-Z0-9._-]{1,128}$/.test(value) ? value : null;
}

function normalizeTenantRoom(tenantId, roomId) {
  const tenant = sanitizeTenant(tenantId);
  const room = sanitizeRoom(roomId);
  if (!tenant || !room) return null;
  return { tenant, room, key: `${tenant}::${room}` };
}

function getTenantCounter(tenant) {
  if (!tenantStats.has(tenant)) {
    tenantStats.set(tenant, { rooms: 0, clients: 0 });
  }
  return tenantStats.get(tenant);
}

function incTenantRoom(tenant) {
  getTenantCounter(tenant).rooms += 1;
}

function decTenantRoom(tenant) {
  const counter = getTenantCounter(tenant);
  counter.rooms = Math.max(0, counter.rooms - 1);
}

function incTenantClient(tenant) {
  getTenantCounter(tenant).clients += 1;
}

function decTenantClient(tenant) {
  const counter = getTenantCounter(tenant);
  counter.clients = Math.max(0, counter.clients - 1);
}

function getOrCreateRoom(tenantId, roomId) {
  const normalized = normalizeTenantRoom(tenantId, roomId);
  if (!normalized) return null;

  const existing = rooms.get(normalized.key);
  if (existing) {
    existing.lastActiveAt = now();
    return existing;
  }

  const tenantCounter = getTenantCounter(normalized.tenant);
  if (tenantCounter.rooms >= maxRoomsPerTenant) {
    return null;
  }

  const room = {
    key: normalized.key,
    tenantId: normalized.tenant,
    roomId: normalized.room,
    clients: new Set(),
    history: [],
    nextSeq: 1,
    baseSeq: 1,
    seenOps: new Map(),
    awareness: new Map(),
    createdAt: now(),
    lastActiveAt: now()
  };
  rooms.set(normalized.key, room);
  incTenantRoom(normalized.tenant);
  return room;
}

function roomStats() {
  let clientCount = 0;
  for (const room of rooms.values()) {
    clientCount += room.clients.size;
  }
  return { roomCount: rooms.size, clientCount };
}

function validateId(value) {
  return (
    value &&
    typeof value === "object" &&
    Number.isInteger(value.lamport) &&
    value.lamport >= 0 &&
    typeof value.site === "string" &&
    value.site.length > 0 &&
    value.site.length <= 128
  );
}

function validateAttrs(value) {
  if (!value || typeof value !== "object") return false;
  for (const [k, v] of Object.entries(value)) {
    if (!["bold", "italic", "underline"].includes(k)) return false;
    if (typeof v !== "boolean") return false;
  }
  return true;
}

function validateOp(op) {
  if (!op || typeof op !== "object") return false;
  if (!validateId(op.opId)) return false;

  if (op.type === "block_insert") return validateId(op.after) && typeof op.blockType === "string";
  if (op.type === "block_delete") return validateId(op.target);
  if (op.type === "block_format") return validateId(op.target) && typeof op.blockType === "string";
  if (op.type === "text_insert") {
    return (
      validateId(op.block) &&
      validateId(op.after) &&
      typeof op.value === "string" &&
      op.value.length <= 4 &&
      validateAttrs(op.attrs || {})
    );
  }
  if (op.type === "text_delete") return validateId(op.block) && validateId(op.target);
  if (op.type === "text_format") return validateId(op.block) && validateId(op.target) && validateAttrs(op.attrs || {});
  return false;
}

function validateAwareness(awareness) {
  if (!awareness || typeof awareness !== "object") return false;
  if (awareness.blockKey != null && (typeof awareness.blockKey !== "string" || awareness.blockKey.length > 200)) {
    return false;
  }
  if (awareness.start != null && (!Number.isInteger(awareness.start) || awareness.start < 0)) return false;
  if (awareness.end != null && (!Number.isInteger(awareness.end) || awareness.end < 0)) return false;
  if (awareness.focused != null && typeof awareness.focused !== "boolean") return false;
  return true;
}

function authAllowed(tenantId, token) {
  if (tenantTokens && typeof tenantTokens === "object" && tenantTokens[tenantId]) {
    return token === String(tenantTokens[tenantId]);
  }
  if (globalAuthToken) return token === globalAuthToken;
  return true;
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

function safeSendSerialized(socket, serialized) {
  if (socket.readyState !== socket.OPEN) return false;
  if (socket.bufferedAmount > maxBufferedBytes) {
    metrics.messagesDroppedBackpressure += 1;
    return false;
  }

  try {
    socket.send(serialized);
    return true;
  } catch {
    return false;
  }
}

function rejectSocket(socket, code, reason) {
  try {
    safeSend(socket, { kind: "error", code, reason });
  } finally {
    socket.close(1008, reason);
  }
}

function rateAllowed(socket, bytes) {
  const ts = now();
  const elapsed = (ts - socket.rate.lastRefillAt) / 1000;

  socket.rate.opsTokens = Math.min(maxOpsPerSecondPerSocket, socket.rate.opsTokens + elapsed * maxOpsPerSecondPerSocket);
  socket.rate.bytesTokens = Math.min(
    maxBytesPerSecondPerSocket,
    socket.rate.bytesTokens + elapsed * maxBytesPerSecondPerSocket
  );
  socket.rate.lastRefillAt = ts;

  if (socket.rate.opsTokens < 1 || socket.rate.bytesTokens < bytes) {
    metrics.rateLimited += 1;
    return false;
  }

  socket.rate.opsTokens -= 1;
  socket.rate.bytesTokens -= bytes;
  return true;
}

function broadcast(room, payload) {
  const serialized = JSON.stringify(payload);
  for (const socket of room.clients) {
    const sent = safeSendSerialized(socket, serialized);
    if (sent) metrics.messagesBroadcast += 1;
  }
}

function sendPresence(room) {
  broadcast(room, {
    kind: "presence",
    tenantId: room.tenantId,
    roomId: room.roomId,
    users: room.clients.size
  });
}

function broadcastAwareness(room, payload) {
  metrics.awarenessMessages += 1;
  broadcast(room, {
    kind: "awareness_update",
    tenantId: room.tenantId,
    roomId: room.roomId,
    ...payload
  });
}

function sendAwarenessSnapshot(socket, room) {
  safeSend(socket, {
    kind: "awareness_snapshot",
    tenantId: room.tenantId,
    roomId: room.roomId,
    users: [...room.awareness.values()]
  });
}

function historySliceFromSeq(room, sinceSeq) {
  if (room.history.length === 0) return { events: [], truncated: false };
  if (sinceSeq < room.baseSeq - 1) return { events: room.history.slice(), truncated: true };

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

function validateHelloPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.kind !== "hello") return false;
  if (payload.sinceSeq != null && !Number.isFinite(Number(payload.sinceSeq))) return false;
  if (payload.tenantId != null && sanitizeTenant(payload.tenantId) === null) return false;
  if (payload.roomId != null && sanitizeRoom(payload.roomId) === null) return false;
  if (payload.userId != null && String(payload.userId).length > 128) return false;
  if (payload.authToken != null && String(payload.authToken).length > 512) return false;
  return true;
}

function handleHello(socket, room, payload) {
  metrics.historyRequests += 1;

  if (!validateHelloPayload(payload)) {
    metrics.schemaRejected += 1;
    rejectSocket(socket, "bad_hello", "hello payload validation failed");
    return;
  }

  const helloTenant = payload.tenantId || room.tenantId;
  const helloRoom = payload.roomId || room.roomId;
  if (helloTenant !== room.tenantId || helloRoom !== room.roomId) {
    rejectSocket(socket, "tenant_room_mismatch", "tenant/room mismatch");
    return;
  }

  const token = String(payload.authToken || socket.bootstrap.authToken || "");
  if (!authAllowed(room.tenantId, token)) {
    metrics.authRejected += 1;
    rejectSocket(socket, "auth_failed", "invalid token");
    return;
  }

  socket.session = {
    ready: true,
    userId: String(payload.userId || socket.bootstrap.userId || "anon"),
    siteId: String(payload.siteId || socket.bootstrap.siteId || ""),
    tenantId: room.tenantId,
    roomId: room.roomId,
    authTokenPresent: !!token
  };

  const sinceRaw = Number(payload?.sinceSeq ?? 0);
  const sinceSeq = Number.isFinite(sinceRaw) ? Math.max(0, Math.floor(sinceRaw)) : 0;

  const { events, truncated } = historySliceFromSeq(room, sinceSeq);
  safeSend(socket, {
    kind: "history",
    tenantId: room.tenantId,
    roomId: room.roomId,
    fromSeq: sinceSeq,
    toSeq: room.nextSeq - 1,
    baseSeq: room.baseSeq,
    truncated,
    events
  });

  sendAwarenessSnapshot(socket, room);
}

function validateOpPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.kind !== "op") return false;
  return validateOp(payload.op);
}

function handleOp(socket, room, payload) {
  if (!socket.session?.ready) {
    rejectSocket(socket, "hello_required", "hello handshake required before ops");
    return;
  }

  if (!validateOpPayload(payload)) {
    metrics.schemaRejected += 1;
    rejectSocket(socket, "bad_op", "op payload validation failed");
    return;
  }

  const op = payload.op;
  const opKey = idKey(op.opId);

  if (room.seenOps.has(opKey)) {
    metrics.duplicateOps += 1;
    const seq = room.seenOps.get(opKey);
    safeSend(socket, {
      kind: "ack",
      tenantId: room.tenantId,
      roomId: room.roomId,
      seq,
      opId: op.opId,
      duplicate: true
    });
    return;
  }

  const seq = room.nextSeq;
  room.nextSeq += 1;
  room.lastActiveAt = now();

  const entry = { seq, op };
  room.history.push(entry);
  room.seenOps.set(opKey, seq);
  trimHistory(room);

  broadcast(room, { kind: "op", tenantId: room.tenantId, roomId: room.roomId, seq, op });
  safeSend(socket, { kind: "ack", tenantId: room.tenantId, roomId: room.roomId, seq, opId: op.opId });
}

function handleAwareness(socket, room, payload) {
  if (!socket.session?.ready) {
    rejectSocket(socket, "hello_required", "hello handshake required before awareness");
    return;
  }

  if (!validateAwareness(payload?.awareness)) {
    metrics.schemaRejected += 1;
    rejectSocket(socket, "bad_awareness", "awareness payload validation failed");
    return;
  }

  const awareness = {
    socketId: socket.socketId,
    tenantId: room.tenantId,
    roomId: room.roomId,
    userId: socket.session.userId,
    siteId: socket.session.siteId,
    blockKey: payload.awareness.blockKey || "",
    start: payload.awareness.start ?? 0,
    end: payload.awareness.end ?? 0,
    focused: !!payload.awareness.focused,
    updatedAt: now()
  };

  room.awareness.set(socket.socketId, awareness);
  broadcastAwareness(room, { user: awareness });
}

function removeAwarenessForSocket(room, socket) {
  const existing = room.awareness.get(socket.socketId);
  if (!existing) return;

  room.awareness.delete(socket.socketId);
  broadcast(room, {
    kind: "awareness_remove",
    tenantId: room.tenantId,
    roomId: room.roomId,
    socketId: socket.socketId,
    siteId: existing.siteId,
    userId: existing.userId
  });
}

function setupSocket(room, socket, bootstrap) {
  room.clients.add(socket);
  room.lastActiveAt = now();
  incTenantClient(room.tenantId);

  socket.socketId = `s-${++socketSeq}`;
  socket.bootstrap = bootstrap;
  socket.session = { ready: false };
  socket.rate = {
    opsTokens: maxOpsPerSecondPerSocket,
    bytesTokens: maxBytesPerSecondPerSocket,
    lastRefillAt: now()
  };

  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  sendPresence(room);

  socket.on("message", (buffer, isBinary) => {
    metrics.messagesReceived += 1;

    if (isBinary) {
      rejectSocket(socket, "binary_not_allowed", "binary frames are not supported");
      return;
    }

    const raw = buffer.toString();
    if (raw.length > maxMessageBytes) {
      rejectSocket(socket, "message_too_large", "message exceeds limit");
      return;
    }

    if (!rateAllowed(socket, raw.length)) {
      rejectSocket(socket, "rate_limited", "rate limit exceeded");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      metrics.schemaRejected += 1;
      rejectSocket(socket, "invalid_json", "json parse failed");
      return;
    }

    if (payload?.kind === "hello") {
      handleHello(socket, room, payload);
      return;
    }

    if (payload?.kind === "op") {
      handleOp(socket, room, payload);
      return;
    }

    if (payload?.kind === "awareness") {
      handleAwareness(socket, room, payload);
      return;
    }

    metrics.schemaRejected += 1;
    rejectSocket(socket, "unknown_kind", "unsupported message kind");
  });

  socket.on("close", () => {
    room.clients.delete(socket);
    removeAwarenessForSocket(room, socket);
    decTenantClient(room.tenantId);
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
    res.end(JSON.stringify({ ok: true, ts: now(), wsPath, rooms: stats.roomCount, clients: stats.clientCount }));
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
          maxRoomsPerTenant,
          maxClientsPerTenant,
          maxMessageBytes,
          maxBufferedBytes,
          maxOpsPerSecondPerSocket,
          maxBytesPerSecondPerSocket,
          heartbeatIntervalMs,
          roomIdleTtlMs,
          roomGcIntervalMs,
          allowedOrigins,
          authEnabled: !!globalAuthToken || Object.keys(tenantTokens).length > 0
        },
        stats,
        tenants: Object.fromEntries(tenantStats),
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

  const origin = String(request.headers.origin || "");
  if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
    metrics.originRejected += 1;
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\norigin_not_allowed");
    socket.destroy();
    return;
  }

  const tenantId = url.searchParams.get("tenant") || "public";
  const roomId = url.searchParams.get("room") || "default";
  const normalized = normalizeTenantRoom(tenantId, roomId);

  if (!normalized) {
    metrics.connectionsRejected += 1;
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\ninvalid_tenant_or_room");
    socket.destroy();
    return;
  }

  const tenantCounter = getTenantCounter(normalized.tenant);
  if (tenantCounter.clients >= maxClientsPerTenant) {
    metrics.connectionsRejected += 1;
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\ntenant_client_limit");
    socket.destroy();
    return;
  }

  const room = getOrCreateRoom(normalized.tenant, normalized.room);
  if (!room) {
    metrics.connectionsRejected += 1;
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\nroom_limit");
    socket.destroy();
    return;
  }

  if (room.clients.size >= maxRoomClients) {
    metrics.connectionsRejected += 1;
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\nroom_full");
    socket.destroy();
    return;
  }

  const bootstrap = {
    tenantId: normalized.tenant,
    roomId: normalized.room,
    userId: url.searchParams.get("user") || "anon",
    siteId: url.searchParams.get("siteId") || "",
    authToken: url.searchParams.get("token") || ""
  };

  wss.handleUpgrade(request, socket, head, (ws) => {
    metrics.connectionsAccepted += 1;
    setupSocket(room, ws, bootstrap);
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
  for (const [roomKey, room] of rooms.entries()) {
    if (room.clients.size > 0) continue;
    if (ts - room.lastActiveAt < roomIdleTtlMs) continue;

    rooms.delete(roomKey);
    decTenantRoom(room.tenantId);
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
