// Widget navigation: one set of rules for every sidebar widget (Issues, Todos, Memories).
// The same file is copied into each mod; test/nav.test.mjs proves the copies match.
// Pure: no herdr imports, so Node tests can load it.
//
// The rules
// - ↑/↓ (or k/j) move the selection inside one widget. They stop at the ends: never wrap, never
//   jump to another widget.
// - Home/End go to the first/last item; PageUp/PageDown move a page (PAGE items).
// - Tab / Shift+Tab move to the next/previous widget (the one below/above).
// - Esc gives the keyboard back to the conversation that had it.
// - "-" collapses or expands the widget; so does clicking its header. Collapsed, it is one
//   header line (name · count · state) and its height goes to the widgets around it.
// - The selected item is kept in view: each list shows its items from a first index (`top`);
//   moving the selection changes `top` only when the selection would leave the visible part.
//   (Herdr's virtual lists forbid handlers in rows, and plain scroll areas can't be scrolled
//   from code, so the widgets window their lists themselves with these functions.)
// - The mouse wheel scrolls the widget under the pointer only.

export const NAV_VERSION = 1;
export const PAGE = 5;
export const COLLAPSE_KEY = "-";
export const HEADER_PX = 36; // a collapsed widget's height

/** The next selected index for a key, or null when the key isn't navigation. Never wraps. */
export function step(index, count, keystroke, page = PAGE) {
  if (!count) return null;
  const i = Math.min(Math.max(index ?? 0, 0), count - 1);
  switch (keystroke) {
    case "down":
    case "j":
      return Math.min(count - 1, i + 1);
    case "up":
    case "k":
      return Math.max(0, i - 1);
    case "home":
      return 0;
    case "end":
      return count - 1;
    case "pagedown":
      return Math.min(count - 1, i + page);
    case "pageup":
      return Math.max(0, i - page);
    default:
      return null;
  }
}

/** Tab / Shift+Tab: the direction of the widget to move to, else null. */
export function widgetDirection(keystroke) {
  if (keystroke === "tab") return "down";
  if (keystroke === "shift-tab") return "up";
  return null;
}

/** Collapsed state, saved per widget in a Storage (localStorage survives restarts). */
export function loadCollapsed(storage, name) {
  try {
    return storage?.getItem(`collapsed:${name}`) === "1";
  } catch {
    return false;
  }
}
export function saveCollapsed(storage, name, collapsed) {
  try {
    storage?.setItem(`collapsed:${name}`, collapsed ? "1" : "0");
  } catch {}
}

/** Finds the layout block that shows `mod`, with its parent's direction. Null if not in the layout. */
export function blockOf(tree, mod) {
  /** @type {any} */
  let found = null;
  const walk = (n, parent) => {
    if (!n || typeof n !== "object" || found) return;
    const content = n.content;
    if (content && typeof content === "object" && content.mod === mod && n.id) {
      found = { id: n.id, size: n.size ?? null, min: n.min ?? null, parentType: parent?.type ?? null, siblings: (parent?.children ?? []).length };
      return;
    }
    for (const c of n.children ?? []) walk(c, n);
  };
  walk(tree, null);
  return found;
}

/**
 * The resize that collapses or expands a stacked block; null when it isn't in a column with others.
 * `saved` is the block's size from before it collapsed (the layout then holds the collapsed size).
 */
export function collapseResize(block, collapsed, saved = null) {
  if (!block || block.parentType !== "column" || block.siblings < 2) return null;
  if (collapsed) return { id: block.id, px: HEADER_PX };
  const s = saved ?? block.size;
  if (s && typeof s.weight === "number") return { id: block.id, weight: s.weight };
  if (s && typeof s.px === "number" && s.px > HEADER_PX) return { id: block.id, px: s.px };
  return { id: block.id, weight: 1 };
}

/** One wording for every tooltip: "Action (Key)". */
export const tip = (label, key) => (key ? `${label} (${key})` : label);

/** Keys every widget shares, for its legend and tooltips. */
export const SHARED_KEYS = [
  { keys: "↑↓", label: "Select" },
  { keys: "Tab", label: "Next widget" },
  { keys: "−", label: "Collapse" },
  { keys: "Esc", label: "Back to Main" },
];

