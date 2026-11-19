import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { moveBlock, place, sideOf, pathOf, sideColumn, parseMove, dropHalf, liveDrag, modeOf, record, isShipped, outline, createFrame, frameLegend, FRAME_KEYS, ERRORS, DRAG_KEY, DRAG_MS } from "../frame.js";

const here = path.dirname(new URL(import.meta.url).pathname);
// A person's own layout: lists on the left, the work area, a right panel with three widgets, Issues in its own column.
const LAYOUT = () => ({ id: "root", type: "row", cloned_from: { name: "main" }, children: [
  { id: "sidebar", type: "column", size: { px: 268 }, children: [
    { id: "brand", type: "block", content: { mod: "workspace-chrome" }, size: { px: 46 } },
    { id: "lists", type: "column", children: [{ id: "spaces", type: "block", content: { mod: "spaces" }, size: { weight: 1 } }, { id: "agents", type: "block", content: { mod: "agents" }, size: { weight: 1 } }] }] },
  { id: "work", type: "column", children: [{ id: "tabs", type: "block", content: { mod: "tabs" }, size: { px: 30 } }, { id: "main", type: "block", content: { tab: "active" } }] },
  { id: "right", type: "column", size: { px: 304 }, children: [
    { id: "t1", type: "block", content: { mod: "todos" }, size: { weight: 3 } },
    { id: "m1", type: "block", content: { mod: "memories" }, size: { weight: 2 } },
    { id: "s1", type: "block", content: { mod: "subs" }, size: { weight: 1 } }] },
  { id: "i1", type: "block", content: { mod: "triage" }, size: { px: 320 } }] });
const ids = (tree, id) => tree.children.find((c) => c.id === id)?.children.map((c) => c.id);

test("where a widget is: block, side, the neighbours above and below", () => {
  const p = place(LAYOUT(), "memories");
  assert.deepEqual([p.block, p.side, p.parent, p.index, p.above, p.below], ["m1", "right", "right", 1, "t1", "s1"]);
  assert.equal(place(LAYOUT(), "triage").above, null, "alone in a row: nothing above");
  assert.equal(sideOf(LAYOUT(), pathOf(LAYOUT(), (n) => n.id === "spaces")), "left");
  assert.equal(place(LAYOUT(), "nope"), null);
  const hidden = LAYOUT();
  hidden.children[2].children[0].hidden = true;
  assert.equal(place(hidden, "memories").above, null, "a hidden widget is not a neighbour");
});

test("reorder inside a column: up, down, before and after; the input tree is untouched", () => {
  const tree = LAYOUT();
  const before = JSON.stringify(tree);
  assert.deepEqual(ids(moveBlock(tree, "memories", { dir: "up" }).tree, "right"), ["m1", "t1", "s1"]);
  assert.deepEqual(ids(moveBlock(tree, "memories", { dir: "down" }).tree, "right"), ["t1", "s1", "m1"]);
  assert.deepEqual(ids(moveBlock(tree, "todos", { after: "subs" }).tree, "right"), ["m1", "s1", "t1"]);
  assert.deepEqual(ids(moveBlock(tree, "subs", { before: "t1" }).tree, "right"), ["s1", "t1", "m1"]);
  assert.equal(JSON.stringify(tree), before);
  assert.equal(moveBlock(tree, "todos", { dir: "up" }).error.name, "nothing-above");
  assert.equal(moveBlock(tree, "subs", { dir: "down" }).error.name, "nothing-below");
  assert.equal(moveBlock(tree, "todos", { before: "memories" }).error.name, "same-place");
  assert.equal(moveBlock(tree, "todos", { before: "todos" }).error.name, "same-place");
  assert.equal(moveBlock(tree, "todos", { after: "zzz" }).error.name, "no-target");
  assert.equal(moveBlock(tree, "zzz", { dir: "up" }).error.name, "not-in-layout");
  assert.equal(moveBlock(tree, "todos", {}).error.name, "unknown-move");
});

test("from one column to another: width becomes a share of the height, and back", () => {
  const r = moveBlock(LAYOUT(), "triage", { after: "todos" }).tree;
  assert.deepEqual(ids(r, "right"), ["t1", "i1", "m1", "s1"]);
  assert.deepEqual(r.children[2].children[1].size, { weight: 1 }, "320px wide becomes one share");
  assert.equal(r.children.length, 3, "its old place in the row is gone");
});

test("dropping on a widget that stands alone stacks the two in a new column", () => {
  const r = moveBlock(LAYOUT(), "memories", { before: "triage" }).tree;
  const col = r.children[3];
  assert.deepEqual([col.id, col.type, col.size], ["stack-i1", "column", { px: 320 }]);
  assert.deepEqual(col.children.map((c) => [c.id, c.size]), [["m1", { weight: 2 }], ["i1", { weight: 1 }]]);
  assert.deepEqual(ids(r, "right"), ["t1", "s1"]);
});

