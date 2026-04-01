const INLINE_ATTRS = ["bold", "italic", "underline"];
const BLOCK_TYPES = new Set(["paragraph", "heading1", "bullet"]);

export const BLOCK_ROOT_ID = Object.freeze({ lamport: 0, site: "block-root" });
export const GENESIS_BLOCK_ID = Object.freeze({ lamport: 0, site: "block-genesis" });
export const INLINE_ROOT_ID = Object.freeze({ lamport: 0, site: "char-root" });

export function idKey(id) {
  return `${id.lamport}:${id.site}`;
}

export function compareId(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.site < b.site) return -1;
  if (a.site > b.site) return 1;
  return 0;
}

function cloneId(id) {
  return { lamport: id.lamport, site: id.site };
}

function idsEqual(a, b) {
  return a.lamport === b.lamport && a.site === b.site;
}

function normalizeBlockType(type) {
  return BLOCK_TYPES.has(type) ? type : "paragraph";
}

function normalizeAttrs(attrs = {}) {
  return {
    bold: !!attrs.bold,
    italic: !!attrs.italic,
    underline: !!attrs.underline
  };
}

function cloneClock(clock) {
  if (!clock) return null;
  return { lamport: clock.lamport, site: clock.site };
}

class InlineCrdt {
  constructor() {
    this.nodes = new Map();
    this.children = new Map();
    this.pendingInserts = new Map();
    this.pendingDeletes = new Map();
    this.pendingFormats = new Map();

    this.nodes.set(idKey(INLINE_ROOT_ID), {
      id: INLINE_ROOT_ID,
      after: null,
      value: "",
      deleted: true,
      attrs: normalizeAttrs(),
      attrClocks: {}
    });
    this.children.set(idKey(INLINE_ROOT_ID), []);
  }

  _ensureChildren(parentId) {
    const key = idKey(parentId);
    if (!this.children.has(key)) this.children.set(key, []);
    return this.children.get(key);
  }

  _sortChildren(parentId) {
    this._ensureChildren(parentId).sort(compareId);
  }

