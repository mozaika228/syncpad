import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  RgaDocument,
  computeSingleSpanDiff,
  createSiteId,
  maxLamportFromOp
} from "../../shared/src/crdt";

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

export default function App() {
  const [status, setStatus] = useState("connecting");
  const [peers, setPeers] = useState(1);
  const [rev, setRev] = useState(0);
  const [marks, setMarks] = useState({ bold: false, italic: false, underline: false });
  const [selection, setSelection] = useState({ start: 0, end: 0 });

  const siteId = useMemo(() => createSiteId(), []);
  const docRef = useRef(new RgaDocument());
  const socketRef = useRef(null);
  const lamportRef = useRef(0);
  const textCacheRef = useRef("");
  const textareaRef = useRef(null);

  const textValue = docRef.current.getText();

  function nextLamport() {
    lamportRef.current += 1;
    return lamportRef.current;
  }

  function absorbLamport(op) {
    lamportRef.current = Math.max(lamportRef.current, maxLamportFromOp(op));
  }

  function emit(op) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ kind: "op", room: ROOM, op }));
  }

  function applyAndRender(op) {
    const changed = docRef.current.applyOperation(op);
    absorbLamport(op);
    if (changed) {
      textCacheRef.current = docRef.current.getText();
      setRev((v) => v + 1);
    }
  }

  function applyLocalInsert(index, char) {
    const op = docRef.current.makeInsertOp(index, char, siteId, nextLamport(), marks);
    applyAndRender(op);
    emit(op);
  }

  function applyLocalDelete(index) {
    const op = docRef.current.makeDeleteOp(index, siteId, nextLamport());
    if (!op) return;
    applyAndRender(op);
    emit(op);
  }

  function applyLocalFormat(start, end, attr) {
    if (start === end) return;

    for (let i = start; i < end; i += 1) {
      const op = docRef.current.makeFormatOp(i, { [attr]: !marks[attr] }, siteId, nextLamport());
      if (!op) continue;
      applyAndRender(op);
      emit(op);
    }
    setMarks((m) => ({ ...m, [attr]: !m[attr] }));
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
        for (const op of payload.ops) {
          applyAndRender(op);
        }
      }

      if (payload.kind === "op" && payload.op) {
        applyAndRender(payload.op);
      }

      if (payload.kind === "presence") {
        setPeers(payload.users || 1);
      }
    });

    return () => {
      socket.close();
    };
  }, []);

  useEffect(() => {
    textCacheRef.current = textValue;
  }, [textValue]);

  function onTextChanged(event) {
    const nextText = event.target.value;
    const prevText = textCacheRef.current;
    const delta = computeSingleSpanDiff(prevText, nextText);

    if (!delta) {
      return;
    }

    if (delta.removed.length > 0) {
      for (let i = 0; i < delta.removed.length; i += 1) {
        applyLocalDelete(delta.start);
      }
    }

    if (delta.inserted.length > 0) {
      for (let i = 0; i < delta.inserted.length; i += 1) {
        applyLocalInsert(delta.start + i, delta.inserted[i]);
      }
    }

    textCacheRef.current = docRef.current.getText();
  }

  function updateSelection() {
    const el = textareaRef.current;
    if (!el) return;
    setSelection({ start: el.selectionStart || 0, end: el.selectionEnd || 0 });
  }

  const richPreview = docRef.current
    .getRichSegments()
    .map((segment) => {
      const escaped = escapeHtml(segment.text)
        .replaceAll("\n", "<br/>")
        .replaceAll(" ", "&nbsp;");

      return {
        html: escaped,
        className: [
          segment.marks.bold ? "seg-bold" : "",
          segment.marks.italic ? "seg-italic" : "",
          segment.marks.underline ? "seg-underline" : ""
        ]
          .filter(Boolean)
          .join(" ")
      };
    })
    .filter((x) => x.html.length > 0);

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
        <button type="button" onClick={() => applyLocalFormat(selection.start, selection.end, "bold")}>B</button>
        <button type="button" onClick={() => applyLocalFormat(selection.start, selection.end, "italic")}>I</button>
        <button type="button" onClick={() => applyLocalFormat(selection.start, selection.end, "underline")}>U</button>
      </div>

      <section className="layout">
        <div className="panel">
          <h2>Collaborative Text</h2>
          <textarea
            ref={textareaRef}
            value={textValue}
            onChange={onTextChanged}
            onSelect={updateSelection}
            onKeyUp={updateSelection}
            onMouseUp={updateSelection}
            placeholder="Type together in real time..."
          />
        </div>

        <div className="panel">
          <h2>Rich Preview (CRDT attributes)</h2>
          <div className="preview">
            {richPreview.length === 0 ? (
              <p className="empty">No content yet.</p>
            ) : (
              richPreview.map((seg, idx) => (
                <span
                  key={`${idx}-${seg.className}`}
                  className={seg.className}
                  dangerouslySetInnerHTML={{ __html: seg.html }}
                />
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