test("to the other side: joins that side's column of lists; an emptied column goes", () => {
  const r = moveBlock(LAYOUT(), "triage", { side: "left" }).tree;
  assert.deepEqual(r.children[0].children[1].children.map((c) => c.id), ["spaces", "agents", "i1"]);
  assert.deepEqual(r.children[0].children[1].children[2].size, { weight: 1 });
  assert.equal(moveBlock(LAYOUT(), "triage", { side: "right" }).error.name, "already-there");
  const back = moveBlock(r, "triage", { side: "right" }).tree;
  assert.deepEqual(ids(back, "right"), ["t1", "m1", "s1", "i1"]);
  // No column on that side: the widget gets the edge of the row, with a width.
  const bare = { id: "root", type: "row", children: [{ id: "main", type: "block", content: { tab: "active" } }, { id: "c", type: "column", size: { px: 300 }, children: [{ id: "t1", type: "block", content: { mod: "todos" }, size: { weight: 1 } }] }] };
  const l = moveBlock(bare, "todos", { side: "left" }).tree;
  assert.deepEqual(l.children.map((c) => [c.id, c.size]), [["t1", { px: 304 }], ["main", undefined]]);
  assert.equal(sideColumn(LAYOUT(), "left").length, 2);
});

test("move words, drop halves and a drag that ends by itself", () => {
  assert.deepEqual([parseMove("up"), parseMove("left"), parseMove("before:memories"), parseMove("after-t1"), parseMove("sideways")], [{ dir: "up" }, { side: "left" }, { before: "memories" }, { after: "t1" }, null]);
  assert.deepEqual([dropHalf(10, 200), dropHalf(150, 200), dropHalf(100, 200)], ["before", "after", "after"]);
  assert.equal(liveDrag({ mod: "todos", at: 1000 }, 1000 + DRAG_MS - 1).mod, "todos");
  assert.equal(liveDrag({ mod: "todos", at: 1000 }, 1000 + DRAG_MS + 1), null);
  assert.equal(liveDrag(null), null);
});

test("docked, floating, closed; what is remembered; Herdr's own layouts", () => {
  const tree = LAYOUT();
  assert.equal(modeOf(tree, "todos", false), "docked");
  assert.equal(modeOf(tree, "todos", true), "floating");
  tree.children[2].children[0].hidden = true;
  assert.equal(modeOf(tree, "todos", false), "closed");
  assert.equal(record({ last: "floating" }, tree, "todos", null).last, "floating", "closed remembers where it was");
  const r = record(null, LAYOUT(), "memories", null);
  assert.deepEqual([r.mode, r.last, r.block, r.side, r.above, r.below, r.window], ["docked", "docked", "m1", "right", "t1", "s1", null]);
  assert.equal(isShipped({ id: "root" }, "main"), true);
  assert.equal(isShipped({ id: "root", cloned_from: { name: "main" } }, "minimal"), false);
  assert.equal(isShipped({ id: "root" }, "my-own"), false);
  assert.equal(outline({ id: "a", children: [{ id: "b" }, { id: "c", children: [{ id: "d" }] }] }), "a[b,c[d]]");
  assert.ok(frameLegend(false).some(([k]) => k === "⇧O") && frameLegend(true).some(([, l]) => l === "Dock"));
  assert.equal(FRAME_KEYS.close.key, "shift-w");
});

// A stand-in for Herdr: a layout, shared state, the commands it was asked to run.
function herdr({ tree = LAYOUT(), name = "minimal", props = {}, refuse = false } = {}) {
  const sharedState = new Map([["layout", name]]);
  const ran = [];
  const h = {
    tree,
    ran,
    sharedState,
    layout: () => h.tree,
    props: () => props,
    shared: (k) => sharedState.get(k) ?? null,
    setShared: (k, v) => sharedState.set(k, v),
    openOverlay: (spec) => (ran.push(["openOverlay", spec]), "ov1"),
    closeOverlay: (id) => ran.push(["closeOverlay", id]),
    run: (cmd, args) => {
      ran.push([cmd, args]);
      const walk = (n) => { if (n.id === args.id) n.hidden = cmd === "layout.hide"; (n.children ?? []).forEach(walk); };
      if (cmd === "layout.hide" || cmd === "layout.show") walk(h.tree);
      if (cmd === "layout.set" && !refuse) h.tree = args.layout;
    },
  };
  return h;
}

test("pop out hides the docked block and opens one kept window; the docked copy stops working", () => {
  const h = herdr();
  const f = createFrame({ mod: "todos", h });
  f.start();
  assert.equal(f.active(), true);
  assert.equal(f.state().mode, "docked");
  f.command("shift-o", { sel: "t7", top: 2, collapsed: false });
  assert.deepEqual(h.ran[0], ["layout.hide", { id: "t1" }]);
  assert.deepEqual(h.ran[1][1], { mod: "todos", kind: "window", key: "todos", keep: true, width: 360, height: 560, props: { frame: "window" } });
  assert.deepEqual([f.state().mode, f.state().window, f.state().view.sel], ["floating", "ov1", "t7"]);
  assert.equal(f.active(), false, "one engine: the hidden docked copy does nothing");
  // The window copy starts from what was handed over, and is the one that works.
  const w = createFrame({ mod: "todos", h: { ...h, props: () => ({ overlay: "ov1", frame: "window" }) } });
  assert.deepEqual(w.start(), { sel: "t7", top: 2, collapsed: false });
  assert.equal(w.active(), true);
  assert.equal(w.popout().error.name, "already-floating");
  // Dock back: the block shows again, the window closes, the docked copy works again.
  w.command("dock", { sel: "t9" });
  assert.deepEqual(h.ran.slice(-2), [["layout.show", { id: "t1" }], ["closeOverlay", "ov1"]]);
  assert.equal(w.active(), false);
  w.closed();
  assert.deepEqual([f.state().mode, f.state().window, f.state().view.sel, f.active()], ["docked", null, "t9", true]);
  assert.equal(f.dock().error.name, "already-docked");
});

