#!/usr/bin/env node
// Drafts: one glanceable card per Trainer run, read from the records the Trainer's runner wrote in the
// sealed folder (results/<run>.json) and the approvals a person wrote there (approvals/). No model is
// called here, and the card cannot approve or keep anything: there is no such action.
//
//   node drafts.mjs describe
//   node drafts.mjs show [--sealed <folder>] [--runs <folder>] [--root <project>]
//   node drafts.mjs act <run> send-main --terminal <address> [--dry]     (or: act <run> prompt)
//   node drafts.mjs config | config set <key> <value> [--project] | config path
//
// JSON out; errors as {error:{code,message}} on stderr, exit 1.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { defineSettings } from "./settings.mjs";

export const settings = defineSettings("drafts", {
  sealed: { type: "string", default: "../sealed", meaning: "The sealed folder: the Trainer's recorded results and a person's approvals (absolute, or relative to the project)" },
  runs: { type: "string", default: "trainer/runs", meaning: "Where each run's draft is kept, as <runs>/<run>/candidate (absolute, or relative to the project)" },
  refreshSeconds: { type: "number", min: 2, default: 10, meaning: "Seconds between reads" },
  maxDrafts: { type: "number", min: 1, default: 20, meaning: "How many runs are shown, newest first" },
});

export class CardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const part = (p) => (p && Number.isFinite(p.of) && Number.isFinite(p.failed) ? { cleared: p.of - p.failed, of: p.of } : null);
const clean = (p) => !!p && p.of > 0 && p.cleared === p.of;

/**
 * One record and its approval (or null) as a card. The same rule as bin/two-keys.mjs `decide`, restated here
 * because an installed card stands alone; test/drafts.test.mjs holds the two to the same answers.
 *   state: "waiting" (checks passed, no person yet) · "approved" (both keys) · "blocked" (a check failed or was not run)
 */
export function card(record, approval, candidate = null) {
  const everyday = part(record.everyday), sealed = part(record.sealed), start = part(record.start);
  const reasons = [];
  if (!clean(everyday)) reasons.push(everyday ? `${everyday.of - everyday.cleared} of ${everyday.of} everyday checks failed` : "the everyday checks were not run");
  else if (!clean(sealed)) reasons.push(sealed ? `${sealed.of - sealed.cleared} of ${sealed.of} sealed cases failed` : "the sealed cases were not run");
  const checksPassed = reasons.length === 0;
  const approved = !!approval && approval.version === record.version && String(approval.by ?? "").trim() !== "";
  const scored = (record.history ?? []).filter((h) => h.what === "scored").length, rejected = (record.history ?? []).filter((h) => h.what === "rejected before scoring").length;
  return {
    id: String(record.run), agent: String(record.agent), version: String(record.version), at: record.at ?? null,
    state: !checksPassed ? "blocked" : approved ? "approved" : "waiting",
    checksPassed, approved, approvedBy: approved ? String(approval.by) : null, reasons,
    start, everyday, sealed,
    rounds: { used: scored + rejected, rejected, cap: Number(record.rounds) || null },
    spent: Number(record.spent) || 0, budget: Number(record.budget) || null,
    stopped: String(record.stopped ?? ""), improved: !!record.improved, candidate,
  };
}

/** Reads the sealed folder. Read-only. Only records a Trainer wrote (they carry `rounds`) become cards. */
export function readSealed(dir, runsDir = null) {
  const results = path.join(dir, "results");
  if (!fs.existsSync(results)) throw new CardError("SEALED_MISSING", `No recorded results in ${dir}. Point the card at the sealed folder: node drafts.mjs config set sealed <folder>`);
  const drafts = [], unreadable = [];
  for (const f of fs.readdirSync(results).filter((f) => f.endsWith(".json") && !f.endsWith("-detail.json"))) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(results, f), "utf8")); } catch { unreadable.push(f); continue; }
    if (!record || record.rounds == null || !record.run || !record.version) continue; // not a Trainer run
    const file = path.join(dir, "approvals", `${record.agent}-${record.version}.json`);
    let approval = null;
    try { if (fs.existsSync(file)) approval = JSON.parse(fs.readFileSync(file, "utf8")); } catch { approval = null; }
    const candidate = runsDir && fs.existsSync(path.join(runsDir, String(record.run), "candidate")) ? path.join(runsDir, String(record.run), "candidate") : null;
    drafts.push(card(record, approval, candidate));
  }
  drafts.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  return { drafts, unreadable };
}