/** Saved expanded size, so expanding restores what the person had. */
export function loadSize(storage, name) {
  try {
    return JSON.parse(storage?.getItem(`size:${name}`) ?? "null");
  } catch {
    return null;
  }
}
export function saveSize(storage, name, size) {
  try {
    if (size && !(typeof size.px === "number" && size.px <= HEADER_PX)) storage?.setItem(`size:${name}`, JSON.stringify(size));
  } catch {}
}

/**
 * Collapses or expands the widget `mod`: saves the choice and, when stacked with others in a
 * column, resizes its block so the others get the height. Herdr functions are passed in.
 * @param {{ mod: string, collapsed: boolean, storage: any, layout: () => any, run: (name: string, args: any) => any }} o
 */
export function applyCollapse({ mod, collapsed, storage, layout, run }) {
  saveCollapsed(storage, mod, collapsed);
  const block = blockOf(layout(), mod);
  if (collapsed && block) saveSize(storage, mod, block.size);
  const r = collapseResize(block, collapsed, collapsed ? null : loadSize(storage, mod));
  if (r) run("layout.resize", r);
  return r;
}

/** Where Esc returns the keyboard: the pane that had it before, else the space's Main. */
export function returnTarget(before, mainPane) {
  if (before?.pane) return { pane: before.pane };
  if (before?.terminal) return { terminal: before.terminal };
  if (mainPane) return { pane: mainPane };
  return null;
}

/** How many items, from `top`, fit entirely in `viewport` px (at least 1). */
export function fitCount(heights, top, viewport) {
  let used = 0;
  let n = 0;
  for (let i = top; i < heights.length; i++) {
    if (used + heights[i] > viewport && n > 0) break;
    used += heights[i];
    n++;
  }
  return Math.max(1, n);
}

/** The new `top` so item `sel` is fully visible; unchanged when it already is. Never past the end. */
export function keepInView(top, sel, heights, viewport) {
  if (!heights.length) return 0;
  let t = Math.min(Math.max(0, top), heights.length - 1);
  if (sel < t) return sel;
  while (t < sel && sel >= t + fitCount(heights, t, viewport)) t++;
  return t;
}

/** The largest useful `top`: the last items fill the viewport. */
export function maxTop(heights, viewport) {
  let used = 0;
  for (let i = heights.length - 1; i >= 0; i--) {
    used += heights[i];
    if (used > viewport) return Math.min(heights.length - 1, i + 1);
  }
  return 0;
}

/** Mouse wheel over a list: one item per notch, clamped. `dy` < 0 scrolls toward the end. */
export function wheelTop(top, dy, heights, viewport) {
  if (!dy) return top;
  const next = top + (dy < 0 ? 1 : -1) * Math.max(1, Math.round(Math.abs(dy) / 40));
  return Math.min(Math.max(0, next), maxTop(heights, viewport));
}

/**
 * The list's height when it hasn't been measured yet (no pointer over it): the block's share of
 * its column, from the layout and the window height, minus the widget's own header and legend.
 */
export function estimateViewport(tree, mod, windowPx, chromePx) {
  const fallback = Math.max(80, windowPx / 3 - chromePx);
  /** @type {any} */
  let parent = null;
  /** @type {any} */
  let me = null;
  const walk = (n) => {
    if (!n || typeof n !== "object" || me) return;
    for (const c of n.children ?? []) {
      if (c?.content?.mod === mod) {
        parent = n;
        me = c;
        return;
      }
      walk(c);
    }
  };
  walk(tree);
  if (!me) return fallback;
  if (parent.type !== "column") return Math.max(80, windowPx - chromePx);
  const kids = parent.children ?? [];
  const px = kids.reduce((n, c) => n + (typeof c?.size?.px === "number" ? c.size.px : 0), 0);
  const weights = kids.reduce((n, c) => n + (typeof c?.size?.weight === "number" ? c.size.weight : typeof c?.size?.px === "number" ? 0 : 1), 0);
  const mine = typeof me.size?.px === "number" ? me.size.px : ((windowPx - px) * (typeof me.size?.weight === "number" ? me.size.weight : 1)) / Math.max(1, weights);
  return Math.max(60, mine - chromePx);
}
