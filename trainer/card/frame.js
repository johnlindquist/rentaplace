// Widget frame: one set of rules for moving, popping out and closing every sidebar widget
// (Issues, Todos, Memories and anything built with /widget). The same file is copied into each
// mod; test/frame.test.mjs proves the copies match.
// No herdr imports, so Node tests can load it: Herdr's functions are passed in.
//
// The rules
// - Every widget has a title bar: its name, its own controls, then Pop out and Close.
// - Drag the bar onto another widget: the top half lands above it, the bottom half below it.
//   While dragging, the widget itself offers "left side" and "right side". Esc cancels.
//   Keys: Shift+↑ / Shift+↓ reorder inside a column, Shift+← / Shift+→ move to the other side.
// - Moving rewrites the layout tree and hands it to Herdr's own command for personal edits
//   (`layout.set`). Herdr refuses that on its own layouts; the widget then says so in one line.
// - Pop out (Shift+O): the docked block is hidden and the widget opens as a free window that
//   remembers its spot and comes back on the next start. Dock back (Shift+O) reverses it.
// - Close (Shift+W) hides the docked block or closes the window. Reopen with Herdr's
//   `mod.open {name}` (a closed widget is not loaded, so its own commands cannot reach it):
//   it comes back where it was, docked or floating.
// - One engine: only the copy that is on screen works. A docked copy whose block is hidden, or
//   that has a window open, does nothing until it is shown again.
// - What is remembered, in shared state `frame.<mod>`: mode (docked / floating / closed), where
//   it was last (docked or floating), the block, its side and neighbours, the last named error,
//   and the view state (selection, scroll, collapse) handed from one copy to the next.

export const FRAME_VERSION = 1;
export const SHIPPED_LAYOUTS = ["main", "terminals", "win98"];
export const DRAG_KEY = "frame.drag";
export const DRAG_MS = 20_000; // a drag nobody finished is forgotten after this
export const SIDE_PX = 304; // a widget's width when it gets a side of its own
export const WINDOW = { width: 360, height: 560 };

export const FRAME_KEYS = {
  popout: { key: "shift-o", shown: "⇧O", label: "Pop out" },
  dock: { key: "shift-o", shown: "⇧O", label: "Dock back" },
  close: { key: "shift-w", shown: "⇧W", label: "Close" },
  up: { key: "shift-up", shown: "⇧↑", label: "Move up" },
  down: { key: "shift-down", shown: "⇧↓", label: "Move down" },
  left: { key: "shift-left", shown: "⇧←", label: "Move to the left side" },
  right: { key: "shift-right", shown: "⇧→", label: "Move to the right side" },
};
/** Legend entries ([keys, label]) every widget adds to its own. */
export const frameLegend = (floating) => (floating ? [["⇧O", "Dock"], ["⇧W", "Close"]] : [["⇧↑↓←→", "Move"], ["⇧O", "Pop out"], ["⇧W", "Close"]]);

export const ERRORS = {
  "shipped-layout": "This is Herdr's own layout, so widgets can't be rearranged in it. Duplicate it first (command palette: Duplicate layout), then move them.",
  "not-in-layout": "This widget has no docked place in this layout.",
  "no-target": "That widget is not in this layout.",
  "same-place": "It is already there.",
  "nothing-above": "Nothing above it in this column. Drag it onto another widget to stack them.",
  "nothing-below": "Nothing below it in this column. Drag it onto another widget to stack them.",
  "already-there": "It is already on that side.",
  "already-floating": "It is already a window.",
  "already-docked": "It is already docked.",
  "unknown-move": "Move takes up, down, left, right, before:<widget> or after:<widget>.",
};
const fail = (name) => ({ error: { name, message: ERRORS[name] ?? name } });

const clone = (x) => JSON.parse(JSON.stringify(x));
const kids = (n) => (Array.isArray(n?.children) ? n.children : []);

