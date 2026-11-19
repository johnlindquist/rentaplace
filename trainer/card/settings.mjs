// Widget settings: one convention for every sidebar widget. The same file is copied into each
// widget, unchanged; the widget only declares its keys.
//
// Where a value comes from, weakest first:
//   1. the default in the widget's key list
//   2. the user file      ~/.config/herdr-<widget>/config.json   (or the path in HERDR_<WIDGET>_CONFIG)
//   3. the project file   <project>/.herdr/<widget>.json
//   4. the environment    HERDR_<WIDGET>_<KEY>, e.g. HERDR_ISSUES_MODEL, HERDR_ISSUES_REFRESH_SECONDS
//
// A widget opened from the Dock has no shell environment, so the file is the main way; the
// environment is for tests and the lab. Reading never throws: an unknown key, a wrong value or a
// broken file becomes a named problem the widget shows, and the defaults (or the weaker layer)
// are still used. Writing (`config set`) validates first and throws a SettingsError.
//
//   const settings = defineSettings("issues", {
//     model: { type: "model", default: "anthropic/claude-haiku-5-5", meaning: "The small model that judges" },
//     thinking: { type: "enum", values: THINKING, default: "off", meaning: "How hard the model thinks" },
//     refreshSeconds: { type: "number", min: 30, default: 300, meaning: "Seconds between refreshes" },
//   });
//   const { values, sources, problems } = settings.load({ project });
//   // in the widget's command line:  config | config set <key> <value> [--project] | config path
//   if (argv[0] === "config") return print(settings.command(argv.slice(1), { project }));
//   // in describe:  settings: settings.describe()

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SETTINGS_VERSION = 1;
/** The levels `pi --thinking` accepts that a widget offers. */
export const THINKING = ["off", "low", "medium", "high"];
export const SOURCES = ["default", "user file", "project file", "environment"];
const TYPES = ["string", "number", "boolean", "enum", "model", "list"];

/** code: settings_unknown_key | settings_invalid_value | settings_file_broken | settings_usage */
export class SettingsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();

