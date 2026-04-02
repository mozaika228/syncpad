import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  GENESIS_BLOCK_ID,
  RichTextDocument,
  countTombstones,
  createCompactedSnapshot,
  computeSingleSpanDiff,
  createSiteId,
  idKey,
  maxLamportFromOp,
  restoreFromCompactedSnapshot
} from "../../shared/src/rich-crdt";

function readRuntimeConfig() {
  const params = new URLSearchParams(window.location.search);
  const tenantId = params.get("tenant") || import.meta.env.VITE_TENANT_ID || "public";
  const roomId = params.get("room") || import.meta.env.VITE_ROOM_ID || "default";
  const userId = params.get("user") || import.meta.env.VITE_USER_ID || "anon";
  const authToken = params.get("token") || import.meta.env.VITE_AUTH_TOKEN || "";
  return { tenantId, roomId, userId, authToken };
}

const RUNTIME = readRuntimeConfig();
const WS_URL =
  (import.meta.env.VITE_WS_URL || "ws://localhost:8080") +
  `/?tenant=${encodeURIComponent(RUNTIME.tenantId)}&room=${encodeURIComponent(
    RUNTIME.roomId
  )}&user=${encodeURIComponent(RUNTIME.userId)}${
    RUNTIME.authToken ? `&token=${encodeURIComponent(RUNTIME.authToken)}` : ""
  }`;
const STORAGE_NS = "syncpad:v3";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toHtml(text) {
  return escapeHtml(text).replaceAll(" ", "&nbsp;");
}

function cloneId(id) {
  return { lamport: id.lamport, site: id.site };
}

function cloneAttrs(attrs = {}) {
  return {
    bold: !!attrs.bold,
    italic: !!attrs.italic,
    underline: !!attrs.underline
  };
}

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort persistence
  }
}

function readNumber(key, fallback = 0) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function writeNumber(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // best-effort persistence
  }
}

function getStableSiteId(room) {
  const key = `${STORAGE_NS}:site:${room}`;
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const next = createSiteId();
    window.localStorage.setItem(key, next);
    return next;
  } catch {
    return createSiteId();
  }
}

