const ROOT_ID = Object.freeze({ lamport: 0, site: "root" });

function idKey(id) {
  return `${id.lamport}:${id.site}`;
}

function compareId(a, b) {
  if (a.lamport !== b.lamport) {
    return a.lamport - b.lamport;
  }
  if (a.site < b.site) return -1;
  if (a.site > b.site) return 1;
  return 0;
}

function cloneId(id) {
  return { lamport: id.lamport, site: id.site };
}

export class RgaDocument {
  constructor() {
    this.nodes = new Map();
    this.children = new Map();
    this.seenOps = new Set();
    this.pendingInserts = new Map();
    this.pendingDeletes = new Map();
    this.pendingFormats = new Map();

    this.nodes.set(idKey(ROOT_ID), {
      id: ROOT_ID,
      after: null,
      value: "",
      deleted: true,
      attrs: { bold: false, italic: false, underline: false },
      attrClocks: {}
    });
    this.children.set(idKey(ROOT_ID), []);
  }

  _ensureChildren(parentId) {
    const key = idKey(parentId);
    if (!this.children.has(key)) {
      this.children.set(key, []);
    }
    return this.children.get(key);
  }

  _sortSiblings(parentId) {
    const siblings = this._ensureChildren(parentId);
    siblings.sort(compareId);
  }

  _queue(map, key, op) {
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(op);
  }

  _drainDependentOpsForNode(nodeId) {
    const targetKey = idKey(nodeId);

    const deferredDeletes = this.pendingDeletes.get(targetKey) || [];
    if (deferredDeletes.length > 0) {
      this.pendingDeletes.delete(targetKey);
      deferredDeletes.sort((a, b) => compareId(a.opId, b.opId));
      for (const op of deferredDeletes) {
        this._applyDelete(op);
      }
    }

    const deferredFormats = this.pendingFormats.get(targetKey) || [];
    if (deferredFormats.length > 0) {
      this.pendingFormats.delete(targetKey);
      deferredFormats.sort((a, b) => compareId(a.opId, b.opId));
      for (const op of deferredFormats) {
        this._applyFormat(op);
      }
    }
  }

  _drainDependentInserts(parentId) {
    const parentKey = idKey(parentId);
    const waiting = this.pendingInserts.get(parentKey) || [];
    if (waiting.length === 0) {
      return;
    }
    this.pendingInserts.delete(parentKey);
    waiting.sort((a, b) => compareId(a.opId, b.opId));
    for (const op of waiting) {
      this._applyInsert(op);
    }
  }

  _applyInsert(op) {
    const opKey = idKey(op.opId);
    if (this.nodes.has(opKey)) {
      return false;
    }

    const afterKey = idKey(op.after);
    if (!this.nodes.has(afterKey)) {
      this._queue(this.pendingInserts, afterKey, op);
      return false;
    }

    const attrs = {
      bold: !!op.attrs?.bold,
      italic: !!op.attrs?.italic,
      underline: !!op.attrs?.underline
    };

    this.nodes.set(opKey, {
      id: cloneId(op.opId),
      after: cloneId(op.after),
      value: op.value,
      deleted: false,
      attrs,
      attrClocks: {}
    });

    const siblings = this._ensureChildren(op.after);
    siblings.push(cloneId(op.opId));
    this._sortSiblings(op.after);

    this._drainDependentOpsForNode(op.opId);
    this._drainDependentInserts(op.opId);

    return true;
  }

  _applyDelete(op) {
    const targetKey = idKey(op.target);
    const node = this.nodes.get(targetKey);
    if (!node) {
      this._queue(this.pendingDeletes, targetKey, op);
      return false;
    }
    node.deleted = true;
    return true;
  }

  _applyFormat(op) {
    const targetKey = idKey(op.target);
    const node = this.nodes.get(targetKey);
    if (!node) {
      this._queue(this.pendingFormats, targetKey, op);
      return false;
    }

    for (const [attr, value] of Object.entries(op.attrs || {})) {
      const previousClock = node.attrClocks[attr];
      if (!previousClock || compareId(op.opId, previousClock) >= 0) {
        node.attrs[attr] = !!value;
        node.attrClocks[attr] = cloneId(op.opId);
      }
    }
    return true;
  }

