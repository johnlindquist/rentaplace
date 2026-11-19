// The front desk: Booking's customer-safe side, answering one visitor message with three tools (desk/tools/desk.ts).
// Used by POST /desk in src/server.ts and by the desk checks. Pi in print mode, small model, no other tools, no saved session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SMALL_MODEL } from '../models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PI = process.env.PI_BIN || 'pi';
export const DESK_MODEL = process.env.DESK_MODEL || SMALL_MODEL;

const section = (text, title) => (text.match(new RegExp(`^##\\s+${title}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm')) || [, ''])[1].trim();
/** Drop a line's trailing source note "(commit …; file …)" and a glossary line's "(Code: …)" note. Sources are for colleagues. */
export const withoutSources = text => text.split('\n').map(l => l.replace(/\s*\((?:Code:|commit |decision |tracker card |`[^`]+`[,;]|`test\/)[^()]*(?:\([^()]*\)[^()]*)*\)\s*$/i, '').replace(/\s*\(`[^`]+`\.?\)\s*$/, '')).join('\n');
/** What the desk may know: the Job, the glossary and the customer-facing memories without sources, and the desk rules. Never the internal memories. */
export function deskKnowledge(root = ROOT) {
  const dir = path.join(root, 'agents', 'booking');
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  const glossary = withoutSources(read('glossary.md')).replace(/^.*Short on purpose.*$/m, '').trim();
  const memories = withoutSources(section(read('memories.md'), 'Customer-facing'));
  return [section(read('agent.md'), 'Job').replace(/\s+/g, ' '), glossary, `## What guests are told\n${memories}`, section(read('desk.md'), 'At the desk')].join('\n\n');
}
/** The whole of Booking, as Day 3 runs it: the control for the leak check. */
export function internalKnowledge(root = ROOT) {
  const dir = path.join(root, 'agents', 'booking');
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8').trim();
  return [section(read('agent.md'), 'Job').replace(/\s+/g, ' '), read('glossary.md'), read('memories.md')].join('\n\n');
}
/** Things only a colleague should see: commit hashes, repository paths, test names, tracker cards, function names. */
export function leaks(reply, root = ROOT) {
  const dir = path.join(root, 'agents', 'booking');
  const internal = fs.readFileSync(path.join(dir, 'memories.md'), 'utf8') + fs.readFileSync(path.join(dir, 'glossary.md'), 'utf8');
  const marks = new Set();
  for (const m of internal.matchAll(/`([^`]+)`/g)) if (/[\/_.-]|[a-z][A-Z]/.test(m[1]) && m[1].length > 5) marks.add(m[1]);
  for (const m of internal.matchAll(/commit ([0-9a-f]{7})/g)) marks.add(m[1]);
  for (const m of internal.matchAll(/added in ([0-9a-f]{7})/g)) marks.add(m[1]);
  return [...marks].filter(mark => reply.includes(mark));
}

/**
 * Does the desk's spoken reply agree with the confirmation record? The record is what the product saved; the reply is
 * the model's words. With a confirmation, the reply must give its reference and its total, and no other hold reference.
 * With no confirmation, the reply must not give a hold reference at all (it would be saying "held" with nothing saved).
 */
export function agrees(reply, confirmation) {
  const refs = [...new Set(String(reply).match(/HOLD-[0-9A-Z]{4,}/gi) || [])].map(r => r.toUpperCase());
  const problems = [];
  if (!confirmation) { if (refs.length) problems.push(`the reply gives ${refs.join(', ')} and no hold was saved`); return { ok: !problems.length, problems }; }
  const ref = String(confirmation.reference).toUpperCase();
  if (!refs.includes(ref)) problems.push(`the reply does not give the saved reference ${ref}`);
  const others = refs.filter(r => r !== ref); if (others.length) problems.push(`the reply gives another reference: ${others.join(', ')}`);
  const dollars = (confirmation.totalCents / 100).toFixed(2), plain = String(reply).replace(/,/g, '');
  const amounts = [...new Set(plain.match(/\$\s?\d+(?:\.\d{1,2})?/g) || [])].map(a => Number(a.replace(/[$\s]/g, '')).toFixed(2));
  if (!amounts.includes(dollars)) problems.push(`the reply does not give the saved total $${dollars}`);
  return { ok: !problems.length, problems };
}

function runPi({ system, message, model, env, tools }) {
  return new Promise((resolve, reject) => {
    const argv = ['-p', '--mode', 'json', '--no-session', '-ne', '-ns', '-np', '-nc', '--no-mcp', ...(tools ? ['-e', path.join(HERE, 'tools', 'desk.ts'), '--tools', env.DESK_BROKEN === 'norules' ? 'quote,place_hold' : 'quote,place_hold,house_rules'] : ['--no-tools']), '--thinking', 'off', '--model', model, '--system-prompt', system, message];
    const child = spawn(PI, argv, { cwd: os.tmpdir(), env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      let text = '', used = '', cost = 0; const toolNames = [], usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const line of out.split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'message_end' && e.message?.role === 'assistant') {
          const t = (e.message.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
          for (const c of e.message.content || []) if (c.type === 'toolCall') toolNames.push(c.name);
          if (t.trim()) text = t;
          used = `${e.message.provider}/${e.message.model}`; cost += e.message.usage?.cost?.total || 0;
          for (const k of Object.keys(usage)) usage[k] += Number(e.message.usage?.[k]) || 0;
          if (e.message.errorMessage) err += e.message.errorMessage;
        }
      }
      if (!text.trim()) return reject(Error(`${model} gave no reply (exit ${code}): ${err.trim().split('\n').slice(-1)[0] || 'no output'}`));
      if (used !== model) return reject(Error(`asked for ${model}, but ${used} answered`));
      resolve({ text: text.trim(), cost, toolNames, usage });
    });
  });
}

// This is a missing-evidence signal, not a fact checker. Include house-rule questions as well
// as explicit rule answers so a turn cannot clear the signal by omitting its answer marker.
const houseRuleWords = /\b(?:house rules?|pets?|dogs?|cats?|animals?|quiet hours|noise|part(?:y|ies)|events?|smok\w*|vap\w*|parking|park (?:my|a|the|our|two|overnight)|(?:check[ -]?(?:in|out)|arriv\w*|leav\w*) (?:time|hours|early|late|by|after|before|at \d)|(?:what time|how early|how late).{0,70}(?:check[ -]?(?:in|out)|arriv\w*|leav\w*))\b/i;
export function houseRuleEvidence(calls, message, modelReply) {
  const evidenceCalls = calls.filter(c => c.tool === 'house_rules');
  const sources = [...new Map(evidenceCalls.flatMap(c => c.evidence.passages)
    .map(p => [JSON.stringify(p), p])).values()];
  const ruleTurn = evidenceCalls.length > 0 || houseRuleWords.test(`${message}\n${modelReply}`) || /^\s*HOUSE RULE:/im.test(modelReply);
  return { sources, unsupported: ruleTurn && sources.length === 0 };
}

// The easy-to-verify miss case does not depend on a model formatting a handoff or resisting a guess.
export function unknownHouseRule(calls) {
  const misses = calls.filter(c => c.tool === 'house_rules' && !c.evidence.passages.length);
  if (!misses.length) return null;
  const replies = misses.map(({ input: { home, topic }, evidence: { listing } }) => {
    const amenities = listing?.amenities?.slice(0, 12).join(', ');
    return `I don't know the ${topic} rule for ${listing?.title || home}.${amenities ? ` The listing shows these amenities: ${amenities}. Amenities don't establish this rule.` : ''}`;
  });
  return { reply: `${[...new Set(replies)].join(' ')} I've left this for a person to check.`, asked: `Check the unpublished house rule: ${misses.map(c => `${c.input.home} (${c.input.topic})`).join(', ')}.` };
}