/** The path (child indexes from the root) of the first node `test` accepts, else null. */
export function pathOf(tree, test) {
  /** @type {any} */
  let found = null;
  const walk = (n, path) => {
    if (found || !n || typeof n !== "object") return;
    if (test(n)) {
      found = path;
      return;
    }
    kids(n).forEach((c, i) => walk(c, [...path, i]));
  };
  walk(tree, []);
  return found;
}
export const nodeAt = (tree, path) => path.reduce((n, i) => kids(n)[i], tree);
const isMod = (mod) => (n) => n?.type !== "row" && n?.type !== "column" && n?.type !== "stack" && n?.content?.mod === mod && Boolean(n.id);
/** A widget is named by its mod ("todos") or by its block id. */
const pathOfWidget = (tree, name) => pathOf(tree, isMod(name)) ?? pathOf(tree, (n) => n?.id === name);

/** "left" or "right" of the block that shows the tabs (the work area); null when above/below it or unknown. */
export function sideOf(tree, path) {
  const tab = pathOf(tree, (n) => Boolean(n?.content?.tab));
  if (!tab || !path) return null;
  let n = tree;
  for (let d = 0; d < Math.min(tab.length, path.length); d++) {
    if (tab[d] !== path[d]) return n?.type === "row" ? (path[d] < tab[d] ? "left" : "right") : null;
    n = kids(n)[tab[d]];
  }
  return null;
}

/** Where the widget `mod` is in the layout: its block, side, column neighbours. Null when absent. */
export function place(tree, mod) {
  const path = pathOfWidget(tree, mod);
  if (!path || !path.length) return null;
  const node = nodeAt(tree, path);
  const parent = nodeAt(tree, path.slice(0, -1));
  const index = path[path.length - 1];
  const shown = (n) => n && !n.hidden;
  const sibs = kids(parent);
  const stacked = parent?.type === "column";
  const above = stacked ? [...sibs.slice(0, index)].reverse().find(shown) : null;
  const below = stacked ? sibs.slice(index + 1).find(shown) : null;
  return {
    block: node.id,
    hidden: Boolean(node.hidden),
    side: sideOf(tree, path),
    parent: parent?.id ?? null,
    parentType: parent?.type ?? null,
    index,
    above: above?.id ?? null,
    below: below?.id ?? null,
  };
}

// Takes the node at `path` out. A column or row left empty goes too (never the root).
function detach(tree, path) {
  const parent = nodeAt(tree, path.slice(0, -1));
  const [node] = parent.children.splice(path[path.length - 1], 1);
  let p = path.slice(0, -1);
  while (p.length && !kids(nodeAt(tree, p)).length) {
    nodeAt(tree, p.slice(0, -1)).children.splice(p[p.length - 1], 1);
    p = p.slice(0, -1);
  }
  return node;
}
// A block's size means height in a column and width in a row: convert when it changes parent.
const forColumn = (n) => ({ ...n, size: typeof n.size?.weight === "number" ? n.size : { weight: 1 } });
const forRow = (n, px) => ({ ...n, size: typeof n.size?.px === "number" ? n.size : { px } });

/** The column on `side` a moved widget joins: the shown one with the most flexible blocks. Null: none. */
export function sideColumn(tree, side, exceptId = null) {
  /** @type {any} */
  let best = null;
  const walk = (n, path, hidden) => {
    if (!n || typeof n !== "object") return;
    const off = hidden || Boolean(n.hidden);
    if (n.type === "column" && !off && path.length && sideOf(tree, path) === side) {
      const score = kids(n).filter((c) => c?.content?.mod && c.id !== exceptId && !c.hidden && typeof c.size?.px !== "number").length;
      if (score > 0 && (!best || score > best.score)) best = { path, score };
    }
    kids(n).forEach((c, i) => walk(c, [...path, i], off));
  };
  walk(tree, [], false);
  return best ? best.path : null;
}

/**
 * The layout tree with widget `mod` moved. `where` is one of
 *   { before: widget } | { after: widget }   next to another widget (stacks them when it stands alone)
 *   { dir: "up" | "down" }                    past its neighbour in the same column
 *   { side: "left" | "right" }                into that side's column (or a new place at that edge)
 * Returns { tree } (a new tree; the input is untouched) or { error: { name, message } }.
 */
