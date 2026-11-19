import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { card, readSealed, promptFor, show } from "../drafts.mjs";
import { decide } from "../../../bin/two-keys.mjs";

const helper = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "drafts.mjs");
const record = (over = {}) => ({ run: "trainer-1", agent: "booking", version: "v1", at: "2026-11-15T08:24:36.038Z", stopped: "round 1 cleared every everyday check", improved: true, start: { of: 5, failed: 2 }, everyday: { of: 5, failed: 0 }, sealed: { of: 6, failed: 0 }, spent: 0.23, budget: 0.75, rounds: 3, history: [{ round: 0, what: "start" }, { round: 1, what: "scored" }], ...over });
function sealed(records, approvals = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drafts-")); fs.mkdirSync(path.join(dir, "results")); fs.mkdirSync(path.join(dir, "approvals"));
  for (const r of records) fs.writeFileSync(path.join(dir, "results", `${r.run}.json`), JSON.stringify(r));
  for (const a of approvals) fs.writeFileSync(path.join(dir, "approvals", `${a.agent}-${a.version}.json`), JSON.stringify(a));
  return dir;
}

test("a run whose checks passed and that nobody approved reads as waiting, with its counts", () => {
  const d = card(record(), null);
  assert.equal(d.state, "waiting"); assert.equal(d.checksPassed, true); assert.equal(d.approved, false);
  assert.deepEqual(d.start, { cleared: 3, of: 5 }); assert.deepEqual(d.everyday, { cleared: 5, of: 5 }); assert.deepEqual(d.sealed, { cleared: 6, of: 6 });
  assert.deepEqual(d.rounds, { used: 1, rejected: 0, cap: 3 }); assert.equal(d.spent, 0.23); assert.equal(d.budget, 0.75);
});

test("a failed everyday check, a failed sealed case or a sealed run that never happened blocks the run, whatever the approval says", () => {
  const yes = { agent: "booking", version: "v1", by: "John" };
  assert.deepEqual(card(record({ everyday: { of: 5, failed: 1 } }), yes).reasons, ["1 of 5 everyday checks failed"]);
  assert.deepEqual(card(record({ sealed: { of: 6, failed: 2 } }), yes).reasons, ["2 of 6 sealed cases failed"]);
  assert.deepEqual(card(record({ sealed: null }), yes).reasons, ["the sealed cases were not run"]);
  for (const over of [{ everyday: { of: 5, failed: 1 } }, { sealed: { of: 6, failed: 2 } }, { sealed: null }]) assert.equal(card(record(over), yes).state, "blocked");
});

test("approved only when a named person approved exactly this version", () => {
  assert.equal(card(record(), { version: "v1", by: "John" }).state, "approved");
  assert.equal(card(record(), { version: "v0", by: "John" }).state, "waiting");
  assert.equal(card(record(), { version: "v1", by: " " }).state, "waiting");
});

test("the card and bin/two-keys.mjs give the same answer on every combination", () => {
  for (const everyday of [{ of: 5, failed: 0 }, { of: 5, failed: 1 }, { of: 0, failed: 0 }])
    for (const sealedPart of [{ of: 6, failed: 0 }, { of: 6, failed: 1 }, null])
      for (const approval of [null, { version: "v1", by: "John" }, { version: "v2", by: "John" }, { version: "v1", by: "" }]) {
        const r = record({ everyday, sealed: sealedPart }), d = card(r, approval), rule = decide({ version: "v1", result: r, approval });
        assert.equal(d.state === "approved", rule.keep, JSON.stringify({ everyday, sealedPart, approval }));
        assert.equal(d.checksPassed, rule.checksPassed); assert.equal(d.approved, rule.approved);
      }
});

test("only Trainer records become cards, newest first; a broken file is counted, not shown", () => {
  const dir = sealed([record(), record({ run: "trainer-2", version: "v2", at: "2026-11-15T09:00:00.000Z", everyday: { of: 5, failed: 1 } }), { run: "wrong-1", agent: "booking", version: "x", everyday: { of: 5, failed: 0 }, sealed: { of: 6, failed: 1 } }], [{ agent: "booking", version: "v1", by: "John" }]);
  fs.writeFileSync(path.join(dir, "results", "broken.json"), "{"); fs.writeFileSync(path.join(dir, "results", "trainer-1-sealed-detail.json"), "{}");
  const { drafts, unreadable } = readSealed(dir);
  assert.deepEqual(drafts.map((d) => [d.id, d.state]), [["trainer-2", "blocked"], ["trainer-1", "approved"]]);
  assert.deepEqual(unreadable, ["broken.json"]);
});

test("no sealed folder reads as unavailable, not as zero runs", () => {
  const doc = show({ project: os.tmpdir(), env: {}, sealedFlag: path.join(os.tmpdir(), "no-such-sealed-folder") });
  assert.equal(doc.unavailable.code, "SEALED_MISSING"); assert.deepEqual(doc.drafts, []);
});

test("Enter asks Main to show the change, and to change and approve nothing; the card has no approve or keep action", () => {
  const dir = sealed([record()]), runs = fs.mkdtempSync(path.join(os.tmpdir(), "runs-")); fs.mkdirSync(path.join(runs, "trainer-1", "candidate"), { recursive: true });
  const p = promptFor(readSealed(dir, runs).drafts[0]);
  assert.match(p, /waiting for me/); assert.match(p, /3 of 5 cleared at the start, 5 of 5 on its best draft/); assert.match(p, /Change nothing and approve nothing/);
  const run = (...a) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", helper, ...a, "--sealed", dir, "--runs", runs, "--root", os.tmpdir()], { encoding: "utf8", env: { ...process.env, RAP_SEALED_DIR: "" } });
  const dry = run("act", "trainer-1", "send-main", "--terminal", "t1", "--dry");
  assert.equal(dry.status, 0, dry.stderr); assert.deepEqual(JSON.parse(dry.stdout).command.slice(0, 3), ["hc", "send", "t1"]);
  for (const action of ["approve", "keep"]) { const r = run("act", "trainer-1", action); assert.equal(r.status, 1); assert.match(r.stderr, /no approve or keep action/); }
  assert.equal(fs.readdirSync(dir).includes("approvals") && fs.readdirSync(path.join(dir, "approvals")).length, 0);
  assert.equal(run("act", "nope", "prompt").status, 1);
});