/** Ask a model with given knowledge and no tools (leak check). */
export const askPlain = (system, message, model = DESK_MODEL) => runPi({ system, message, model, env: {}, tools: false });

/**
 * One visitor message to the desk. `cookie` is the visitor's own sign-in, passed straight through to the product.
 * Returns the reply, the confirmation (built here from what the product saved, never from the model's words),
 * and whether something was left for a person (appended to `list`, one line each).
 */
export async function askDesk({ message, cookie = '', guest = null, site, list, model = DESK_MODEL, broken = process.env.DESK_BROKEN || '' }) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-')), 'tools.jsonl');
  const who = guest ? `The visitor is signed in as the guest ${guest.name}.` : 'The visitor is not signed in. A hold needs a guest sign-in; you can still quote.';
  const knowledge = deskKnowledge().replace('You have three tools.', broken === 'norules' ? 'The house_rules tool is unavailable in this run; only quote and place_hold are available.' : 'You have three tools.');
  let r, calls; const began = Date.now();
  try {
    // The stable prefix: tools and knowledge are the same on every visit and come first; the visitor's line and message come last,
    // so the model host can reuse the part it has already read (the receipt's cachedTokens says whether it did).
    r = await runPi({ system: `${knowledge}\n\n${who}`, message: String(message).slice(0, 4000), model, tools: true, env: { DESK_SITE: site, DESK_COOKIE: cookie, DESK_GUEST: guest?.id || '', DESK_LOG: log, DESK_BROKEN: broken } });
    calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  } finally { fs.rmSync(path.dirname(log), { recursive: true, force: true }); }
  const held = calls.filter(c => c.tool === 'place_hold' && c.hold).at(-1);
  const m = r.text.match(/^\s*FOR A PERSON:\s*(.+)$/m);
  const evidence = houseRuleEvidence(calls, message, r.text);
  const unknown = broken === 'norules' ? null : unknownHouseRule(calls);
  const reply = unknown?.reply ?? r.text.replace(/^\s*FOR A PERSON:.*$/gm, '').replace(/^\s*HOUSE RULE:\s*/im, '').trim();
  const asked = unknown?.asked ?? m?.[1].trim();
  let forAPerson = null;
  if (asked) { forAPerson = { at: new Date().toISOString(), guest: guest?.id || null, asked, message: String(message).slice(0, 500), status: 'waiting for a person' }; if (list) { fs.mkdirSync(path.dirname(list), { recursive: true }); fs.appendFileSync(list, JSON.stringify(forAPerson) + '\n'); } }
  const confirmation = held ? { ...held.hold, sameRequestAsBefore: !!held.replayed } : null;
  return { reply, ...(unknown ? { draftReply: r.text } : {}), confirmation, replyAgrees: agrees(reply, confirmation), forAPerson, calls, cost: r.cost, usage: r.usage, ms: Date.now() - began, model, ...evidence };
}