test("close hides or closes; Herdr's mod.open brings it back where it was", () => {
  const h = herdr();
  const f = createFrame({ mod: "todos", h });
  f.start();
  f.command("close");
  assert.deepEqual(h.ran.at(-1), ["layout.hide", { id: "t1" }]);
  assert.deepEqual([f.state().mode, f.state().last, f.active()], ["closed", "docked", false]);
  // mod.open opens the mod as a window; it was docked last, so it docks again and that window closes.
  const w = createFrame({ mod: "todos", h: { ...h, props: () => ({ overlay: "ov2" }) } });
  assert.equal(w.start(), null);
  assert.deepEqual(h.ran.slice(-2), [["layout.show", { id: "t1" }], ["closeOverlay", "ov2"]]);
  assert.equal(w.active(), false);
  w.closed();
  assert.deepEqual([f.state().mode, f.active()], ["docked", true]);
  // Floating, closed, reopened: it stays a window.
  f.popout();
  const win = createFrame({ mod: "todos", h: { ...h, props: () => ({ overlay: "ov1", frame: "window" }) } });
  win.start();
  win.command("shift-w");
  assert.deepEqual(h.ran.at(-1), ["closeOverlay", "ov1"]);
  win.closed();
  assert.deepEqual([f.state().mode, f.state().last], ["closed", "floating"]);
  const again = createFrame({ mod: "todos", h: { ...h, props: () => ({ overlay: "ov3" }) } });
  again.start();
  assert.deepEqual([again.active(), again.state().mode, again.state().window], [true, "floating", "ov3"]);
});

test("moves go through layout.set; Herdr's own layout is a named error, not a silent failure", () => {
  const h = herdr();
  const f = createFrame({ mod: "memories", h });
  f.command("shift-up");
  assert.equal(h.ran.at(-1)[0], "layout.set");
  assert.deepEqual(ids(h.tree, "right"), ["m1", "t1", "s1"]);
  assert.deepEqual([f.state().above, f.state().below, f.state().error], [null, "t1", null]);
  f.command("move-after:subs");
  assert.deepEqual(ids(h.tree, "right"), ["t1", "s1", "m1"]);
  f.command("move-left");
  assert.equal(f.state().side, "left");
  assert.equal(f.move("down").error.name, "nothing-below");
  assert.equal(f.state().error.name, "nothing-below");
  assert.equal(f.problem(), ERRORS["nothing-below"]);
  // Herdr's own layout, by name: refused before asking.
  const shipped = LAYOUT();
  delete shipped.cloned_from;
  const s = herdr({ tree: shipped, name: "main" });
  const g = createFrame({ mod: "memories", h: s });
  assert.equal(g.move("up").error.name, "shipped-layout");
  assert.equal(s.ran.length, 0);
  assert.match(g.problem(), /Duplicate/);
  // Any layout where Herdr did not apply the move: found by reading the layout back.
  const r = herdr({ refuse: true });
  const k = createFrame({ mod: "memories", h: r });
  k.move("up");
  k.sent.at -= 1000;
  k.check();
  assert.equal(k.state().error.name, "shipped-layout");
});

test("a drag is announced by one widget and landed by the one under the pointer", () => {
  const h = herdr();
  const todos = createFrame({ mod: "todos", h });
  const subs = createFrame({ mod: "subs", h });
  todos.dragStart();
  assert.equal(h.shared(DRAG_KEY).mod, "todos");
  assert.deepEqual([todos.dragging(), subs.dragging()], ["mine", "todos"]);
  subs.dropHere("after");
  assert.deepEqual(ids(h.tree, "right"), ["m1", "s1", "t1"]);
  assert.equal(subs.dragging(), null);
  todos.dragStart();
  todos.dragCancel();
  assert.equal(todos.dragging(), null, "Esc cancels");
  todos.dragStart();
  todos.dropSide("left");
  assert.equal(todos.state().side, "left");
});

test("every widget carries the same frame rules (copies match)", () => {
  const mine = fs.readFileSync(path.join(here, "..", "frame.js"), "utf8");
  const others = ["herdr-todos", "herdr-memories", "herdr-issues", "herdr-triage", "herdr-pi-widget/kit"].map((r) => path.join(here, "..", "..", r, "frame.js")).filter((f) => fs.existsSync(f));
  for (const f of others) assert.ok(fs.readFileSync(f, "utf8") === mine, `${f} differs from this copy`);
});