export function moveBlock(tree, mod, where) {
  const from = pathOfWidget(tree, mod);
  if (!from || !from.length) return fail("not-in-layout");
  const next = clone(tree);
  const me = nodeAt(next, from);

  if (where?.dir === "up" || where?.dir === "down") {
    const p = place(next, me.id);
    const other = where.dir === "up" ? p?.above : p?.below;
    if (!other) return fail(where.dir === "up" ? "nothing-above" : "nothing-below");
    return moveBlock(tree, me.id, where.dir === "up" ? { before: other } : { after: other });
  }

  if (where?.before || where?.after) {
    const name = where.before ?? where.after;
    const targetPath = pathOfWidget(next, name);
    if (!targetPath || !targetPath.length) return fail("no-target");
    const targetId = nodeAt(next, targetPath).id;
    if (targetId === me.id) return fail("same-place");
    const moved = detach(next, from);
    const tp = pathOf(next, (n) => n?.id === targetId);
    const parent = nodeAt(next, tp.slice(0, -1));
    const at = tp[tp.length - 1];
    if (parent.type === "column") {
      parent.children.splice(where.before ? at : at + 1, 0, forColumn(moved));
    } else {
      // The target stands alone (in a row or a stack): a new column takes its place and holds both.
      const target = parent.children[at];
      /** @type {any} */
      const column = { id: `stack-${target.id}`, type: "column", size: target.size, children: [] };
      if (target.min != null) column.min = target.min;
      if (target.max != null) column.max = target.max;
      const t = { ...target, size: { weight: 1 } };
      delete t.max;
      column.children = where.before ? [forColumn(moved), t] : [t, forColumn(moved)];
      if (!column.size) delete column.size;
      parent.children[at] = column;
    }
    if (JSON.stringify(next) === JSON.stringify(tree)) return fail("same-place");
    return { tree: next };
  }

  if (where?.side === "left" || where?.side === "right") {
    if (sideOf(next, from) === where.side) return fail("already-there");
    const px = typeof me.size?.px === "number" && nodeAt(next, from.slice(0, -1)).type !== "column" ? me.size.px : SIDE_PX;
    const moved = detach(next, from);
    const col = sideColumn(next, where.side, moved.id);
    if (col) nodeAt(next, col).children.push(forColumn(moved));
    else {
      // No column there yet: the widget gets that edge of the row the work area is in.
      const tab = pathOf(next, (n) => Boolean(n?.content?.tab));
      let row = next;
      if (tab) for (let d = tab.length - 1; d >= 0; d--) if (nodeAt(next, tab.slice(0, d)).type === "row") row = nodeAt(next, tab.slice(0, d));
      if (row.type !== "row") return fail("not-in-layout");
      const m = forRow({ ...moved, size: moved.size?.px ? moved.size : undefined }, px);
      if (where.side === "left") row.children.unshift(m);
      else row.children.push(m);
    }
    return { tree: next };
  }
  return fail("unknown-move");
}

/** The tree's structure only (which node holds which, in what order): what a move changes. */
export const outline = (n) => `${n?.id ?? "?"}${kids(n).length ? `[${kids(n).map(outline).join(",")}]` : ""}`;

/** "up" | "down" | "left" | "right" | "before:<w>" | "after:<w>"  ->  the `where` of moveBlock, else null. */
export function parseMove(text) {
  const s = String(text ?? "").trim();
  if (s === "up" || s === "down") return { dir: s };
  if (s === "left" || s === "right") return { side: s };
  const m = /^(before|after)[:=\s-](.+)$/.exec(s);
  return m ? { [m[1]]: m[2].trim() } : null;
}

/** Where a pointer released at `y` inside a widget `height` tall lands: above or below it. */
export const dropHalf = (y, height) => (height > 0 && y >= height / 2 ? "after" : "before");

