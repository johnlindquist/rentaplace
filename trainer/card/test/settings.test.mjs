// Copy this test into a widget beside settings.mjs: it proves the convention, not one widget's keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineSettings, SettingsError, THINKING } from "../settings.mjs";

const settings = defineSettings("demo-widget", {
  model: { type: "model", default: "anthropic/claude-haiku-5-5", meaning: "The small model that judges" },
  thinking: { type: "enum", values: THINKING, default: "off", meaning: "How hard the model thinks" },
  refreshSeconds: { type: "number", min: 30, default: 300, meaning: "Seconds between refreshes" },
  sources: { type: "list", default: ["inbox"], meaning: "What to read" },
  showDone: { type: "boolean", default: false, meaning: "Show finished items" },
});

function place() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsettings-"));
  const where = { home: path.join(dir, "home"), project: path.join(dir, "project"), env: {} };
  const p = settings.paths(where);
  const write = (file, data) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data)));
  return { dir, where, p, write };
}

test("order: defaults < user file < project file < environment, and each value says where it came from", () => {
  const { where, p, write } = place();
  assert.equal(p.user, path.join(where.home, ".config", "herdr-demo-widget", "config.json"));
  assert.equal(p.project, path.join(where.project, ".herdr", "demo-widget.json"));
  let s = settings.load(where);
  assert.deepEqual([s.values.model, s.sources.model, s.problems], ["anthropic/claude-haiku-5-5", "default", []]);
  write(p.user, { model: "a/user", refreshSeconds: 60, thinking: "low" });
  s = settings.load(where);
  assert.deepEqual([s.values.model, s.sources.model, s.values.refreshSeconds, s.sources.sources], ["a/user", "user file", 60, "default"]);
  write(p.project, { model: "a/project", refreshSeconds: 90 });
  s = settings.load(where);
  assert.deepEqual([s.values.model, s.sources.model, s.values.thinking, s.sources.thinking], ["a/project", "project file", "low", "user file"]);
  s = settings.load({ ...where, env: { HERDR_DEMO_WIDGET_MODEL: "a/env", HERDR_DEMO_WIDGET_REFRESH_SECONDS: "120", HERDR_DEMO_WIDGET_SOURCES: "inbox, board", HERDR_DEMO_WIDGET_SHOW_DONE: "true" } });
  assert.deepEqual([s.values.model, s.sources.model, s.values.refreshSeconds, s.values.sources, s.values.showDone], ["a/env", "environment", 120, ["inbox", "board"], true]);
  assert.deepEqual(s.problems, []);
  const other = path.join(where.home, "elsewhere.json");
  write(other, { model: "a/elsewhere" });
  assert.equal(settings.load({ ...where, project: null, env: { HERDR_DEMO_WIDGET_CONFIG: other } }).values.model, "a/elsewhere");
});

test("an unknown key is reported, never silently ignored; a wrong value is reported and the weaker value stays", () => {
  const { where, p, write } = place();
  write(p.user, { modle: "a/typo", refreshSeconds: 5, thinking: "low" });
  const s = settings.load({ ...where, env: { HERDR_DEMO_WIDGET_THINKING: "enormous" } });
  assert.deepEqual(s.problems.map((x) => [x.code, x.key]), [["settings_unknown_key", "modle"], ["settings_invalid_value", "refreshSeconds"], ["settings_invalid_value", "thinking"]]);
  assert.match(s.problems[0].message, /does not know: modle\. Known: model, thinking, refreshSeconds/);
  assert.match(s.problems[1].message, /must be at least 30/);
  assert.deepEqual([s.values.refreshSeconds, s.sources.refreshSeconds, s.values.thinking, s.sources.thinking], [300, "default", "low", "user file"]);
});

test("a broken file is a named problem and the defaults are still used", () => {
  const { where, p, write } = place();
  write(p.user, "{ model: ");
  write(p.project, "[1]");
  const s = settings.load(where);
  assert.deepEqual(s.problems.map((x) => [x.code, x.file]), [["settings_file_broken", p.user], ["settings_file_broken", p.project]]);
  assert.equal(s.values.model, "anthropic/claude-haiku-5-5");
  assert.throws(() => settings.set("model", "a/b", where), (e) => e instanceof SettingsError && e.code === "settings_file_broken");
  assert.equal(fs.readFileSync(p.user, "utf8"), "{ model: ", "a broken file is never overwritten");
});

test("config, config set (validated, --project), config path; describe lists the keys", () => {
  const { where, p } = place();
  assert.deepEqual(settings.command(["path"], where), { path: p.user });
  assert.deepEqual(settings.command(["path", "--project"], where), { path: p.project });
  const wrote = settings.command(["set", "model", "anthropic/claude-sonnet-5"], where);
  assert.deepEqual([wrote.file, wrote.effective, wrote.source], [p.user, "anthropic/claude-sonnet-5", "user file"]);
  settings.command(["set", "refreshSeconds", "60"], where);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.user, "utf8")), { model: "anthropic/claude-sonnet-5", refreshSeconds: 60 });
  settings.command(["set", "sources", "inbox,board", "--project"], where);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.project, "utf8")), { sources: ["inbox", "board"] });
  const shown = settings.command([], where);
  assert.deepEqual(shown.settings.model, { value: "anthropic/claude-sonnet-5", from: "user file" });
  assert.deepEqual(shown.settings.sources, { value: ["inbox", "board"], from: "project file" });
  assert.deepEqual(shown.settings.thinking, { value: "off", from: "default" });
  assert.deepEqual(shown.problems, []);
  const over = settings.command(["set", "model", "a/b"], { ...where, env: { HERDR_DEMO_WIDGET_MODEL: "a/env" } });
  assert.match(over.note, /overridden by the environment/);
  for (const [argv, code] of [[["set", "modle", "x"], "settings_unknown_key"], [["set", "model", "haiku"], "settings_invalid_value"], [["set", "refreshSeconds", "soon"], "settings_invalid_value"], [["set", "model"], "settings_usage"], [["nonsense"], "settings_usage"]]) {
    assert.throws(() => settings.command(argv, where), (e) => e instanceof SettingsError && e.code === code, argv.join(" "));
  }
  assert.throws(() => settings.command(["set", "model", "a/b", "--project"], { ...where, project: null }), /--project needs a project folder/);
  const d = settings.describe();
  assert.deepEqual(d.keys.map((k) => k.key), ["model", "thinking", "refreshSeconds", "sources", "showDone"]);
  assert.deepEqual(d.keys[2], { key: "refreshSeconds", type: "number", min: 30, default: 300, env: "HERDR_DEMO_WIDGET_REFRESH_SECONDS", meaning: "Seconds between refreshes" });
  assert.deepEqual(d.order, ["default", "user file", "project file", "environment"]);
  assert.throws(() => defineSettings("x", { model: { type: "model", default: "nope", meaning: "m" } }), /default of model/);
});