/** What Enter sends to Main: a request to show the change. It asks for no change and no approval. */
export function promptFor(d) {
  return [
    `The Trainer's draft for the ${d.agent} agent is ${d.state === "waiting" ? "waiting for me" : d.state === "approved" ? "approved by " + d.approvedBy : "blocked: " + d.reasons.join("; ")} (run ${d.id}, version ${d.version}).`,
    `Everyday checks: ${d.start ? `${d.start.cleared} of ${d.start.of} cleared at the start, ` : ""}${d.everyday ? `${d.everyday.cleared} of ${d.everyday.of} on its best draft` : "not run"}. Sealed cases, run once: ${d.sealed ? `${d.sealed.cleared} of ${d.sealed.of}` : "not run"}. ${d.rounds.used} of ${d.rounds.cap ?? "?"} rounds, about $${d.spent.toFixed(2)}${d.budget ? ` of $${d.budget.toFixed(2)}` : ""}.`,
    d.candidate ? `Show me, in plain words, what the draft in ${d.candidate}/agents/${d.agent}/glossary.md changes compared with agents/${d.agent}/glossary.md.` : `The draft's folder is not known to the card; ask me where it is.`,
    "Change nothing and approve nothing. Keeping a draft needs my own approval, which only I give.",
  ].join("\n\n");
}

export function show({ project, env = process.env, sealedFlag = null, runsFlag = null }) {
  const s = settings.load({ project, env });
  const dir = path.resolve(project, sealedFlag ?? env.RAP_SEALED_DIR ?? String(s.values.sealed));
  const runsDir = path.resolve(project, runsFlag ?? String(s.values.runs));
  const doc = { widget: "drafts", sealed: dir, runs: runsDir, settings: s.values, settings_problems: s.problems.map((p) => p.message), updated_at: Date.now() };
  try {
    const { drafts, unreadable } = readSealed(dir, runsDir);
    const max = Number(s.values.maxDrafts), count = (st) => drafts.filter((d) => d.state === st).length;
    return { ...doc, drafts: drafts.slice(0, max), hidden: Math.max(0, drafts.length - max), unreadable, counts: { drafts: drafts.length, waiting: count("waiting"), approved: count("approved"), blocked: count("blocked") } };
  } catch (e) {
    if (!(e instanceof CardError)) throw e;
    return { ...doc, drafts: [], hidden: 0, unreadable: [], counts: { drafts: 0, waiting: 0, approved: 0, blocked: 0 }, unavailable: { code: e.code, message: e.message } };
  }
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: { code, message } }) + "\n");
  process.exit(1);
}

async function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const project = path.resolve(flag("--root") ?? process.cwd());
  const print = (x) => process.stdout.write(JSON.stringify(x, null, 2) + "\n");
  const cmd = argv[0];
  const read = () => show({ project, sealedFlag: flag("--sealed"), runsFlag: flag("--runs") });
  try {
    if (cmd === "describe")
      return print({
        widget: "drafts",
        title: "Drafts",
        what: "One card per Trainer run: everyday checks before and after, the one sealed run, rounds and spend against their caps, and which of the two keys is there. Read from the sealed folder; no model call. The card cannot approve or keep a draft.",
        commands: ["describe", "show [--sealed <folder>] [--runs <folder>] [--root <project>]", "act <run> send-main --terminal <address> [--dry]", "act <run> prompt", "config", "config set <key> <value> [--project]", "config path"],
        actions: [{ name: "send-main", key: "enter", label: "Ask Main to show the change" }],
        settings: settings.describe(),
      });
    if (cmd === "config") return print(settings.command(argv.slice(1).filter((a, i, l) => a !== "--root" && l[i - 1] !== "--root"), { project }));
    if (cmd === "show") return print(read());
    if (cmd === "act") {
      const [, id, action] = argv;
      const doc = read();
      if (doc.unavailable) fail(doc.unavailable.code, doc.unavailable.message);
      const d = doc.drafts.find((x) => x.id === id);
      if (!d) fail("NO_DRAFT", `No Trainer run ${id} in ${doc.sealed}.`);
      const prompt = promptFor(d);
      if (action === "prompt") return print({ id: d.id, prompt });
      if (action !== "send-main") fail("USAGE", "act <run> send-main --terminal <address> [--dry] | act <run> prompt. The card has no approve or keep action: a person runs bin/two-keys.mjs.");
      const terminal = flag("--terminal");
      if (!terminal) fail("NO_MAIN", "send-main without --terminal: no Main conversation to send to");
      const receipt = { id: d.id, action, terminal, command: ["hc", "send", terminal, prompt], prompt, at: Date.now(), dry: argv.includes("--dry") };
      if (!receipt.dry) {
        const r = spawnSync("hc", ["send", terminal, prompt], { encoding: "utf8" });
        if (r.status !== 0) fail("SEND_FAILED", (r.stderr || r.error?.message || "hc send failed").trim().slice(0, 300));
      }
      return print(receipt);
    }
    fail("USAGE", "drafts.mjs describe | show | act | config");
  } catch (e) {
    fail(e.code ?? "FAILED", e.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main(process.argv.slice(2));