  _queue(map, key, op) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(op);
  }

  _drainForNode(nodeId) {
    const key = idKey(nodeId);

    const delayedDeletes = this.pendingDeletes.get(key) || [];
    if (delayedDeletes.length > 0) {
      this.pendingDeletes.delete(key);
      delayedDeletes.sort((a, b) => compareId(a.opId, b.opId));
      for (const op of delayedDeletes) this.applyDelete(op);
    }

    const delayedFormats = this.pendingFormats.get(key) || [];
    if (delayedFormats.length > 0) {
      this.pendingFormats.delete(key);
      delayedFormats.sort((a, b) => compareId(a.opId, b.opId));
      for (const op of delayedFormats) this.applyFormat(op);
    }

    const delayedInserts = this.pendingInserts.get(key) || [];
    if (delayedInserts.length > 0) {
      this.pendingInserts.delete(key);
      delayedInserts.sort((a, b) => compareId(a.opId, b.opId));
      for (const op of delayedInserts) this.applyInsert(op);
    }
  }

  applyInsert(op) {
    const nodeKey = idKey(op.opId);
    if (this.nodes.has(nodeKey)) return false;

    const afterKey = idKey(op.after);
    if (!this.nodes.has(afterKey)) {
      this._queue(this.pendingInserts, afterKey, op);
      return false;
    }

    const value = typeof op.value === "string" && op.value.length > 0 ? op.value[0] : " ";
    this.nodes.set(nodeKey, {
      id: cloneId(op.opId),
      after: cloneId(op.after),
      value,
      deleted: false,
      attrs: normalizeAttrs(op.attrs),
      attrClocks: {}
    });

    this._ensureChildren(op.after).push(cloneId(op.opId));
    this._sortChildren(op.after);
    this._drainForNode(op.opId);
    return true;
  }

  applyDelete(op) {
    const node = this.nodes.get(idKey(op.target));
    if (!node) {
      this._queue(this.pendingDeletes, idKey(op.target), op);
      return false;
    }
    node.deleted = true;
    return true;
  }

  applyFormat(op) {
    const node = this.nodes.get(idKey(op.target));
    if (!node) {
      this._queue(this.pendingFormats, idKey(op.target), op);
      return false;
    }

    for (const [attr, value] of Object.entries(op.attrs || {})) {
      if (!INLINE_ATTRS.includes(attr)) continue;
      const prev = node.attrClocks[attr];
      if (!prev || compareId(op.opId, prev) >= 0) {
        node.attrs[attr] = !!value;
        node.attrClocks[attr] = cloneId(op.opId);
      }
    }
    return true;
  }

  _walk(parentId, out) {
    const children = this.children.get(idKey(parentId)) || [];
    for (const childId of children) {
      const child = this.nodes.get(idKey(childId));
      if (!child) continue;
      out.push(child);
      this._walk(child.id, out);
    }
  }

  linearized() {
    const out = [];
    this._walk(INLINE_ROOT_ID, out);
    return out;
  }

  visible() {
    return this.linearized().filter((n) => !n.deleted);
  }

  getText() {
    return this.visible().map((n) => n.value).join("");
  }

  getVisibleIdAt(index) {
    const node = this.visible()[index];
    return node ? cloneId(node.id) : null;
  }

  makeInsertOp(index, value, blockId, site, lamport, attrs) {
    const visible = this.visible();
    const safeIndex = Math.max(0, Math.min(index, visible.length));
    const after = safeIndex === 0 ? cloneId(INLINE_ROOT_ID) : cloneId(visible[safeIndex - 1].id);
    return {
      type: "text_insert",
      opId: { lamport, site },
      block: cloneId(blockId),
      after,
      value,
      attrs: normalizeAttrs(attrs)
    };
  }

  makeDeleteOp(index, blockId, site, lamport) {
    const target = this.getVisibleIdAt(index);
    if (!target) return null;
    return {
      type: "text_delete",
      opId: { lamport, site },
      block: cloneId(blockId),
      target
    };
  }

  makeFormatOp(index, attrs, blockId, site, lamport) {
    const target = this.getVisibleIdAt(index);
    if (!target) return null;
    return {
      type: "text_format",
      opId: { lamport, site },
      block: cloneId(blockId),
      target,
      attrs
    };
  }

  getSegments() {
    const segments = [];
    let current = null;

    for (const node of this.visible()) {
      const marks = normalizeAttrs(node.attrs);
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

  canonical() {
    const nodes = [...this.nodes.values()]
      .filter((node) => !idsEqual(node.id, INLINE_ROOT_ID))
      .map((node) => ({
        id: cloneId(node.id),
        after: cloneId(node.after),
        value: node.value,
        deleted: !!node.deleted,
        attrs: normalizeAttrs(node.attrs),
        attrClocks: Object.fromEntries(
          Object.entries(node.attrClocks || {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, clock]) => [name, cloneClock(clock)])
        )
      }))
      .sort((a, b) => compareId(a.id, b.id));

    return {
      text: this.getText(),
      segments: this.getSegments(),
      nodes,
      pending: {
        inserts: [...this.pendingInserts.values()].reduce((acc, xs) => acc + xs.length, 0),
        deletes: [...this.pendingDeletes.values()].reduce((acc, xs) => acc + xs.length, 0),
        formats: [...this.pendingFormats.values()].reduce((acc, xs) => acc + xs.length, 0)
      }
    };
  }
}

export class RichTextDocument {
  constructor() {
    this.blocks = new Map();
    this.blockChildren = new Map();
    this.textByBlock = new Map();
    this.seenOps = new Set();

    this.pendingBlockInserts = new Map();
    this.pendingBlockDeletes = new Map();
    this.pendingBlockFormats = new Map();
    this.pendingTextOpsByBlock = new Map();

    this.blocks.set(idKey(BLOCK_ROOT_ID), {
      id: BLOCK_ROOT_ID,
      after: null,
      type: "root",
      deleted: true,
      typeClock: null
    });
    this.blockChildren.set(idKey(BLOCK_ROOT_ID), []);

    this.blocks.set(idKey(GENESIS_BLOCK_ID), {
      id: GENESIS_BLOCK_ID,
      after: BLOCK_ROOT_ID,
      type: "paragraph",
      deleted: false,
      typeClock: null
    });
    this._ensureBlockChildren(BLOCK_ROOT_ID).push(cloneId(GENESIS_BLOCK_ID));
    this._sortBlockChildren(BLOCK_ROOT_ID);
    this.blockChildren.set(idKey(GENESIS_BLOCK_ID), []);
    this.textByBlock.set(idKey(GENESIS_BLOCK_ID), new InlineCrdt());
  }