  applyOperation(op) {
    const key = idKey(op.opId);
    if (this.seenOps.has(key)) {
      return false;
    }
    this.seenOps.add(key);

    if (op.type === "insert") {
      return this._applyInsert(op);
    }
    if (op.type === "delete") {
      return this._applyDelete(op);
    }
    if (op.type === "format") {
      return this._applyFormat(op);
    }

    return false;
  }

  _walkFrom(parentId, out) {
    const siblings = this.children.get(idKey(parentId)) || [];
    for (const childId of siblings) {
      const child = this.nodes.get(idKey(childId));
      if (!child) continue;
      out.push(child);
      this._walkFrom(child.id, out);
    }
  }

  linearizedNodes() {
    const out = [];
    this._walkFrom(ROOT_ID, out);
    return out;
  }

  visibleNodes() {
    return this.linearizedNodes().filter((n) => !n.deleted);
  }

  getText() {
    return this.visibleNodes().map((n) => n.value).join("");
  }

  getVisibleNodeAt(index) {
    const nodes = this.visibleNodes();
    return nodes[index] || null;
  }

  getVisibleIdAt(index) {
    const node = this.getVisibleNodeAt(index);
    return node ? cloneId(node.id) : null;
  }

  getTailId() {
    const nodes = this.visibleNodes();
    if (nodes.length === 0) {
      return cloneId(ROOT_ID);
    }
    return cloneId(nodes[nodes.length - 1].id);
  }

  makeInsertOp(index, value, site, lamport, attrs = {}) {
    const safeIndex = Math.max(0, Math.min(index, this.visibleNodes().length));
    const after = safeIndex === 0 ? cloneId(ROOT_ID) : this.getVisibleIdAt(safeIndex - 1);

    return {
      type: "insert",
      opId: { lamport, site },
      after: after || this.getTailId(),
      value,
      attrs: {
        bold: !!attrs.bold,
        italic: !!attrs.italic,
        underline: !!attrs.underline
      }
    };
  }

  makeDeleteOp(index, site, lamport) {
    const target = this.getVisibleIdAt(index);
    if (!target) {
      return null;
    }
    return {
      type: "delete",
      opId: { lamport, site },
      target
    };
  }

  makeFormatOp(index, attrs, site, lamport) {
    const target = this.getVisibleIdAt(index);
    if (!target) {
      return null;
    }
    return {
      type: "format",
      opId: { lamport, site },
      target,
      attrs
    };
  }

  getRichSegments() {
    const segments = [];
    let current = null;

    for (const node of this.visibleNodes()) {
      const marks = {
        bold: !!node.attrs.bold,
        italic: !!node.attrs.italic,
        underline: !!node.attrs.underline
      };
      const key = `${marks.bold}-${marks.italic}-${marks.underline}`;
      if (!current || current.key !== key) {
        current = { key, text: node.value, marks };
        segments.push(current);
      } else {
        current.text += node.value;
      }
    }

    return segments;
  }
}

export function createSiteId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `site-${rand}`;
}

export function computeSingleSpanDiff(prev, next) {
  if (prev === next) {
    return null;
  }

  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) {
    start += 1;
  }

  let prevEnd = prev.length - 1;
  let nextEnd = next.length - 1;
  while (prevEnd >= start && nextEnd >= start && prev[prevEnd] === next[nextEnd]) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  const removed = prev.slice(start, prevEnd + 1);
  const inserted = next.slice(start, nextEnd + 1);

  return {
    start,
    removed,
    inserted
  };
}

export function maxLamportFromOp(op) {
  let value = op.opId?.lamport || 0;
  if (op.after?.lamport) value = Math.max(value, op.after.lamport);
  if (op.target?.lamport) value = Math.max(value, op.target.lamport);
  return value;
}
