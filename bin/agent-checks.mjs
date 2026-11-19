#!/usr/bin/env node
// Scenario checks for domain agents, with no window.
//
//   node bin/agent-checks.mjs booking            one agent
//   node bin/agent-checks.mjs --all              every agents/*/expectations.md
//   node bin/agent-checks.mjs --changed BASE     only agents whose folder differs from git ref BASE
//   options: --repeat N  --agent-model provider/id  --judge-model provider/id  --json FILE  --verbose
//            --cases FILE   run the checks in FILE (same form) instead of agents/<agent>/expectations.md
//            --sealed       with --cases: print only a pass count per numbered case, never its title, question or reply
//            --project DIR  read agents/<agent>/ from DIR (a candidate copy) instead of this project
//
// Each "## Title" in agents/<agent>/expectations.md is one scenario check, in the lab's own form:
//   Do: the plain question · Expect: what must come back · Never: what must not ·
//   See / Absent: exact text the runner checks itself.
// The agent under test is Pi in print mode on a small model, with no tools: it sees only its Job,
// its glossary and its memories, never the expectations. A second model judges Expect and Never
// and must quote the reply; a quote that is not in the reply is refused (a quote made of exact pieces
// joined with an ellipsis or line breaks is accepted when every piece is in the reply, in order).
// Exit code: 0 all passed, 1 a check failed, 2 the run itself broke (no model, bad file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parse, job, contains, quoted, steps, judged, observed } from './lab-expectations.mjs';
import { SMALL_MODEL, JUDGE_MODEL as DEFAULT_JUDGE } from '../models.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); if (i < 0) return fallback; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = name => { const i = args.indexOf(`--${name}`); if (i < 0) return false; args.splice(i, 1); return true; };
const root = path.resolve(flag('project', process.cwd()));
const AGENT_MODEL = flag('agent-model', process.env.AGENT_MODEL || SMALL_MODEL);
const JUDGE_MODEL = flag('judge-model', process.env.JUDGE_MODEL || DEFAULT_JUDGE);
const REPEAT = Number(flag('repeat', '1'));
const JSON_OUT = flag('json');
const CHANGED = flag('changed');
const CASES = flag('cases');
const ALL = bool('all'), VERBOSE = bool('verbose'), SEALED = bool('sealed');
const PI = process.env.PI_BIN || 'pi';
const PARALLEL = Number(process.env.AGENT_CHECKS_PARALLEL || 4);
let spent = 0;

function agentNames() {
  const dir = path.join(root, 'agents');
  const have = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => fs.existsSync(path.join(dir, n, 'expectations.md'))) : [];
  if (CHANGED) {
    const d = spawnSync('git', ['-C', root, 'diff', '--name-only', CHANGED, '--', 'agents'], { encoding: 'utf8' });
    if (d.status !== 0) throw Error(`git diff against ${CHANGED} failed: ${d.stderr.trim()}`);
    const touched = new Set(d.stdout.split('\n').map(f => f.split('/')[1]).filter(Boolean));
    return have.filter(n => touched.has(n));
  }
  if (ALL) return have;
  for (const n of args) if (!have.includes(n)) throw Error(`No agents/${n}/expectations.md in ${root}`);
  return args;
}

/** One Pi run in print mode: no tools, no extensions, no project files, no saved session. Returns the reply text. */
function pi(model, system, prompt) {
  return new Promise((resolve, reject) => {
    const argv = ['-p', '--mode', 'json', '--no-session', '-ne', '-ns', '-np', '-nc', '--no-mcp', '--no-tools', '--thinking', 'off', '--model', model, '--system-prompt', system, prompt];
    const child = spawn(PI, argv, { cwd: os.tmpdir(), env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', e => { clearTimeout(timer); reject(Error(`Could not start ${PI}: ${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      let text = '', used = '', stop = '';
      for (const line of out.split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'message_end' && e.message?.role === 'assistant') {
          text = (e.message.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
          used = `${e.message.provider}/${e.message.model}`; stop = e.message.stopReason || '';
          spent += e.message.usage?.cost?.total || 0;
          if (e.message.errorMessage) err += e.message.errorMessage;
        }
      }
      if (!text.trim()) return reject(Error(`${model} gave no reply (exit ${code}, stop ${stop}): ${err.trim().split('\n').slice(-2).join(' ') || 'no output'}`));
      // Model selection can silently fall back; refuse a reply from a model other than the one asked for.
      if (used && used !== model) return reject(Error(`asked for ${model}, but ${used} answered`));
      resolve(text.trim());
    });
  });
}

function systemPrompt(name) {
  const dir = path.join(root, 'agents', name);
  const read = f => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : '';
  return [job(dir), read('glossary.md'), read('memories.md')].filter(Boolean).join('\n\n');
}

const JUDGE = `You judge one reply from an agent against written expectations. You see only the question and the reply.
For each numbered line decide:
- an "expect" line is met only if the reply clearly does what the line says;
- a "never" line is violated only if the reply does what the line forbids.
Give a short quote copied exactly from the reply as evidence (for a "never" line that is not violated, use an empty quote).
Answer with JSON only, no code fence: {"verdicts":[{"n":1,"met":true,"quote":"..."}]}
For a "never" line, "met" means it was violated.`;

