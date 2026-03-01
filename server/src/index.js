import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8080);
const wss = new WebSocketServer({ port });

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      history: []
    });
  }
  return rooms.get(roomId);
}

function safeSend(client, message) {
  if (client.readyState === client.OPEN) {
    client.send(JSON.stringify(message));
  }
}

function broadcast(room, payload, except = null) {
  for (const client of room.clients) {
    if (client === except) continue;
    safeSend(client, payload);
  }
}

wss.on("connection", (socket, request) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const roomId = url.searchParams.get("room") || "default";
  const room = getRoom(roomId);

  room.clients.add(socket);
  safeSend(socket, { kind: "history", roomId, ops: room.history });

  socket.on("message", (buffer) => {
    let payload;
    try {
      payload = JSON.parse(buffer.toString());
    } catch {
      return;
    }

    if (payload?.kind !== "op" || !payload.op) {
      return;
    }

    room.history.push(payload.op);
    if (room.history.length > 20000) {
      room.history.splice(0, room.history.length - 20000);
    }

    broadcast(room, { kind: "op", roomId, op: payload.op }, socket);
  });

  socket.on("close", () => {
    room.clients.delete(socket);
    if (room.clients.size === 0 && room.history.length === 0) {
      rooms.delete(roomId);
    }
  });

  safeSend(socket, { kind: "presence", roomId, users: room.clients.size });
  broadcast(room, { kind: "presence", roomId, users: room.clients.size }, socket);
});

console.log(`SyncPad relay server listening on ws://localhost:${port}`);