/** A drag that is still going on (set by the dragged widget's title bar), else null. */
export function liveDrag(value, now = Date.now()) {
  return value && typeof value === "object" && typeof value.mod === "string" && now - (value.at ?? 0) < DRAG_MS ? value : null;
}

/** docked / floating / closed, from the layout and whether the widget's window is open. */
export function modeOf(tree, mod, windowOpen) {
  if (windowOpen) return "floating";
  const p = place(tree, mod);
  return p && !p.hidden ? "docked" : "closed";
}

/** The record published as shared `frame.<mod>`: what an agent reads, and what the next copy restores. */
export function record(prev, tree, mod, windowId, extra = {}) {
  const p = place(tree, mod);
  const mode = modeOf(tree, mod, Boolean(windowId));
  return {
    mode,
    last: mode === "closed" ? (prev?.last ?? "docked") : mode,
    window: windowId ?? null,
    block: p?.block ?? null,
    side: p?.side ?? null,
    parent: p?.parent ?? null,
    index: p?.index ?? null,
    above: p?.above ?? null,
    below: p?.below ?? null,
    error: prev?.error ?? null,
    view: prev?.view ?? null,
    ...extra,
  };
}

/** Is Herdr going to refuse `layout.set` here? Its own layouts are not clones and keep their names. */
export const isShipped = (tree, name) => !tree?.cloned_from && SHIPPED_LAYOUTS.includes(String(name));

/**
 * The frame of one copy of a widget. `h` holds Herdr's functions:
 * { layout, run, shared, setShared, openOverlay, closeOverlay, props }.
 * `settings.start` ("docked" | "floating") is where a widget seen for the first time appears.
 */
