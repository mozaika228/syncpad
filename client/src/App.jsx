import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  RichTextDocument,
  computeSingleSpanDiff,
  createSiteId,
  idKey,
  maxLamportFromOp
} from "../../shared/src/rich-crdt";

const ROOM = "default";
const WS_URL = (import.meta.env.VITE_WS_URL || "ws://localhost:8080") + `/?room=${ROOM}`;

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

  const siteId = useMemo(() => createSiteId(), []);
  const docRef = useRef(new RichTextDocument());
  const socketRef = useRef(null);
  const lamportRef = useRef(0);
  const blockCacheRef = useRef(new Map());

  const blocks = docRef.current.getBlocks();

  function nextLamport() {
    lamportRef.current += 1;
    return lamportRef.current;
  }

  function absorbLamport(op) {
    lamportRef.current = Math.max(lamportRef.current, maxLamportFromOp(op));
  }

  function emit(op) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ kind: "op", room: ROOM, op }));
  }

  function applyAndRender(op) {
    const changed = docRef.current.applyOperation(op);
    absorbLamport(op);
    if (changed) setRev((v) => v + 1);
  }

  function applyInlineFormat(attr) {
    if (!activeBlockKey || selection.start === selection.end) return;

    const block = blocks.find((b) => idKey(b.id) === activeBlockKey);
    if (!block) return;

    const nextValue = !marks[attr];
    for (let i = selection.start; i < selection.end; i += 1) {
      const op = docRef.current.makeFormatTextOp(block.id, i, { [attr]: nextValue }, siteId, nextLamport());
      if (!op) continue;
      applyAndRender(op);
      emit(op);
    }

    setMarks((m) => ({ ...m, [attr]: nextValue }));
  }

  function applyBlockType(blockId, blockType) {
    const op = docRef.current.makeFormatBlockOp(blockId, blockType, siteId, nextLamport());
    if (!op) return;
    applyAndRender(op);
    emit(op);
  }

  function addBlockAfter(blockId) {
    const op = docRef.current.makeInsertBlockAfter(blockId, "paragraph", siteId, nextLamport());
    applyAndRender(op);
    emit(op);
  }

  function deleteBlock(blockId) {
    const op = docRef.current.makeDeleteBlock(blockId, siteId, nextLamport());
    if (!op) return;
    applyAndRender(op);
    emit(op);
  }

  function onBlockTextChanged(blockId, nextText) {
    const key = idKey(blockId);
    const prevText = blockCacheRef.current.get(key) ?? "";
    const delta = computeSingleSpanDiff(prevText, nextText);
    if (!delta) return;

    if (delta.removed.length > 0) {
      for (let i = 0; i < delta.removed.length; i += 1) {
        const op = docRef.current.makeDeleteTextOp(blockId, delta.start, siteId, nextLamport());
        if (!op) continue;
        applyAndRender(op);
        emit(op);
      }
    }

    if (delta.inserted.length > 0) {
      for (let i = 0; i < delta.inserted.length; i += 1) {
        const op = docRef.current.makeInsertTextOp(
          blockId,
          delta.start + i,
          delta.inserted[i],
          siteId,
          nextLamport(),
          marks
        );
        if (!op) continue;
        applyAndRender(op);
        emit(op);
      }
    }

    const current = docRef.current.getBlocks().find((b) => idKey(b.id) === key);
    blockCacheRef.current.set(key, current ? current.text : "");
  }

  function updateSelection(event, blockId) {
    setActiveBlockKey(idKey(blockId));
    setSelection({
      start: event.target.selectionStart || 0,
      end: event.target.selectionEnd || 0
    });
  }

  useEffect(() => {
    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;

    socket.addEventListener("open", () => setStatus("online"));
    socket.addEventListener("close", () => setStatus("offline"));
    socket.addEventListener("error", () => setStatus("offline"));

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.kind === "history" && Array.isArray(payload.ops)) {
        for (const op of payload.ops) applyAndRender(op);
      }
      if (payload.kind === "op" && payload.op) {
        applyAndRender(payload.op);
      }
      if (payload.kind === "presence") {
        setPeers(payload.users || 1);
      }
    });

    return () => socket.close();
  }, []);

  useEffect(() => {
    const cache = new Map();
    for (const block of blocks) cache.set(idKey(block.id), block.text);
    blockCacheRef.current = cache;
    if (!activeBlockKey && blocks.length > 0) {
      setActiveBlockKey(idKey(blocks[0].id));
    }
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

  return (
    <div className="app" data-rev={rev}>
      <header className="header">
        <h1>SyncPad</h1>
        <div className="meta">
          <span className={`badge ${status}`}>{status}</span>
          <span className="badge">room: {ROOM}</span>
          <span className="badge">site: {siteId}</span>
          <span className="badge">peers: {peers}</span>
        </div>
      </header>

      <div className="toolbar">
        <button type="button" onClick={() => applyInlineFormat("bold")}>B</button>
        <button type="button" onClick={() => applyInlineFormat("italic")}>I</button>
        <button type="button" onClick={() => applyInlineFormat("underline")}>U</button>
      </div>

      <section className="layout">
        <div className="panel">
          <h2>Collaborative Rich Blocks (CRDT)</h2>
          <div className="blocks-editor">
            {blocks.map((block, index) => {
              const blockKey = idKey(block.id);
              return (
                <div key={blockKey} className="block-row">
                  <select value={block.type} onChange={(e) => applyBlockType(block.id, e.target.value)}>
                    <option value="paragraph">Paragraph</option>
                    <option value="heading1">Heading</option>
                    <option value="bullet">Bullet</option>
                  </select>

                  <input
                    value={block.text}
                    onFocus={(e) => updateSelection(e, block.id)}
                    onSelect={(e) => updateSelection(e, block.id)}
                    onKeyUp={(e) => updateSelection(e, block.id)}
                    onMouseUp={(e) => updateSelection(e, block.id)}
                    onChange={(e) => onBlockTextChanged(block.id, e.target.value)}
                    placeholder="Type text..."
                  />

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