async function judge(question, reply, lines) {
  const body = `Question:\n${question}\n\nReply:\n"""\n${reply}\n"""\n\nLines:\n${lines.map((l, i) => `${i + 1}. ${l.kind}: ${l.text}`).join('\n')}`;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await pi(JUDGE_MODEL, JUDGE, body);
    try {
      const v = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')).verdicts;
      const out = lines.map((l, i) => {
        const r = v.find(x => Number(x.n) === i + 1);
        if (!r) throw Error(`no verdict for line ${i + 1}`);
        const happened = !!r.met;
        if (happened && !quoted(reply, r.quote || '')) throw Error(`quote not in the reply: "${r.quote}"`);
        return { kind: l.kind, text: l.text, ok: l.kind === 'expect' ? happened : !happened, quote: happened ? r.quote : '' };
      });
      return out;
    } catch (e) { last = e; }
  }
  return lines.map(l => ({ kind: l.kind, text: l.text, ok: false, quote: '', error: `judge: ${last.message}` }));
}

async function runCheck(name, system, item, round) {
  const asks = steps(item);
  const question = asks.map(s => s.text).join('\n');
  const reply = await pi(AGENT_MODEL, system, question);
  const lines = [...await judge(question, reply, judged(item)),
    ...observed(item).map(l => ({ kind: l.kind, text: l.text, ok: l.kind === 'see' ? contains(reply, l.text) : !contains(reply, l.text), quote: '' }))];
  return { agent: name, check: item.title, round, question, reply, lines, ok: lines.every(l => l.ok) };
}

async function pool(jobs, size) {
  const results = Array(jobs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => { while (next < jobs.length) { const i = next++; results[i] = await jobs[i](); } }));
  return results;
}

try {
  const names = agentNames();
  if (SEALED && !CASES) throw Error('--sealed needs --cases FILE');
  if (CASES && names.length !== 1) throw Error('--cases FILE checks one named agent');
  if (!names.length) { console.log(CHANGED ? `No agent folder changed since ${CHANGED}. Nothing to check.` : 'Name an agent, or use --all.'); process.exit(CHANGED ? 0 : 2); }
  const jobs = [];
  for (const name of names) {
    const spec = parse(fs.readFileSync(CASES ? path.resolve(CASES) : path.join(root, 'agents', name, 'expectations.md'), 'utf8'), name);
    const system = systemPrompt(name);
    for (const item of spec.items) for (let r = 1; r <= REPEAT; r++) jobs.push(() => runCheck(name, system, item, r));
  }
  console.log(`${SEALED ? 'Sealed cases' : 'Scenario checks'} · agent on ${AGENT_MODEL} · judge ${JUDGE_MODEL} · ${jobs.length} run${jobs.length === 1 ? '' : 's'}`);
  const results = await pool(jobs, PARALLEL);
  const groups = new Map();
  for (const r of results) { const k = `${r.agent} · ${r.check}`; groups.set(k, [...(groups.get(k) || []), r]); }
  let failed = 0, n = 0;
  for (const [k, rs] of groups) {
    const passes = rs.filter(r => r.ok).length;
    if (passes < rs.length) failed++;
    n++;
    console.log(`${passes === rs.length ? '✓' : '✗'} ${SEALED ? `${rs[0].agent} · sealed case ${n}` : k}${REPEAT > 1 || SEALED ? ` · ${passes} of ${rs.length} passed` : ''}`);
    const show = rs.find(r => !r.ok) || rs[0];
    if (!SEALED && (!show.ok || VERBOSE)) {
      console.log(`    asked: ${show.question}`);
      console.log(`    got:   ${show.reply.replace(/\s+/g, ' ').slice(0, 400)}`);
      for (const l of show.lines) console.log(`    ${l.ok ? '✓' : '✗'} ${l.kind}: ${l.text}${l.quote ? ` — "${l.quote}"` : ''}${l.error ? ` (${l.error})` : ''}`);
    }
  }
  console.log(`${failed ? `${failed} of ${groups.size} ${SEALED ? 'sealed cases' : 'checks'} failed` : `all ${groups.size} ${SEALED ? 'sealed cases' : 'checks'} passed`} · model cost about $${spent.toFixed(4)} (Pi's estimate)`);
  if (JSON_OUT) { fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true }); fs.writeFileSync(JSON_OUT, JSON.stringify({ agentModel: AGENT_MODEL, judgeModel: JUDGE_MODEL, repeat: REPEAT, cost: spent, sealed: SEALED, cases: groups.size, failed, counts: [...groups.values()].map(rs => ({ passed: rs.filter(r => r.ok).length, of: rs.length })), results }, null, 2)); }
  process.exit(failed ? 1 : 0);
} catch (e) { console.error(`agent-checks: ${e.message}`); process.exit(2); }