export function createFrame({ mod, h, size = WINDOW, start = "docked" }) {
  const KEY = `frame.${mod}`;
  const mine = () => h.props?.() ?? {};
  const overlay = () => mine().overlay ?? null;
  const read = () => /** @type {any} */ (h.shared(KEY)) ?? null;
  const write = (extra = {}) => {
    const prev = read();
    const windowId = overlay() ?? (extra.window === null ? null : prev?.window ?? null);
    const next = record(prev, h.layout(), mod, windowId, extra);
    if (JSON.stringify(next) !== JSON.stringify(prev)) h.setShared(KEY, next);
    return next;
  };
  const say = (name) => (write({ error: { name, message: ERRORS[name] ?? name, at: Date.now() } }), { error: { name, message: ERRORS[name] ?? name } });
  const ok = (extra = {}) => ({ ok: true, state: write({ error: null, ...extra }) });
  /** @type {any} */
  const frame = {
    mod,
    /** This copy is the free window (opened by Pop out or by Herdr's mod.open). */
    get floating() {
      return Boolean(overlay());
    },
    state: () => read() ?? record(null, h.layout(), mod, overlay()),
    /** Should this copy work (poll, call models)? Only the one on screen does. */
    active() {
      if (frame.floating) return !frame.leaving;
      const s = read();
      if (s?.window) return false;
      const p = place(h.layout(), mod);
      return Boolean(p && !p.hidden);
    },
    /** The last named error, for one plain line in the widget. */
    problem() {
      const e = read()?.error;
      return e && Date.now() - (e.at ?? 0) < 60_000 ? e.message : null;
    },
    /**
     * Call once from init. In the window: says so in shared state, or, when the widget was last
     * docked and Herdr's mod.open reopened it, docks it again and closes this window (returns
     * false: this copy is leaving). Returns the view state the previous copy handed over.
     */
    start() {
      const prev = read();
      if (frame.floating) {
        const p = place(h.layout(), mod);
        const asked = mine().frame === "window"; // opened by Pop out, not by mod.open
        if (!asked && p && (!p.hidden || (prev ? prev.last === "docked" : start !== "floating"))) {
          frame.leaving = true;
          if (p.hidden) h.run("layout.show", { id: p.block });
          h.closeOverlay(overlay());
          h.setShared(KEY, { ...record(prev, h.layout(), mod, null), mode: "docked", last: "docked", window: null, error: null });
          return null;
        }
        if (p && !p.hidden) h.run("layout.hide", { id: p.block });
        write({ error: null });
      } else if (!prev && start === "floating") {
        frame.popout();
      } else write();
      return prev?.view ?? null;
    },
    /** Call from the view's close(): the window is gone. */
    closed() {
      if (frame.floating && !frame.leaving) h.setShared(KEY, { ...(read() ?? {}), window: null, mode: "closed", last: "floating" });
    },
    popout(view = null) {
      if (frame.floating) return say("already-floating");
      const p = place(h.layout(), mod);
      if (p && !p.hidden) h.run("layout.hide", { id: p.block });
      const id = h.openOverlay({ mod, kind: "window", key: mod, keep: true, width: size.width, height: size.height, props: { frame: "window" } });
      h.setShared(KEY, { ...record(read(), h.layout(), mod, id), mode: "floating", last: "floating", window: id, error: null, view });
      return { ok: true };
    },
    dock(view = null) {
      if (!frame.floating) return say("already-docked");
      const p = place(h.layout(), mod);
      if (!p) return say("not-in-layout");
      frame.leaving = true;
      h.run("layout.show", { id: p.block });
      h.setShared(KEY, { ...record(read(), h.layout(), mod, null), mode: "docked", last: "docked", window: null, error: null, view });
      h.closeOverlay(overlay());
      return { ok: true };
    },
    close(view = null) {
      if (frame.floating) {
        frame.leaving = true;
        h.setShared(KEY, { ...record(read(), h.layout(), mod, null), mode: "closed", last: "floating", window: null, error: null, view });
        h.closeOverlay(overlay());
        return { ok: true };
      }
      const p = place(h.layout(), mod);
      if (!p) return say("not-in-layout");
      h.setShared(KEY, { ...record(read(), h.layout(), mod, null), mode: "closed", last: "docked", window: null, error: null, view });
      h.run("layout.hide", { id: p.block });
      return { ok: true };
    },
    /** Reaches a copy only while one is loaded (then it is already open): shows the docked block. */
    open() {
      const p = place(h.layout(), mod);
      if (!frame.floating && p?.hidden && !read()?.window) h.run("layout.show", { id: p.block });
      return ok();
    },
    /** `where`: the text form ("up", "before:memories") or moveBlock's object. `who`: another widget (a drop). */
    move(where, who = mod) {
      const w = typeof where === "string" ? parseMove(where) : where;
      if (!w) return say("unknown-move");
      const tree = h.layout();
      if (isShipped(tree, h.shared("layout"))) return say("shipped-layout");
      const r = moveBlock(tree, who, w);
      if (r.error) return say(r.error.name);
      frame.sent = { want: outline(r.tree), at: Date.now() };
      h.run("layout.set", { layout: r.tree });
      return ok();
    },
    /** Call on a timer: a move Herdr did not apply (its own layout) becomes the named error. */
    check() {
      const s = frame.sent;
      if (!s || Date.now() - s.at < 400) return;
      frame.sent = null;
      if (outline(h.layout()) !== s.want) say("shipped-layout");
      else write();
    },
    /** Keys and commands share one path. `view`: the state to hand to the next copy. True when handled. */
    command(k, view = null) {
      if (k === FRAME_KEYS.popout.key || k === "popout" || k === "dock") return (k === "dock" || (frame.floating && k !== "popout") ? frame.dock(view) : frame.popout(view), true);
      if (k === FRAME_KEYS.close.key || k === "close") return (frame.close(view), true);
      if (k === "open") return (frame.open(), true);
      const arrow = /^shift-(up|down|left|right)$/.exec(k);
      const named = /^move[-:. ](.+)$/.exec(k);
      if (arrow || named) {
        if (frame.floating) return true; // a window is moved by dragging it
        return (frame.move(arrow ? arrow[1] : named?.[1]), true);
      }
      return false;
    },
    // ----- the drag: the dragged widget announces it; the widget under the pointer lands it -----
    dragStart() {
      if (!frame.floating) h.setShared(DRAG_KEY, { mod, at: Date.now() });
    },
    dragCancel() {
      if (liveDrag(h.shared(DRAG_KEY))) h.setShared(DRAG_KEY, null);
    },
    /** null, "mine" (this widget is being dragged) or the dragged widget's mod name. */
    dragging() {
      const d = liveDrag(h.shared(DRAG_KEY));
      return !d || frame.floating ? null : d.mod === mod ? "mine" : d.mod;
    },
    /** The dragged widget was released over this one: `half` is "before" (top) or "after" (bottom). */
    dropHere(half) {
      const d = liveDrag(h.shared(DRAG_KEY));
      h.setShared(DRAG_KEY, null);
      return d && d.mod !== mod ? frame.move({ [half]: mod }, d.mod) : null;
    },
    /** This widget was released over its own "left side" / "right side" strip. */
    dropSide(side) {
      h.setShared(DRAG_KEY, null);
      return frame.move({ side });
    },
  };
  return frame;
}

