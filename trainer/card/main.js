// Drafts: one card per Trainer run: everyday checks before and after, the one sealed run, rounds and
// spend against their caps, and which of the two keys is there. Everything shown comes from
// drafts.mjs, which reads the sealed folder read-only. No model is called here. Enter asks Main to
// show what the draft changes. The card cannot approve or keep a draft.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, focused, exec, appHome, run, theme, nextCommand, shared, setShared, openOverlay, closeOverlay, props, layout } from "herdr";
import { step, widgetDirection, COLLAPSE_KEY, loadCollapsed, applyCollapse, returnTarget, tip, keepInView, wheelTop, maxTop, fitCount, estimateViewport } from "./nav.js";
import { createFrame, frameParts } from "./frame.js";

const NAME = "drafts";
const TITLE = "Drafts";
const helper = () => `${appHome()}/mods/${NAME}/drafts.mjs`;
const callHelper = (argv, timeout = 15_000) => exec("node", ["--disable-warning=ExperimentalWarning", helper(), ...argv], { timeout });
function helperError(r) {
  const text = String(r.stderr ?? "").trim();
  try {
    return JSON.parse(text.split("\n").pop()).error.message;
  } catch {
    return text.slice(0, 200) || `exit ${r.code}`;
  }
}
const sessionName = (title) => String(title ?? "").replace(/^π\s*-\s*/, "").replace(/\s+-\s+[^-]+$/, "").trim();
// Main in the shown space: the Pi session named Main, else the first Pi tab (as Issues does).
function mainIn(space) {
  const pis = agents().filter((a) => a.space === space && a.app === "pi");
  const main = pis.find((a) => /^main$/i.test(sessionName(a.title))) ?? pis.slice().sort((x, y) => x.tab_index - y.tab_index)[0] ?? null;
  return main?.address ?? null;
}
const windowHeight = () => {
  try {
    return /** @type {any} */ (globalThis).window?.viewport_size?.().height ?? 900;
  } catch {
    return 900;
  }
};
// Fixed row height (the list is windowed by hand): padding 18 + head 18 + state 16 + five rows 85 + gaps 24 + border 2.
const ROW = 163;

function legend(t, keys) {
  return h_flex()
    .flex_none()
    .px(12)
    .py(5)
    .gap_x(8)
    .gap_y(3)
    .flex_wrap()
    .border_t(1)
    .border_color(t.border)
    .children(
      keys.map(([k, label]) =>
        h_flex()
          .id(`legend-${label}`)
          .gap(4)
          .items_center()
          .tooltip(tip({ Next: "Next widget", Back: "Back to Main", Select: "Select a run" }[label] ?? label, k))
          .child(div().px(4).rounded(3).border(1).border_color(t.border).text_size(10).text_color(t.foreground).child(k))
          .child(div().text_size(10.5).text_color(t.dim).child(label)),
      ),
    );
}