  _ensureBlockChildren(parentId) {
    const key = idKey(parentId);
    if (!this.blockChildren.has(key)) this.blockChildren.set(key, []);
    return this.blockChildren.get(key);
  }

  _sortBlockChildren(parentId) {
    this._ensureBlockChildren(parentId).sort(compareId);
  }

  _queue(map, key, op) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(op);
  }

  _drainForBlock(blockId) {
    const key = idKey(blockId);

    const delayedDeletes = this.pendingBlockDeletes.get(key) || [];
    if (delayedDeletes.length > 0) {
      this.pendingBlockDeletes.delete(key);
      delayedDeletes.sort((a, b) => compareId(a.opId, b.opId));
      for (const op of delayedDeletes) this._applyBlockDelete(op);
    }

    const delayedFormats = this.pendingBlockFormats.get(key) || [];
    if (delayedFormats.length > 0) {
      this.pendingBlockFormats.delete(key);
      delayedFormats.sort((a, b) => compareId(a.opId, b.opId));
      for (const op of delayedFormats) this._applyBlockFormat(op);
    }

    const delayedText = this.pendingTextOpsByBlock.get(key) || [];
    if (delayedText.length > 0) {
      this.pendingTextOpsByBlock.delete(key);
      delayedText.sort((a, b) => compareId(a.opId, b.opId));
      for (const op of delayedText) this._applyTextOp(op);
    }

    const delayedInserts = this.pendingBlockInserts.get(key) || [];
    if (delayedInserts.length > 0) {
      this.pendingBlockInserts.delete(key);
      delayedInserts.sort((a, b) => compareId(a.opId, b.opId));
      for (const op of delayedInserts) this._applyBlockInsert(op);
    }
  }

  _applyBlockInsert(op) {
    const blockKey = idKey(op.opId);
    if (this.blocks.has(blockKey)) return false;

    const afterKey = idKey(op.after);
    if (!this.blocks.has(afterKey)) {
      this._queue(this.pendingBlockInserts, afterKey, op);
      return false;
    }

    this.blocks.set(blockKey, {
      id: cloneId(op.opId),
      after: cloneId(op.after),
      type: normalizeBlockType(op.blockType),
      deleted: false,
      typeClock: null
    });
    this._ensureBlockChildren(op.after).push(cloneId(op.opId));
    this._sortBlockChildren(op.after);
    this._ensureBlockChildren(op.opId);
    this.textByBlock.set(blockKey, new InlineCrdt());
    this._drainForBlock(op.opId);
    return true;
  }

  _applyBlockDelete(op) {
    const block = this.blocks.get(idKey(op.target));
    if (!block) {
      this._queue(this.pendingBlockDeletes, idKey(op.target), op);
      return false;
    }
    if (idsEqual(block.id, GENESIS_BLOCK_ID)) {
      return false;
    }
    block.deleted = true;
    return true;
  }

  _applyBlockFormat(op) {
    const block = this.blocks.get(idKey(op.target));
    if (!block) {
      this._queue(this.pendingBlockFormats, idKey(op.target), op);
      return false;
    }

    if (!block.typeClock || compareId(op.opId, block.typeClock) >= 0) {
      block.type = normalizeBlockType(op.blockType);
      block.typeClock = cloneId(op.opId);
    }
    return true;
  }

  _applyTextOp(op) {
    const blockKey = idKey(op.block);
    const inline = this.textByBlock.get(blockKey);
    if (!inline) {
      this._queue(this.pendingTextOpsByBlock, blockKey, op);
      return false;
    }

    if (op.type === "text_insert") return inline.applyInsert(op);
    if (op.type === "text_delete") return inline.applyDelete(op);
    if (op.type === "text_format") return inline.applyFormat(op);
    return false;
  }

  applyOperation(op) {
    const opKey = idKey(op.opId);
    if (this.seenOps.has(opKey)) return false;
    this.seenOps.add(opKey);

    if (op.type === "block_insert") return this._applyBlockInsert(op);
    if (op.type === "block_delete") return this._applyBlockDelete(op);
    if (op.type === "block_format") return this._applyBlockFormat(op);
    if (op.type === "text_insert" || op.type === "text_delete" || op.type === "text_format") {
      return this._applyTextOp(op);
    }

    return false;
  }

  _walkBlocks(parentId, out) {
    const children = this.blockChildren.get(idKey(parentId)) || [];
    for (const childId of children) {
      const block = this.blocks.get(idKey(childId));
      if (!block) continue;
      out.push(block);
      this._walkBlocks(block.id, out);
    }
  }

  linearizedBlocks() {
    const out = [];
    this._walkBlocks(BLOCK_ROOT_ID, out);
    return out;
  }

  visibleBlocks() {
    return this.linearizedBlocks().filter((b) => !b.deleted);
  }

  getBlocks() {
    return this.visibleBlocks().map((block) => {
      const inline = this.textByBlock.get(idKey(block.id));
      return {
        id: cloneId(block.id),
        type: block.type,
        text: inline ? inline.getText() : "",
        segments: inline ? inline.getSegments() : []
      };
    });
  }

  getText() {
    return this.getBlocks().map((b) => b.text).join("\n");
  }

  makeInsertBlockAfter(afterBlockId, blockType, site, lamport) {
    const after = afterBlockId ? cloneId(afterBlockId) : cloneId(GENESIS_BLOCK_ID);
    return {
      type: "block_insert",
      opId: { lamport, site },
      after,
      blockType: normalizeBlockType(blockType)
    };
  }

  makeDeleteBlock(blockId, site, lamport) {
    if (!blockId || idsEqual(blockId, GENESIS_BLOCK_ID)) return null;
    return {
      type: "block_delete",
      opId: { lamport, site },
      target: cloneId(blockId)
    };
  }

  makeFormatBlockOp(blockId, blockType, site, lamport) {
    if (!blockId) return null;
    return {
      type: "block_format",
      opId: { lamport, site },
      target: cloneId(blockId),
      blockType: normalizeBlockType(blockType)
    };
  }

  makeInsertTextOp(blockId, index, value, site, lamport, attrs = {}) {
    const inline = this.textByBlock.get(idKey(blockId));
    if (!inline) return null;
    return inline.makeInsertOp(index, value, blockId, site, lamport, attrs);
  }

  makeDeleteTextOp(blockId, index, site, lamport) {
    const inline = this.textByBlock.get(idKey(blockId));
    if (!inline) return null;
    return inline.makeDeleteOp(index, blockId, site, lamport);
  }

  makeFormatTextOp(blockId, index, attrs, site, lamport) {
    const inline = this.textByBlock.get(idKey(blockId));
    if (!inline) return null;
    return inline.makeFormatOp(index, attrs, blockId, site, lamport);
  }
}