function renderSegments(segments, keyPrefix) {
  if (segments.length === 0) return <span className="empty-line">&nbsp;</span>;
  return segments.map((seg, idx) => (
    <span
      key={`${keyPrefix}-${idx}-${seg.key}`}
      className={[
        seg.marks.bold ? "seg-bold" : "",
        seg.marks.italic ? "seg-italic" : "",
        seg.marks.underline ? "seg-underline" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      dangerouslySetInnerHTML={{ __html: toHtml(seg.text) }}
    />
  ));
}

export default function App() {
  const [status, setStatus] = useState("connecting");
  const [peers, setPeers] = useState(1);
  const [rev, setRev] = useState(0);
  const [marks, setMarks] = useState({ bold: false, italic: false, underline: false });
  const [activeBlockKey, setActiveBlockKey] = useState("");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [awarenessMap, setAwarenessMap] = useState({});

  const siteId = useMemo(() => getStableSiteId(`${RUNTIME.tenantId}:${RUNTIME.roomId}`), []);
  const storage = useMemo(
    () => ({
      log: `${STORAGE_NS}:log:${RUNTIME.tenantId}:${RUNTIME.roomId}:${siteId}`,
      outbox: `${STORAGE_NS}:outbox:${RUNTIME.tenantId}:${RUNTIME.roomId}:${siteId}`,
      seq: `${STORAGE_NS}:seq:${RUNTIME.tenantId}:${RUNTIME.roomId}:${siteId}`,
      snapshot: `${STORAGE_NS}:snapshot:${RUNTIME.tenantId}:${RUNTIME.roomId}:${siteId}`
    }),
    [siteId]
  );

  const docRef = useRef(new RichTextDocument());
  const socketRef = useRef(null);
  const lamportRef = useRef(0);
  const lastSeqRef = useRef(0);

  const blockCacheRef = useRef(new Map());
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);

  const logRef = useRef([]);
  const outboxRef = useRef([]);
  const initializedRef = useRef(false);
  const renderQueuedRef = useRef(false);
  const persistTimerRef = useRef(null);

  const localAwarenessRef = useRef({ blockKey: "", start: 0, end: 0, focused: false });
  const awarenessTimerRef = useRef(null);

  const blocks = docRef.current.getBlocks();

  function nextLamport() {
    lamportRef.current += 1;
    return lamportRef.current;
  }

  function absorbLamport(op) {
    lamportRef.current = Math.max(lamportRef.current, maxLamportFromOp(op));
  }

  function scheduleRender() {
    if (renderQueuedRef.current) return;
    renderQueuedRef.current = true;

    window.requestAnimationFrame(() => {
      renderQueuedRef.current = false;
      setRev((v) => v + 1);
    });
  }

  function flushPersistNow() {
    writeJson(storage.log, logRef.current);
    writeJson(storage.outbox, outboxRef.current);
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  }

  function schedulePersist() {
    if (persistTimerRef.current) return;
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      flushPersistNow();
    }, 150);
  }

  function persistLog() {
    schedulePersist();
  }

  function appendLog(op) {
    logRef.current.push(op);
    if (logRef.current.length > 60000) {
      logRef.current = logRef.current.slice(logRef.current.length - 60000);
    }
    persistLog();
  }

  function persistOutbox() {
    schedulePersist();
  }

  function queueOutbox(op) {
    outboxRef.current.push(op);
    persistOutbox();
  }

  function opKeyFromOp(op) {
    return idKey(op.opId);
  }

  function removeOutboxByOpId(opId) {
    if (!opId) return;
    const key = idKey(opId);
    const next = outboxRef.current.filter((item) => opKeyFromOp(item) !== key);
    if (next.length !== outboxRef.current.length) {
      outboxRef.current = next;
      persistOutbox();
    }
  }

  function maybeCompactLocalState(reason) {
    if (outboxRef.current.length > 0) return;

    const tombstones = countTombstones(docRef.current);
    if (logRef.current.length < 2000 && tombstones.total < 1000) return;

    const snapshot = createCompactedSnapshot(docRef.current, {
      tenantId: RUNTIME.tenantId,
      room: RUNTIME.roomId,
      siteId,
      seq: lastSeqRef.current,
      lamport: lamportRef.current,
      compactedAt: Date.now(),
      reason
    });
    writeJson(storage.snapshot, snapshot);

    logRef.current = [];
    persistLog();
    undoStackRef.current = [];
    redoStackRef.current = [];
  }

  function sendRaw(payload) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function emit(op) {
    sendRaw({ kind: "op", tenantId: RUNTIME.tenantId, roomId: RUNTIME.roomId, op });
  }

  function flushOutbox() {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const op of outboxRef.current) {
      sendRaw({ kind: "op", tenantId: RUNTIME.tenantId, roomId: RUNTIME.roomId, op });
    }
  }

  function sendHello() {
    sendRaw({
      kind: "hello",
      tenantId: RUNTIME.tenantId,
      roomId: RUNTIME.roomId,
      userId: RUNTIME.userId,
      authToken: RUNTIME.authToken,
      sinceSeq: lastSeqRef.current,
      siteId
    });
  }

  function emitAwareness(force = false) {
    const state = localAwarenessRef.current;
    if (!force && !state.focused) return;

    sendRaw({
      kind: "awareness",
      tenantId: RUNTIME.tenantId,
      roomId: RUNTIME.roomId,
      awareness: {
        blockKey: state.blockKey,
        start: state.start,
        end: state.end,
        focused: state.focused
      }
    });
  }

  function scheduleAwarenessEmit() {
    if (awarenessTimerRef.current) return;
    awarenessTimerRef.current = window.setTimeout(() => {
      awarenessTimerRef.current = null;
      emitAwareness(false);
    }, 80);
  }

  function setLocalAwareness(next) {
    localAwarenessRef.current = {
      blockKey: next.blockKey ?? localAwarenessRef.current.blockKey,
      start: Number.isInteger(next.start) ? Math.max(0, next.start) : localAwarenessRef.current.start,
      end: Number.isInteger(next.end) ? Math.max(0, next.end) : localAwarenessRef.current.end,
      focused: typeof next.focused === "boolean" ? next.focused : localAwarenessRef.current.focused
    };
    scheduleAwarenessEmit();
  }

  function applyAndRender(op, persist = true) {
    const changed = docRef.current.applyOperation(op);
    absorbLamport(op);
    if (changed) {
      if (persist) appendLog(op);
      scheduleRender();
    }
    return changed;
  }

  function applyServerEntry(seq, op) {
    if (typeof seq === "number") {
      if (seq <= lastSeqRef.current) {
        removeOutboxByOpId(op?.opId);
        return;
      }
      if (seq > lastSeqRef.current + 1) {
        sendHello();
        return;
      }
    }

    applyAndRender(op, true);

    if (typeof seq === "number") {
      lastSeqRef.current = seq;
      writeNumber(storage.seq, seq);
    }

    removeOutboxByOpId(op?.opId);
    maybeCompactLocalState("server_seq_advance");
  }

  function makeOpFromDescriptor(desc) {
    const opId = { lamport: nextLamport(), site: siteId };

    if (desc.type === "block_insert") return { type: "block_insert", opId, after: cloneId(desc.after), blockType: desc.blockType };
    if (desc.type === "block_delete") return { type: "block_delete", opId, target: cloneId(desc.target) };
    if (desc.type === "block_format") return { type: "block_format", opId, target: cloneId(desc.target), blockType: desc.blockType };
    if (desc.type === "text_insert") {
      return {
        type: "text_insert",
        opId,
        block: cloneId(desc.block),
        after: cloneId(desc.after),
        value: desc.value,
        attrs: cloneAttrs(desc.attrs)
      };
    }
    if (desc.type === "text_delete") return { type: "text_delete", opId, block: cloneId(desc.block), target: cloneId(desc.target) };
    if (desc.type === "text_format") {
      return {
        type: "text_format",
        opId,
        block: cloneId(desc.block),
        target: cloneId(desc.target),
        attrs: cloneAttrs(desc.attrs)
      };
    }

    return null;
  }

  function buildInverseDescriptors(op) {
    if (op.type === "block_insert") return [{ type: "block_delete", target: cloneId(op.opId) }];

    if (op.type === "block_delete") {
      const block = docRef.current.blocks.get(idKey(op.target));
      if (!block || idKey(block.id) === idKey(GENESIS_BLOCK_ID)) return [];
      return [{ type: "block_insert", after: cloneId(block.after), blockType: block.type }];
    }

    if (op.type === "block_format") {
      const block = docRef.current.blocks.get(idKey(op.target));
      if (!block) return [];
      return [{ type: "block_format", target: cloneId(op.target), blockType: block.type }];
    }

    if (op.type === "text_insert") return [{ type: "text_delete", block: cloneId(op.block), target: cloneId(op.opId) }];

    if (op.type === "text_delete") {
      const inline = docRef.current.textByBlock.get(idKey(op.block));
      const node = inline?.nodes.get(idKey(op.target));
      if (!inline || !node) return [];
      return [{ type: "text_insert", block: cloneId(op.block), after: cloneId(node.after), value: node.value, attrs: cloneAttrs(node.attrs) }];
    }

    if (op.type === "text_format") {
      const inline = docRef.current.textByBlock.get(idKey(op.block));
      const node = inline?.nodes.get(idKey(op.target));
      if (!inline || !node) return [];
      const prev = {};
      for (const key of Object.keys(op.attrs || {})) prev[key] = !!node.attrs[key];
      return [{ type: "text_format", block: cloneId(op.block), target: cloneId(op.target), attrs: prev }];
    }

    return [];
  }

  function executeLocalOps(ops, pushUndo = true, clearRedo = true) {
    const inverseBatch = [];

    for (const op of ops) {
      const inverses = buildInverseDescriptors(op);
      for (const inv of inverses) inverseBatch.unshift(inv);

      queueOutbox(op);
      applyAndRender(op, true);
      emit(op);
    }

    if (pushUndo && inverseBatch.length > 0) {
      undoStackRef.current.push(inverseBatch);
      if (clearRedo) redoStackRef.current = [];
    }

    flushOutbox();
    maybeCompactLocalState("local_ops");
  }

  function executeDescriptorBatch(batch, pushUndo, clearRedo) {
    if (!batch || batch.length === 0) return;
    const ops = batch.map((desc) => makeOpFromDescriptor(desc)).filter(Boolean);
    executeLocalOps(ops, pushUndo, clearRedo);
  }

  function runUndo() {
    const batch = undoStackRef.current.pop();
    if (!batch) return;

    const redoBatch = [];
    for (const desc of batch) {
      const op = makeOpFromDescriptor(desc);
      if (!op) continue;

      const inverses = buildInverseDescriptors(op);
      for (const inv of inverses) redoBatch.unshift(inv);

      queueOutbox(op);
      applyAndRender(op, true);
      emit(op);
    }

    if (redoBatch.length > 0) redoStackRef.current.push(redoBatch);
    flushOutbox();
  }

  function runRedo() {
    const batch = redoStackRef.current.pop();
    if (!batch) return;
    executeDescriptorBatch(batch, true, false);
  }

  function applyInlineFormat(attr) {
    if (!activeBlockKey || selection.start === selection.end) return;

    const block = blocks.find((b) => idKey(b.id) === activeBlockKey);
    if (!block) return;

    const nextValue = !marks[attr];
    const ops = [];
    for (let i = selection.start; i < selection.end; i += 1) {
      const op = docRef.current.makeFormatTextOp(block.id, i, { [attr]: nextValue }, siteId, nextLamport());
      if (!op) continue;
      ops.push(op);
    }
    executeLocalOps(ops, true, true);
    setMarks((m) => ({ ...m, [attr]: nextValue }));
  }

  function applyBlockType(blockId, blockType) {
    const op = docRef.current.makeFormatBlockOp(blockId, blockType, siteId, nextLamport());
    if (!op) return;
    executeLocalOps([op], true, true);
  }

  function addBlockAfter(blockId) {
    const op = docRef.current.makeInsertBlockAfter(blockId, "paragraph", siteId, nextLamport());
    executeLocalOps([op], true, true);
  }

  function deleteBlock(blockId) {
    const op = docRef.current.makeDeleteBlock(blockId, siteId, nextLamport());
    if (!op) return;
    executeLocalOps([op], true, true);
  }

  function onBlockTextChanged(blockId, nextText) {
    const key = idKey(blockId);
    const prevText = blockCacheRef.current.get(key) ?? "";
    const delta = computeSingleSpanDiff(prevText, nextText);
    if (!delta) return;

    if (delta.removed.length > 0) {
      const ops = [];
      for (let i = 0; i < delta.removed.length; i += 1) {
        const op = docRef.current.makeDeleteTextOp(blockId, delta.start, siteId, nextLamport());
        if (!op) continue;
        ops.push(op);
      }
      executeLocalOps(ops, true, true);
    }

    if (delta.inserted.length > 0) {
      const ops = [];
      for (let i = 0; i < delta.inserted.length; i += 1) {
        const op = docRef.current.makeInsertTextOp(blockId, delta.start + i, delta.inserted[i], siteId, nextLamport(), marks);
        if (!op) continue;
        ops.push(op);
      }
      executeLocalOps(ops, true, true);
    }

    const current = docRef.current.getBlocks().find((b) => idKey(b.id) === key);
    blockCacheRef.current.set(key, current ? current.text : "");
  }

  function updateSelection(event, blockId) {
    const start = event.target.selectionStart || 0;
    const end = event.target.selectionEnd || 0;
    const blockKey = idKey(blockId);

    setActiveBlockKey(blockKey);
    setSelection({ start, end });
    setLocalAwareness({ blockKey, start, end, focused: true });
  }

  function onInputBlur() {
    setLocalAwareness({ focused: false });
  }

  useEffect(() => {
    if (initializedRef.current) return;

    const loadedSnapshot = readJson(storage.snapshot, null);
    const loadedLog = readJson(storage.log, []);
    const loadedOutbox = readJson(storage.outbox, []);
    const loadedSeq = readNumber(storage.seq, 0);

    if (loadedSnapshot) {
      docRef.current = restoreFromCompactedSnapshot(loadedSnapshot);
      lamportRef.current = Math.max(lamportRef.current, Number(loadedSnapshot?.meta?.lamport || 0));
    }

    logRef.current = Array.isArray(loadedLog) ? loadedLog : [];
    outboxRef.current = Array.isArray(loadedOutbox) ? loadedOutbox : [];
    const snapshotSeq = Number(loadedSnapshot?.meta?.seq || 0);
    lastSeqRef.current = Math.max(loadedSeq, Number.isFinite(snapshotSeq) ? snapshotSeq : 0);

    let maxLamport = 0;
    for (const op of logRef.current) {
      docRef.current.applyOperation(op);
      maxLamport = Math.max(maxLamport, maxLamportFromOp(op));
    }
    for (const op of outboxRef.current) {
      maxLamport = Math.max(maxLamport, maxLamportFromOp(op));
    }

    lamportRef.current = maxLamport;
    initializedRef.current = true;
    scheduleRender();
  }, [storage]);

  useEffect(() => {
    let stopped = false;
    let reconnectTimer = null;

    function connect() {
      if (stopped) return;
      setStatus("connecting");

      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setStatus("online");
        sendHello();
        flushOutbox();
        emitAwareness(true);
      });

      socket.addEventListener("close", () => {
        setStatus("offline");
        setAwarenessMap({});
        if (!stopped) reconnectTimer = window.setTimeout(connect, 1500);
      });

      socket.addEventListener("error", () => {
        setStatus("offline");
      });

      socket.addEventListener("message", (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (
          payload.tenantId &&
          (payload.tenantId !== RUNTIME.tenantId || payload.roomId !== RUNTIME.roomId)
        ) {
          return;
        }

        if (payload.kind === "history" && Array.isArray(payload.events)) {
          const events = payload.events.slice().sort((a, b) => a.seq - b.seq);
          for (const entry of events) applyServerEntry(entry.seq, entry.op);
          return;
        }

        if (payload.kind === "op" && payload.op) {
          applyServerEntry(payload.seq, payload.op);
          return;
        }

        if (payload.kind === "ack") {
          if (typeof payload.seq === "number" && payload.seq > lastSeqRef.current) {
            lastSeqRef.current = payload.seq;
            writeNumber(storage.seq, payload.seq);
          }
          removeOutboxByOpId(payload.opId);
          return;
        }

        if (payload.kind === "presence") {
          setPeers(payload.users || 1);
          return;
        }

        if (payload.kind === "awareness_snapshot" && Array.isArray(payload.users)) {
          const next = {};
          for (const user of payload.users) {
            if (!user?.socketId) continue;
            if (user.siteId === siteId) continue;
            next[user.socketId] = user;
          }
          setAwarenessMap(next);
          return;
        }

        if (payload.kind === "awareness_update" && payload.user?.socketId) {
          if (payload.user.siteId === siteId) return;
          setAwarenessMap((prev) => ({ ...prev, [payload.user.socketId]: payload.user }));
          return;
        }

        if (payload.kind === "awareness_remove" && payload.socketId) {
          setAwarenessMap((prev) => {
            const next = { ...prev };
            delete next[payload.socketId];
            return next;
          });
          return;
        }

        if (payload.kind === "error") {
          setStatus("offline");
        }
      });
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      flushPersistNow();
    };
  }, [siteId, storage]);

  useEffect(() => {
    function onBeforeUnload() {
      setLocalAwareness({ focused: false });
      emitAwareness(true);
      flushPersistNow();
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (awarenessTimerRef.current) {
        window.clearTimeout(awarenessTimerRef.current);
        awarenessTimerRef.current = null;
      }
    };
  }, [storage]);

  useEffect(() => {
    function onKeyDown(event) {
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;

      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        runUndo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        runRedo();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const cache = new Map();
    for (const block of blocks) cache.set(idKey(block.id), block.text);
    blockCacheRef.current = cache;
    if (!activeBlockKey && blocks.length > 0) setActiveBlockKey(idKey(blocks[0].id));
  }, [rev]);

  function renderRichBlock(block, idx) {
    const content = renderSegments(block.segments, `preview-${idx}`);
    if (block.type === "heading1") return <h1 key={`rb-${idx}`} className="rich-h1">{content}</h1>;
    if (block.type === "bullet") {
      return (
        <ul key={`rb-${idx}`} className="rich-ul">
          <li>{content}</li>
        </ul>
      );
    }
    return <p key={`rb-${idx}`} className="rich-p">{content}</p>;
  }

  const awarenessUsers = Object.values(awarenessMap).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const byBlockAwareness = awarenessUsers.reduce((acc, user) => {
    if (!user.blockKey || !user.focused) return acc;
    acc[user.blockKey] = (acc[user.blockKey] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="app" data-rev={rev}>
      <header className="header">
        <h1>SyncPad</h1>
        <div className="meta">
          <span className={`badge ${status}`}>{status}</span>
          <span className="badge">tenant: {RUNTIME.tenantId}</span>
          <span className="badge">room: {RUNTIME.roomId}</span>
          <span className="badge">user: {RUNTIME.userId}</span>
          <span className="badge">site: {siteId}</span>
          <span className="badge">peers: {peers}</span>
        </div>
      </header>

      <div className="toolbar">
        <button type="button" onClick={runUndo}>Undo</button>
        <button type="button" onClick={runRedo}>Redo</button>
        <div className="divider" />
        <button type="button" onClick={() => applyInlineFormat("bold")}>B</button>
        <button type="button" onClick={() => applyInlineFormat("italic")}>I</button>
        <button type="button" onClick={() => applyInlineFormat("underline")}>U</button>
      </div>

      <div className="awareness-bar">
        <span className="awareness-title">Live cursors:</span>
        {awarenessUsers.length === 0 ? (
          <span className="awareness-empty">no active remote cursors</span>
        ) : (
          awarenessUsers.map((user) => (
            <span key={user.socketId} className="awareness-chip">
              {user.userId || "anon"} @{user.blockKey || "-"} [{user.start},{user.end}]
            </span>
          ))
        )}
      </div>

      <section className="layout">
        <div className="panel">
          <h2>Collaborative Rich Blocks (CRDT)</h2>
          <div className="blocks-editor">
            {blocks.map((block, index) => {
              const blockKey = idKey(block.id);
              const activeCount = byBlockAwareness[blockKey] || 0;
              return (
                <div key={blockKey} className="block-row">
                  <select value={block.type} onChange={(e) => applyBlockType(block.id, e.target.value)}>
                    <option value="paragraph">Paragraph</option>
                    <option value="heading1">Heading</option>
                    <option value="bullet">Bullet</option>
                  </select>

                  <div className="block-input-wrap">
                    <input
                      value={block.text}
                      onFocus={(e) => updateSelection(e, block.id)}
                      onBlur={onInputBlur}
                      onSelect={(e) => updateSelection(e, block.id)}
                      onKeyUp={(e) => updateSelection(e, block.id)}
                      onMouseUp={(e) => updateSelection(e, block.id)}
                      onChange={(e) => onBlockTextChanged(block.id, e.target.value)}
                      placeholder="Type text..."
                    />
                    {activeCount > 0 ? <span className="cursor-count">{activeCount}</span> : null}
                  </div>

                  <button type="button" onClick={() => addBlockAfter(block.id)}>+</button>
                  <button type="button" onClick={() => deleteBlock(block.id)} disabled={index === 0}>-</button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <h2>Structured Preview (Block + Inline CRDT)</h2>
          <div className="preview">
            {blocks.length === 0 ? <p className="empty">No content yet.</p> : blocks.map(renderRichBlock)}
          </div>
        </div>
      </section>
    </div>
  );
}