/** Text from the environment or the command line, turned into the key's type. Files are already typed. */
function fromText(spec, text) {
  if (spec.type === "number") return text.trim() === "" ? NaN : Number(text);
  if (spec.type === "boolean") return text === "true" ? true : text === "false" ? false : text;
  if (spec.type === "list") {
    if (text.trim().startsWith("[")) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return text;
}

/** Why a value is not allowed for a key, or null when it is. The one home of validation. */
export function problemWith(spec, value) {
  switch (spec.type) {
    case "string":
      return typeof value === "string" && value !== "" ? null : "must be text";
    case "model":
      return typeof value === "string" && /^[\w.-]+\/[\w.:-]+$/.test(value) ? null : "must be provider/id, e.g. anthropic/claude-haiku-5-5 (pi --list-models shows yours)";
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (spec.integer !== false && !Number.isInteger(value)) return "must be a whole number";
      if (spec.min != null && value < spec.min) return `must be at least ${spec.min}`;
      if (spec.max != null && value > spec.max) return `must be at most ${spec.max}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "enum":
      return spec.values.includes(value) ? null : `must be one of: ${spec.values.join(", ")}`;
    case "list":
      return Array.isArray(value) && value.every((v) => typeof v === "string" && v !== "") ? null : "must be a list of text, e.g. a,b or [\"a\",\"b\"]";
    default:
      return `has an unknown type ${spec.type}`;
  }
}

/**
 * Declares a widget's settings. `widget` is its name ("issues"); `keys` maps each key to
 * { type, default, meaning, values? (enum), min?, max?, integer? (number), env? (another variable name) }.
 */
export function defineSettings(widget, keys) {
  if (!/^[a-z][a-z0-9-]*$/.test(widget)) throw new Error(`settings: widget name "${widget}" must be lowercase letters, digits and dashes`);
  for (const [key, spec] of Object.entries(keys)) {
    if (!TYPES.includes(spec.type)) throw new Error(`settings: ${key} has unknown type ${spec.type}`);
    if (!spec.meaning) throw new Error(`settings: ${key} needs a meaning`);
    const bad = problemWith(spec, spec.default);
    if (bad) throw new Error(`settings: the default of ${key} ${bad}`);
  }
  const PREFIX = `HERDR_${snake(widget)}`;
  const envName = (key) => keys[key].env ?? `${PREFIX}_${snake(key)}`;
  const known = () => Object.keys(keys).join(", ");

  function paths({ project = null, env = process.env, home = os.homedir() } = {}) {
    return {
      user: env[`${PREFIX}_CONFIG`] || path.join(home, ".config", `herdr-${widget}`, "config.json"),
      project: project ? path.join(project, ".herdr", `${widget}.json`) : null,
    };
  }

  /** A file's keys, or a named problem. A missing file is empty, not a problem. */
  function readFile(file) {
    if (!file || !fs.existsSync(file)) return { data: {}, problem: null };
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("it must be a JSON object like {\"model\": \"…\"}");
      return { data, problem: null };
    } catch (e) {
      return { data: {}, problem: { code: "settings_file_broken", file, message: `${file} cannot be read as settings (${e.message}). It is ignored until it is fixed.` } };
    }
  }

  /** The effective settings, where each came from, and everything that was wrong. Never throws. */
  function load(where = {}) {
    const env = where.env ?? process.env;
    const p = paths(where);
    const values = {};
    const sources = {};
    const problems = [];
    for (const [key, spec] of Object.entries(keys)) {
      values[key] = spec.default;
      sources[key] = "default";
    }
    const take = (source, key, value, place) => {
      const bad = problemWith(keys[key], value);
      if (bad) problems.push({ code: "settings_invalid_value", key, file: place.file, message: `${key} in ${place.label} ${bad}; got ${JSON.stringify(value)}. Using ${JSON.stringify(values[key])} (${sources[key]}).` });
      else {
        values[key] = value;
        sources[key] = source;
      }
    };
    for (const [source, file] of [["user file", p.user], ["project file", p.project]]) {
      const { data, problem } = readFile(file);
      if (problem) problems.push(problem);
      for (const [key, value] of Object.entries(data)) {
        if (!(key in keys)) problems.push({ code: "settings_unknown_key", key, file, message: `${file} has a setting this widget does not know: ${key}. Known: ${known()}.` });
        else take(source, key, value, { file, label: file });
      }
    }
    for (const key of Object.keys(keys)) {
      const text = env[envName(key)];
      if (text != null && text !== "") take("environment", key, fromText(keys[key], text), { label: `the environment (${envName(key)})` });
    }
    return { widget, values, sources, problems, paths: p };
  }

  /** Validates, then writes one key to the user file (or the project file). Returns what it wrote. */
  function set(key, text, where = {}) {
    if (!(key in keys)) throw new SettingsError("settings_unknown_key", `No setting named ${key}. Known: ${known()}.`, { key });
    const value = typeof text === "string" ? fromText(keys[key], text) : text;
    const bad = problemWith(keys[key], value);
    if (bad) throw new SettingsError("settings_invalid_value", `${key} ${bad}; got ${JSON.stringify(text)}.`, { key });
    const p = paths(where);
    const file = where.toProject ? p.project : p.user;
    if (!file) throw new SettingsError("settings_usage", "--project needs a project folder.");
    const { data, problem } = readFile(file);
    if (problem) throw new SettingsError("settings_file_broken", `${problem.message} Fix or delete it, then set ${key} again.`, { file });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, [key]: value }, null, 2) + "\n");
    fs.renameSync(tmp, file);
    const now = load(where);
    return { set: key, value, file, effective: now.values[key], source: now.sources[key], ...(now.sources[key] === (where.toProject ? "project file" : "user file") ? {} : { note: `${key} is overridden by the ${now.sources[key]}.` }) };
  }

  /** What an agent reads: every key with its type, default, meaning and environment variable. */
  function describe() {
    return {
      files: { user: `~/.config/herdr-${widget}/config.json (or the path in ${PREFIX}_CONFIG)`, project: `<project>/.herdr/${widget}.json` },
      order: SOURCES,
      keys: Object.entries(keys).map(([key, s]) => ({ key, type: s.type, ...(s.values ? { values: s.values } : {}), ...(s.min != null ? { min: s.min } : {}), ...(s.max != null ? { max: s.max } : {}), default: s.default, env: envName(key), meaning: s.meaning })),
      commands: ["config", "config set <key> <value> [--project]", "config path [--project]"],
    };
  }

  /** `config`, `config set <key> <value> [--project]`, `config path [--project]`. Returns JSON to print; throws SettingsError. */
  function command(argv, where = {}) {
    const toProject = argv.includes("--project");
    const [sub, key, ...rest] = argv.filter((a) => a !== "--project");
    if (!sub) {
      const s = load(where);
      return { widget, settings: Object.fromEntries(Object.keys(keys).map((k) => [k, { value: s.values[k], from: s.sources[k] }])), files: s.paths, problems: s.problems };
    }
    if (sub === "path") {
      const p = paths(where);
      if (toProject && !p.project) throw new SettingsError("settings_usage", "--project needs a project folder.");
      return { path: toProject ? p.project : p.user };
    }
    if (sub === "set") {
      if (!key || !rest.length) throw new SettingsError("settings_usage", `Usage: config set <key> <value> [--project]. Known: ${known()}.`);
      return set(key, rest.join(" "), { ...where, toProject });
    }
    throw new SettingsError("settings_usage", "Usage: config | config set <key> <value> [--project] | config path [--project]");
  }

  return { widget, keys, paths, load, set, describe, command, envName };
}