export function createSiteId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `site-${rand}`;
}

export function computeSingleSpanDiff(prev, next) {
  if (prev === next) return null;

  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start += 1;

  let prevEnd = prev.length - 1;
  let nextEnd = next.length - 1;
  while (prevEnd >= start && nextEnd >= start && prev[prevEnd] === next[nextEnd]) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    removed: prev.slice(start, prevEnd + 1),
    inserted: next.slice(start, nextEnd + 1)
  };
}

export function maxLamportFromOp(op) {
  let value = op.opId?.lamport || 0;
  if (op.after?.lamport) value = Math.max(value, op.after.lamport);
  if (op.target?.lamport) value = Math.max(value, op.target.lamport);
  if (op.block?.lamport) value = Math.max(value, op.block.lamport);
  return value;
}

export function getCanonicalState(doc) {
  const blocks = doc.linearizedBlocks()
    .filter((b) => !idsEqual(b.id, BLOCK_ROOT_ID))
    .map((b) => {
      const inline = doc.textByBlock.get(idKey(b.id));
      return {
        id: cloneId(b.id),
        after: cloneId(b.after),
        type: b.type,
        deleted: !!b.deleted,
        typeClock: cloneClock(b.typeClock),
        inline: inline ? inline.canonical() : null
      };
    })
    .sort((a, b) => compareId(a.id, b.id));

  return {
    text: doc.getText(),
    blocks: doc.getBlocks(),
    canonicalBlocks: blocks,
    pending: {
      blockInserts: [...doc.pendingBlockInserts.values()].reduce((acc, xs) => acc + xs.length, 0),
      blockDeletes: [...doc.pendingBlockDeletes.values()].reduce((acc, xs) => acc + xs.length, 0),
      blockFormats: [...doc.pendingBlockFormats.values()].reduce((acc, xs) => acc + xs.length, 0),
      textByBlock: [...doc.pendingTextOpsByBlock.values()].reduce((acc, xs) => acc + xs.length, 0)
    }
  };
}