export default class Drafts extends View {
  init(_props, cx) {
    this.doc = null; // the last `show` document
    this.error = null;
    this.busy = false;
    this.notice = null;
    this.sel = null; // the selected run's id
    this.top = 0;
    this.viewH = null;
    this.lastHeights = null;
    this.lastVp = 0;
    this.before = null;
    this.project = null;
    this.roots = {}; // cwd -> git root
    this.space = null;
    this.every = 10_000;
    this.last = 0;
    this.collapsed = loadCollapsed(localStorage, NAME);
    this.handle = cx.focus_handle();
    this.frame = createFrame({ mod: NAME, h: { layout, run, shared, setShared, openOverlay, closeOverlay, props } });
    const carried = this.frame.start();
    if (carried) {
      this.sel = carried.sel ?? null;
      this.top = carried.top ?? 0;
      if (typeof carried.collapsed === "boolean") this.collapsed = carried.collapsed;
    }
    if (this.frame.floating) this.handle.focus();
    this.tick(cx);
    cx.timer.every(2000, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.refresh(cx);
        else if (c === "focus") this.takeKeyboard();
        else this.command(c, cx);
        cx.notify();
      }
    });
  }

  tick(cx) {
    this.frame.check();
    if (!this.frame.active()) return; // hidden, closed or popped out elsewhere: no reading
    // The project is the git root of the focused terminal's folder (as Issues does); it stays while
    // the keyboard is in the widget.
    const f = focused();
    const cwd = f?.cwd;
    if (f?.space) this.space = f.space;
    if (cwd) {
      if (this.roots[cwd] === undefined) {
        this.roots[cwd] = null;
        cx.spawn(async (cx) => {
          const r = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], /** @type {any} */ ({ timeout: 5000 }));
          this.roots[cwd] = r.code === 0 ? r.stdout.trim() : cwd;
          this.tick(cx);
          cx.notify();
        });
        return;
      }
      const project = this.roots[cwd];
      if (project && project !== this.project) {
        this.project = project;
        this.doc = null;
        this.last = 0;
      }
    }
    if (Date.now() - this.last >= this.every) this.refresh(cx);
  }

  refresh(cx) {
    if (!this.frame.active() || this.busy) return;
    if (!this.project) return ((this.doc = null), (this.error = null), cx.notify());
    this.busy = true;
    this.last = Date.now();
    const project = this.project;
    cx.spawn(async (cx) => {
      const r = await callHelper(["show", "--root", project]);
      this.busy = false;
      if (project !== this.project) return;
      if (r.code !== 0) this.error = helperError(r);
      else {
        try {
          this.doc = JSON.parse(r.stdout);
          this.error = null;
          this.every = Math.max(2, Number(this.doc.settings?.refreshSeconds) || 10) * 1000;
        } catch {
          this.error = "The card's helper did not answer with JSON";
        }
      }
      cx.notify();
    });
  }

  viewState() {
    return { sel: this.sel, top: this.top, collapsed: this.collapsed };
  }

  close() {
    this.frame.closed();
  }

  takeKeyboard() {
    const f = focused();
    if (f && (f.pane || f.terminal)) this.before = { pane: f.pane, terminal: f.terminal };
    this.handle.focus();
  }

  setCollapsed(on) {
    this.collapsed = on;
    if (this.frame.floating) return;
    applyCollapse({ mod: NAME, collapsed: on, storage: localStorage, layout, run });
  }

  send(cx) {
    if (!this.frame.active()) return;
    const h = (this.doc?.drafts ?? []).find((x) => x.id === this.sel);
    const why = this.sendBlocked(h);
    if (why) return ((this.notice = why), cx.notify());
    const terminal = mainIn(this.space);
    this.notice = "Sending to Main…";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await callHelper(["act", h.id, "send-main", "--root", this.project, "--terminal", terminal], 30_000);
      this.notice = r.code === 0 ? `Asked Main to show run ${h.id}` : helperError(r);
      cx.notify();
    });
  }

  /** Why Enter cannot send right now, or null. */
  sendBlocked(h) {
    if (!h) return "No run selected";
    if (!mainIn(this.space)) return "No Main conversation in this space";
    return null;
  }

  command(k, cx) {
    if (k === "escape" && this.frame.dragging() === "mine") return (this.frame.dragCancel(), true);
    if (this.frame.command(k, this.viewState())) return true;
    if (k === "escape") {
      const t = returnTarget(this.before, null);
      this.before = null;
      if (t) run("pane.focus", t);
      return true;
    }
    if (k === COLLAPSE_KEY || k === "collapse") return (this.setCollapsed(!this.collapsed), true);
    if (k === "r") return (this.refresh(cx), true);
    const dir = widgetDirection(k);
    if (dir) return (run("pane.go", { direction: dir }), true);
    if (this.collapsed) return false;
    if (k === "enter" || k === "send-main") return (this.send(cx), true);
    const list = (this.doc?.drafts ?? []).map((h) => h.id);
    const at = Math.max(0, list.indexOf(this.sel));
    const next = step(at, list.length, k);
    if (next != null) {
      this.sel = list[next];
      this.notice = null;
      if (this.lastHeights) this.top = keepInView(this.top, next, this.lastHeights, this.lastVp);
      return true;
    }
    return false;
  }

  row(t, id, label, color, value, hint) {
    return h_flex()
      .id(`row-${label}-${id}`)
      .h(17)
      .gap(6)
      .items_center()
      .tooltip(hint)
      .child(div().flex_none().w(84).text_size(11).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(color).child(value));
  }

  card(t, d, selected) {
    const box = v_flex()
      .id(`draft-${d.id}`)
      .h(ROW)
      .overflow_hidden()
      .p(9)
      .gap(4)
      .rounded(7)
      .border(1)
      .border_color(selected ? t.accent : t.border)
      .bg(selected ? t.hover : t.chrome)
      .cursor_pointer()
      .on_click((_e, cx) => {
        this.sel = d.id;
        this.takeKeyboard();
        cx.notify();
      });
    const state = d.state === "waiting" ? "Waiting for you" : d.state === "approved" ? `Approved by ${d.approvedBy}` : "Cannot be kept";
    const stateColor = d.state === "waiting" ? t.working : d.state === "approved" ? t.done : t.blocked;
    const frac = (p) => (p ? `${p.cleared} of ${p.of}` : "not run");
    const ok = (p) => Boolean(p) && p.cleared === p.of;
    return box
      .child(
        h_flex()
          .h(18)
          .gap(6)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(`${d.agent} · ${d.id}`))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(d.version.slice(0, 8))),
      )
      .child(div().id(`state-${d.id}`).h(16).truncate().text_size(11.5).text_color(stateColor).tooltip(d.reasons.length ? d.reasons.join("\n") : d.state === "waiting" ? "The checks passed on exactly this version. It is kept only when you approve it yourself." : "Both keys are there.").child(d.reasons.length ? `${state}: ${d.reasons[0]}` : state))
      .child(this.row(t, d.id, "Everyday", ok(d.everyday) ? t.done : t.blocked, `${d.start ? `${d.start.cleared} → ` : ""}${frac(d.everyday)} cleared`, "The practice checks the Trainer may study: cleared at the start, then on its best draft"))
      .child(this.row(t, d.id, "Sealed, once", ok(d.sealed) ? t.done : t.blocked, d.sealed ? `${frac(d.sealed)} cleared` : "not run", "The cases the Trainer never saw, run one time on its best draft"))
      .child(this.row(t, d.id, "Rounds", t.muted, `${d.rounds.used} of ${d.rounds.cap ?? "?"}${d.rounds.rejected ? ` · ${d.rounds.rejected} rejected` : ""}`, d.stopped || "Why it stopped was not recorded"))
      .child(this.row(t, d.id, "Spent", t.muted, `$${d.spent.toFixed(2)}${d.budget ? ` of $${d.budget.toFixed(2)}` : ""}`, "The Trainer's and the checks' model cost against the cap"))
      .child(this.row(t, d.id, "Two keys", d.checksPassed && d.approved ? t.done : t.muted, `checks ${d.checksPassed ? "✓" : "✗"} · person ${d.approved ? "✓" : "—"}`, "Kept only when the checks passed on exactly this version and a person approved exactly this version. The card cannot approve."));
  }

  render() {
    const t = theme();
    const doc = this.doc;
    const drafts = doc?.drafts ?? [];
    const hasKeys = this.handle.is_focused();
    if (!drafts.some((h) => h.id === this.sel)) this.sel = drafts[0]?.id ?? null;
    const selected = drafts.find((h) => h.id === this.sel);
    const c = doc?.counts ?? { drafts: 0, waiting: 0, approved: 0, blocked: 0 };
    const summary = doc?.unavailable ? "no sealed folder" : `${c.waiting} waiting for you${c.blocked ? ` · ${c.blocked} blocked` : ""}${c.approved ? ` · ${c.approved} approved` : ""}`;
    const parts = frameParts({ div, h_flex, v_flex }, t, this.frame, tip, () => this.viewState());
    const header = h_flex()
      .id("drafts-header")
      .px(14)
      .h(36)
      .flex_none()
      .gap(8)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(this.frame.floating ? `${TITLE} · drag to move the window` : `${tip(this.collapsed ? `Expand ${TITLE}` : `Collapse ${TITLE}`, "−")} · drag onto another widget to move it`)
      .on_click(() => this.setCollapsed(!this.collapsed))
      .on_mouse_down("left", () => {
        if (!this.handle.is_focused()) this.takeKeyboard();
        this.frame.dragStart();
      })
      .child(div().flex_none().text_size(10).text_color(t.dim).child(this.collapsed ? "▸" : "▾"))
      .child(div().flex_none().text_size(11.5).font_medium().text_color(hasKeys ? t.accent : t.dim).child(TITLE))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(`· ${summary}`))
      .child(
        div()
          .id("drafts-refresh")
          .flex_none()
          .px(4)
          .rounded(5)
          .text_size(11)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(this.busy ? "Reading…" : tip("Read the records now", "R"))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.refresh(cx);
          })
          .child(this.busy ? "…" : "↻"),
      )
      .children(parts.buttons);

    const shell = v_flex()
      .id("root")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.command(e.keystroke, cx)) cx.notify();
      })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_l(1)
      .border_color(t.border)
      .when(hasKeys, (el) => el.border_t(2).border_color(t.accent))
      .text_size(13)
      .relative()
      .on_mouse_up("left", () => this.frame.dragCancel())
      .child(header)
      .when(Boolean(parts.note), (el) => el.child(parts.note))
      .when(Boolean(parts.drop), (el) => el.child(parts.drop));
    if (this.collapsed) return shell;

    // Loading, no project, source unavailable, empty and failed each read differently.
    let empty = null;
    let help = null;
    if (!this.project) (empty = "No project in this space"), (help = "Open a terminal in a project that has a Trainer.");
    else if (this.error && !doc) (empty = "The card could not read the records"), (help = this.error);
    else if (!doc) empty = "Reading the Trainer's records…";
    else if (doc.unavailable) (empty = "No sealed folder here"), (help = doc.unavailable.message);
    else if (!drafts.length) (empty = "No Trainer runs yet"), (help = "A run shows here when the Trainer stops: its best draft, the checks it cleared, and whether it is waiting for you.");

    const heights = drafts.map(() => ROW + 8);
    const vp = this.viewH ?? estimateViewport(layout(), NAME, windowHeight(), 150);
    this.lastHeights = heights;
    this.lastVp = vp;
    this.top = Math.min(this.top ?? 0, maxTop(heights, vp));
    const shown = fitCount(heights, this.top, vp);
    const list = div()
      .id("drafts-list")
      .flex_1()
      .min_h(60)
      .overflow_hidden()
      .relative()
      .on_mouse_move((e) => {
        if (e.bounds?.height) this.viewH = e.bounds.height;
      })
      .on_scroll_wheel((e, cx) => {
        if (e.bounds?.height) this.viewH = e.bounds.height;
        this.top = wheelTop(this.top, e.delta.y, heights, this.viewH ?? vp);
        cx.notify();
      })
      .child(v_flex().children(heights.slice(this.top, this.top + shown + 1).map((hgt, j) => div().h(hgt).flex_none().px(10).pb(8).child(this.card(t, drafts[this.top + j], drafts[this.top + j].id === this.sel)))));
    const blocked = this.sendBlocked(selected);
    const footer = this.notice ?? (this.error && doc ? `Read failed: ${this.error}` : doc?.hidden ? `${doc.hidden} older runs not shown` : doc ? "Read from the sealed folder · no model · the card cannot approve" : "");
    return shell
      .when(Boolean(empty), (el) =>
        el.child(
          v_flex()
            .flex_1()
            .px(16)
            .pt(16)
            .gap(6)
            .child(div().text_size(12.5).text_color(t.muted).child(empty))
            .when(Boolean(help), (el) => el.child(div().text_size(12).text_color(t.dim).child(help))),
        ),
      )
      .when(!empty, (el) => el.child(v_flex().flex_1().min_h(76).pt(6).child(list).when(heights.length > shown, (el) => el.child(div().flex_none().h(16).px(14).text_size(10).text_color(t.dim).child(`Showing ${this.top + 1}–${Math.min(heights.length, this.top + shown)} of ${heights.length} · scroll or ↑↓`)))))
      .child(legend(t, [["↑↓", "Select"], ["Enter", blocked ? `Ask Main to show it (${blocked})` : "Ask Main to show it"], ["R", "Read now"], ["Tab", "Next"], ["−", "Collapse"], ...parts.legend, ["Esc", "Back"]]))
      .child(
        v_flex()
          .flex_none()
          .px(14)
          .py(7)
          .gap(2)
          .border_t(1)
          .border_color(t.border)
          .when(Boolean(doc?.settings_problems?.length), (el) => el.child(div().text_size(11).text_color(t.blocked).child(`Settings: ${(doc?.settings_problems ?? []).join(" · ")}`)))
          .child(div().id("drafts-footer").truncate().text_size(11).text_color(t.dim).tooltip(doc?.sealed ? `Sealed folder: ${doc.sealed}. Change it: node drafts.mjs config set sealed <folder>` : "Nothing read yet").child(footer)),
      );
  }
}
