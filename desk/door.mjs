// The door of the front desk: three limits a visit must pass before a model is asked anything, and the receipt each visit leaves.
// A public address that calls a model costs money per reply, whatever the product refuses afterwards. These limits are code, not instructions.
// One home for the numbers. Each can be set per site with the named environment value; a value that is not a positive number is refused.
import fs from 'node:fs';
import path from 'node:path';

const positive = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw Error(`${name} must be a positive number, got "${raw}"`);
  return n;
};
/** The door's limits. Judgements for a small product's desk, not measured numbers. */
export const doorLimits = () => ({
  maxMessageChars: positive('RAP_DESK_MAX_CHARS', 2000),   // a question or a hold request is a few sentences
  visitsPerMinute: positive('RAP_DESK_VISITS_PER_MINUTE', 10), // per visitor: a signed-in guest, or else the address it calls from
  dailySpendUsd: positive('RAP_DESK_DAILY_USD', 2),        // across all visitors, by the model's reported cost
});

const day = ms => new Date(ms).toISOString().slice(0, 10);
/** @typedef {{ok: true} | {ok: false, status: number, code: string, message: string, retryAfterSeconds?: number}} Admitted */
/** @returns {Admitted} */
const turnedAway = (status, code, message, extra = {}) => ({ ok: false, status, code, message, ...extra });

/**
 * A door keeps the count of recent visits per visitor and today's spend. `admit` is asked before the model; `charge` after it.
 * `spentToday` seeds today's spend (from the receipts file) so a restart does not reopen a closed desk.
 */
export function makeDoor({ limits = doorLimits(), now = Date.now, spentToday = 0 } = {}) {
  const visits = new Map();
  let spendDay = day(now()), spent = spentToday;
  const roll = () => { const d = day(now()); if (d !== spendDay) { spendDay = d; spent = 0; } };
  const recentOf = visitor => { const t = now(); return (visits.get(visitor) || []).filter(at => t - at < 60000); };
  const count = visitor => { const recent = recentOf(visitor); recent.push(now()); visits.set(visitor, recent); };
  /** @returns {Admitted | null} */
  const tooMany = visitor => {
    const t = now(), recent = recentOf(visitor);
    if (recent.length < limits.visitsPerMinute) return null;
    visits.set(visitor, recent);
    const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + 60000 - t) / 1000));
    return turnedAway(429, 'TOO_MANY_VISITS', `The desk takes up to ${limits.visitsPerMinute} messages a minute from one visitor. Try again in ${retryAfterSeconds} seconds.`, { retryAfterSeconds });
  };
  return {
    limits,
    /** Order: size (costs nothing to check), then this visitor's rate, then the desk's spend for the day. */
    /** @param {{visitor: string, message: unknown}} visit @returns {Admitted} */
    admit({ visitor, message }) {
      roll();
      const length = String(message ?? '').length;
      if (length > limits.maxMessageChars) return turnedAway(413, 'MESSAGE_TOO_LONG', `A message to the desk can be up to ${limits.maxMessageChars} characters. This one is ${length}.`);
      const busy = tooMany(visitor); if (busy) return busy;
      if (spent >= limits.dailySpendUsd) return turnedAway(503, 'DESK_CLOSED_FOR_TODAY', 'The desk has reached its spending limit for today. The site and its API still work; the desk opens again tomorrow (UTC).');
      count(visitor);
      return { ok: true };
    },
    /** A typed tool call that asks no model (quote, house_rules, place_hold over MCP): this visitor's rate only, on the same count as the desk. */
    /** @param {{visitor: string}} call @returns {Admitted} */
    admitCall({ visitor }) {
      const busy = tooMany(visitor); if (busy) return busy;
      count(visitor);
      return { ok: true };
    },
    charge(usd) { roll(); spent += Number(usd) || 0; return spent; },
    spentToday() { roll(); return spent; },
  };
}

/** One line per visit: how long, how much of the prompt was read from the model host's cache, what it cost, and whether the words matched the record. */
/** @param {{at: string, visitor: string, ms: number, usage?: {input?: number, output?: number, cacheRead?: number, cacheWrite?: number}, cost?: number, model?: string, tools?: string[], replyAgrees?: boolean|null, held?: string|null, turnedAway?: string|null}} visit */
export function receipt({ at, visitor, ms, usage = {}, cost = 0, model, tools = [], replyAgrees, held = null, turnedAway: away = null }) {
  const fresh = usage.input || 0, cached = usage.cacheRead || 0, written = usage.cacheWrite || 0, prompt = fresh + cached + written;
  return { at, visitor, ms: Math.round(ms), model: model || null, promptTokens: prompt, cachedTokens: cached, cachedShare: prompt ? Math.round((cached / prompt) * 100) / 100 : 0, outputTokens: usage.output || 0, costUsd: Math.round(cost * 1e6) / 1e6, tools, held, replyAgrees: replyAgrees ?? null, turnedAway: away };
}
export function saveReceipt(file, line) { if (!file) return; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(line) + '\n'); }
/** Today's spend so far, read from the receipts file. A missing file is zero; a damaged line is skipped, not guessed. */
export function spentOn(file, dayText) {
  if (!file || !fs.existsSync(file)) return 0;
  let sum = 0;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; } if (String(r.at).slice(0, 10) === dayText) sum += Number(r.costUsd) || 0; }
  return sum;
}
