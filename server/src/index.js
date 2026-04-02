import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8080);
const wss = new WebSocketServer({ port });

const rooms = new Map();

function idKey(id) {
  return `${id?.lamport}:${id?.site}`;
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      history: [],
      nextSeq: 1,
      seenOps: new Map()
    });
  }
  return rooms.get(roomId);
}

function safeSend(client, message) {
  if (client.readyState === client.OPEN) {
    client.send(JSON.stringify(message));
  }
}

function broadcast(room, payload) {
  for (const client of room.clients) {
    safeSend(client, payload);
  }
}

function sendPresence(room, roomId) {
  const payload = { kind: "presence", roomId, users: room.clients.size };
  broadcast(room, payload);
}

function handleHello(socket, room, roomId, payload) {
  const sinceRaw = Number(payload?.sinceSeq ?? 0);
  const sinceSeq = Number.isFinite(sinceRaw) ? Math.max(0, Math.floor(sinceRaw)) : 0;

  const events = room.history.filter((entry) => entry.seq > sinceSeq);
  safeSend(socket, {
    kind: "history",
    roomId,
    fromSeq: sinceSeq,
    toSeq: room.nextSeq - 1,
    events
  });
}

function handleOp(socket, room, roomId, payload) {
  if (!payload?.op?.opId) return;

  const op = payload.op;
  const opKey = idKey(op.opId);

  if (room.seenOps.has(opKey)) {
    const seq = room.seenOps.get(opKey);
    safeSend(socket, { kind: "ack", roomId, seq, opId: op.opId });
    return;
  }

  const seq = room.nextSeq;
  room.nextSeq += 1;

  const entry = { seq, op };
  room.history.push(entry);
  room.seenOps.set(opKey, seq);

  if (room.history.length > 50000) {
    const removed = room.history.splice(0, room.history.length - 50000);
    for (const old of removed) {
      room.seenOps.delete(idKey(old.op.opId));
    }
  }

  broadcast(room, { kind: "op", roomId, seq, op });
  safeSend(socket, { kind: "ack", roomId, seq, opId: op.opId });
}

wss.on("connection", (socket, request) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const roomId = url.searchParams.get("room") || "default";
  const room = getRoom(roomId);

  room.clients.add(socket);
  sendPresence(room, roomId);

  socket.on("message", (buffer) => {
    let payload;
    try {
      payload = JSON.parse(buffer.toString());
    } catch {
      return;
    }

    if (payload?.kind === "hello") {
      handleHello(socket, room, roomId, payload);
      return;
    }

    if (payload?.kind === "op") {
      handleOp(socket, room, roomId, payload);
    }
  });

  socket.on("close", () => {
    room.clients.delete(socket);
    if (room.clients.size === 0 && room.history.length === 0) {
      rooms.delete(roomId);
      return;
    }
    sendPresence(room, roomId);
  });
});

console.log(`SyncPad relay server listening on ws://localhost:${port}`);