/**
 * The title-bar buttons (pop out or dock back, close), the drop targets and the one-line notes,
 * built from the widget's own element functions `ui` = { div, h_flex, v_flex }.
 */
export function frameParts(ui, t, frame, tip, view = () => null) {
  const { div, h_flex, v_flex } = ui;
  const floating = frame.floating;
  const button = (id, glyph, label, key, act) =>
    div()
      .id(`${frame.mod}-frame-${id}`)
      .flex_none()
      .w(20)
      .h(20)
      .rounded(5)
      .flex()
      .items_center()
      .justify_center()
      .text_size(13)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip(label, key))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        act();
        cx.notify();
      })
      .child(glyph);
  const buttons = [
    floating ? button("dock", "↙", FRAME_KEYS.dock.label, FRAME_KEYS.dock.shown, () => frame.dock(view())) : button("popout", "↗", FRAME_KEYS.popout.label, FRAME_KEYS.popout.shown, () => frame.popout(view())),
    button("close", "×", FRAME_KEYS.close.label, FRAME_KEYS.close.shown, () => frame.close(view())),
  ];
  const who = frame.dragging();
  const zone = (id, label, act) =>
    div()
      .id(`${frame.mod}-drop-${id}`)
      .flex_1()
      .flex()
      .items_center()
      .justify_center()
      .m(4)
      .rounded(8)
      .border(2)
      .border_color(t.accent)
      .bg(t.background)
      .opacity(0.92)
      .text_size(12)
      .text_color(t.foreground)
      .hover((s) => s.bg(t.selected ?? t.hover))
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        act();
        cx.notify();
      })
      .on_click((_e, cx) => {
        cx.stop_propagation();
        act();
        cx.notify();
      })
      .child(label);
  // Over another widget: its two halves. Over the dragged widget itself: the two sides.
  const drop = !who
    ? null
    : who === "mine"
      ? v_flex()
          .absolute()
          .top(36)
          .left(0)
          .right(0)
          .h(96)
          .child(div().px(12).py(4).text_size(11).text_color(t.muted).child("Drop on another widget: above or below it · Esc cancels"))
          .child(h_flex().flex_1().child(zone("left", "← Left side", () => frame.dropSide("left"))).child(zone("right", "Right side →", () => frame.dropSide("right"))))
      : v_flex()
          .absolute()
          .top(0)
          .left(0)
          .right(0)
          .bottom(0)
          .child(zone("before", `↑ ${who} above`, () => frame.dropHere("before")))
          .child(zone("after", `↓ ${who} below`, () => frame.dropHere("after")));
  const problem = frame.problem();
  const note = problem ? div().id(`${frame.mod}-frame-note`).flex_none().px(14).py(5).text_size(11).text_color(t.blocked).child(problem) : null;
  return { buttons, drop, note, legend: frameLegend(floating) };
}
