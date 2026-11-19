#!/usr/bin/env node
// The Trainer: an agent that proposes a better version of a domain agent's glossary. It can only propose.
//   node bin/trainer.mjs <agent> --start <dir holding agents/<agent>/> --out <run dir> --run <ID>
//        [--rounds 3] [--budget 0.75] [--repeat 2] [--trainer-model provider/id]
// How it works:
// - The Trainer is Pi in print mode with no tools. It sees the agent's Job, glossary and memories, the everyday
//   expectations (practice questions it is allowed to study) and how many runs of each passed. It never sees the
//   sealed cases, their titles or their score.
// - It proposes one whole glossary per round. A malformed proposal is rejected before any scoring. Only glossary.md
//   can change: memories, Job and code are out of its reach because nothing it writes is copied anywhere else.
// - Each draft is scored on the everyday checks by the same runner (bin/agent-checks.mjs). It stops when a draft
//   clears every everyday check, or it runs out of rounds, or the spend cap is reached. The round cap is exact. The
//   spend cap stops a step from starting when the last step of its kind would cross it; one step that costs more
//   than the one before can still go over by that difference.
// - The best draft is then run ONCE on the sealed cases. A second sealed run for the same run ID is refused.
// - Nothing is kept. The result is recorded in $RAP_SEALED_DIR/results/<ID>.json and the draft waits in
//   <run dir>/candidate for bin/two-keys.mjs (the checks pass AND a person approves).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionOf, resultFile } from './two-keys.mjs';
import { SMALL_MODEL } from '../models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Take the proposed glossary out of the Trainer's reply, or say why it is refused. `current` is the glossary it started from. */
export function proposal(reply, current) {
  const blocks = [...String(reply).matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(m => m[1].trim());
  if (blocks.length !== 1) return { error: `expected one fenced block holding the whole glossary, found ${blocks.length}` };
  const text = blocks[0];
  if (!/^# .*glossary/i.test(text)) return { error: 'the glossary must start with its "# … glossary" heading' };
  if (text.length > 6000) return { error: `the glossary is ${text.length} characters; the limit is 6000` };
  if (/^(Do|Expect|Never|See|Absent)\s*\(/m.test(text)) return { error: 'the glossary holds check lines (Do / Expect / Never); it must define words, not carry the answers to the checks' };
  const terms = t => [...t.matchAll(/^\s*[-*]\s+\*\*([^*]+)\*\*/gm)].map(m => m[1].trim().toLowerCase());
  const missing = [...new Set(terms(current))].filter(t => !terms(text).includes(t));
  if (missing.length) return { error: `the glossary dropped a term: ${missing.join(', ')}` };
  if (text === current.trim()) return { error: 'the proposal is the same as the current glossary' };
  return { text: text + '\n' };
}
/** Better means: more checks cleared, then more runs passed. */
export const better = (a, b) => !b || a.cleared > b.cleared || (a.cleared === b.cleared && a.passed > b.passed);
const summary = s => ({ of: s.checks.length, failed: s.checks.filter(c => c.passed < c.of).length });

/**
 * The loop, with everything that costs money passed in so the caps can be tested.
 *   score(glossary)         -> { checks: [{ title, passed, of }], cleared, passed, cost }   everyday checks
 *   propose(state)          -> { reply, cost }      state = { glossary, checks, round, rounds }
 *   sealed(glossary)        -> { of, failed, cost } called at most once, after the loop, on the best draft
 */
export async function train({ start, score, propose, sealed, rounds = 3, budget = 0.75, log = () => {} }) {
  if (!Number.isInteger(rounds) || rounds < 0) throw Error(`rounds must be a whole number, got ${rounds}`);
  if (!Number.isFinite(budget) || budget <= 0) throw Error(`budget must be an amount above zero, got ${budget}`);
  let spent = 0; const history = []; let stopped = '';
  // The spend cap is hard: a step is not started when the last step of its kind would take the total past the cap.
  let proposeCost = 0;
  const capped = next => spent + next > budget || spent >= budget;
  const capWord = () => `spend cap reached ($${spent.toFixed(2)} spent of $${budget.toFixed(2)})`;
  const first = await score(start); spent += first.cost || 0;
  const scoreCost = first.cost || 0;
  let best = { glossary: start, round: 0, ...first };
  history.push({ round: 0, what: 'start', cleared: first.cleared, checks: first.checks });
  log(`start: ${first.cleared} of ${first.checks.length} everyday checks cleared`);
  let current = best;
  if (first.cleared === first.checks.length) stopped = 'the start already clears every everyday check';
  for (let round = 1; !stopped && round <= rounds; round++) {
    if (capped(proposeCost)) { stopped = capWord(); break; }
    const p = await propose({ glossary: current.glossary, checks: current.checks, round, rounds }); spent += p.cost || 0; proposeCost = p.cost || 0;
    const made = proposal(p.reply, current.glossary);
    if (made.error) { history.push({ round, what: 'rejected before scoring', why: made.error }); log(`round ${round}: proposal rejected before scoring: ${made.error}`); continue; }
    if (capped(scoreCost)) { history.push({ round, what: 'not scored', why: 'spend cap reached' }); stopped = capWord(); break; }
    const s = await score(made.text); spent += s.cost || 0;
    history.push({ round, what: 'scored', cleared: s.cleared, checks: s.checks });
    log(`round ${round}: ${s.cleared} of ${s.checks.length} everyday checks cleared`);
    current = { glossary: made.text, round, ...s };
    if (better(current, best)) best = current;
    if (s.cleared === s.checks.length) stopped = `round ${round} cleared every everyday check`;
  }
  if (!stopped) stopped = `out of rounds (${rounds})`;
  const improved = best.round > 0;
  // One sealed run, on the best draft, only if it is a new draft and the cap allows it. The Trainer never sees this.
  let sealedResult = null;
  if (improved && capped(scoreCost)) { stopped += '; the sealed cases were not run: ' + capWord(); log('the sealed cases were not run: the spend cap is reached'); }
  else if (improved) { sealedResult = await sealed(best.glossary); spent += sealedResult.cost || 0; }
  return { stopped, improved, bestRound: best.round, start: summary(first), everyday: summary(best), sealed: sealedResult && { of: sealedResult.of, failed: sealedResult.failed }, spent, budget, rounds, history, glossary: best.glossary };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  try {
    const startDir = path.resolve(flag('start', '')), out = path.resolve(flag('out', '')), run = flag('run');
    const rounds = Number(flag('rounds', '3')), budget = Number(flag('budget', '0.75')), repeat = flag('repeat', '2');
    const MODEL = flag('trainer-model', process.env.TRAINER_MODEL || SMALL_MODEL), name = args[0];
    const sealedDir = process.env.RAP_SEALED_DIR;
    if (!name || !run || !args.length || !fs.existsSync(path.join(startDir, 'agents', name || '')) || !sealedDir) throw Error('usage: trainer.mjs <agent> --start DIR --out DIR --run ID   (and RAP_SEALED_DIR set)');
    const record = resultFile(sealedDir, run);
    if (fs.existsSync(record)) throw Error(`run ${run} already has a recorded result; the sealed cases are run once per run. Use a new --run ID for a new training run.`);
    const dirOf = root => path.join(root, 'agents', name);
    const read = f => fs.readFileSync(path.join(dirOf(startDir), f), 'utf8');
    const work = path.join(out, 'work'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(path.join(work, 'agents'), { recursive: true }); fs.cpSync(dirOf(startDir), dirOf(work), { recursive: true });
    let n = 0;
    const checks = (glossary, extra, jsonFile) => {
      fs.writeFileSync(path.join(dirOf(work), 'glossary.md'), glossary);
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, 'agent-checks.mjs'), name, '--project', work, '--repeat', repeat, '--json', jsonFile, ...extra], { encoding: 'utf8' });
      if (r.status === 2 || !fs.existsSync(jsonFile)) throw Error(`the checks run broke: ${(r.stderr || r.stdout).trim().split('\n').at(-1)}`);
      return JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    };
    const score = async glossary => {
      const file = path.join(out, `everyday-${n++}.json`), j = checks(glossary, [], file);
      const by = new Map(); for (const r of j.results) { const c = by.get(r.check) || { title: r.check, passed: 0, of: 0 }; c.of++; if (r.ok) c.passed++; by.set(r.check, c); }
      const list = [...by.values()];
      return { checks: list, cleared: list.filter(c => c.passed === c.of).length, passed: list.reduce((a, c) => a + c.passed, 0), cost: j.cost };
    };
    const sealed = async glossary => { const j = checks(glossary, ['--cases', path.join(sealedDir, `${name}.md`), '--sealed'], path.join(sealedDir, 'results', `${run}-sealed-detail.json`)); return { of: j.cases, failed: j.failed, cost: j.cost }; };
    // Every question, Expect and Never line of the sealed cases: none may ever appear in what the Trainer is sent.
    // (Titles are left out: a title can be a sentence of the public glossary, which the Trainer does see.)
    const sealedMarks = fs.readFileSync(path.join(sealedDir, `${name}.md`), 'utf8').split('\n').map(l => (l.match(/^(?:Do|Expect|Never)[^:]*:\s*(.+)$/) || [])[1]).filter(Boolean);
    const SYSTEM = `You are the Trainer. You improve one file, the glossary of a domain agent, so the agent answers correctly. You can only propose: reply with the whole new glossary in one fenced code block and nothing else is used. Keep every term. Define what words mean; do not paste questions or expected answers into it. Keep it as short as it can be while every practice check passes. You get ${rounds} rounds at most.`;
    const propose = ({ glossary, checks: cs, round }) => new Promise((resolve, reject) => {
      const prompt = `Round ${round} of ${rounds}.\n\nThe agent's job:\n${read('agent.md')}\n\nIts memories (you cannot change these):\n${read('memories.md')}\n\nThe practice checks (you may study them):\n${read('expectations.md')}\n\nHow the current glossary scored on the practice checks, runs passed of runs made:\n${cs.map(c => `- ${c.title}: ${c.passed} of ${c.of}`).join('\n')}\n\nThe current glossary:\n\`\`\`\n${glossary}\`\`\`\n\nReply with the whole improved glossary in one fenced code block.`;
      fs.writeFileSync(path.join(out, `prompt-${round}.txt`), `${SYSTEM}\n\n${prompt}`);
      const leaked = sealedMarks.filter(m => `${SYSTEM}\n${prompt}`.includes(m));
      if (leaked.length) return reject(Error('a line of a sealed case is in the Trainer\'s prompt; stopping'));
      const child = spawn(process.env.PI_BIN || 'pi', ['-p', '--mode', 'json', '--no-session', '-ne', '-ns', '-np', '-nc', '--no-mcp', '--no-tools', '--thinking', 'off', '--model', MODEL, '--system-prompt', SYSTEM, prompt], { cwd: os.tmpdir(), env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = ''; child.stdout.on('data', d => o += d); child.on('error', reject);
      child.on('close', () => { let reply = '', cost = 0, used = ''; for (const line of o.split('\n')) { let e; try { e = JSON.parse(line); } catch { continue; } if (e.type === 'message_end' && e.message?.role === 'assistant') { reply = (e.message.content || []).filter(c => c.type === 'text').map(c => c.text).join(''); cost += e.message.usage?.cost?.total || 0; used = `${e.message.provider}/${e.message.model}`; } }
        if (used && used !== MODEL) return reject(Error(`asked for ${MODEL}, but ${used} answered`));
        fs.writeFileSync(path.join(out, `proposal-${round}.txt`), reply); resolve({ reply, cost }); });
    });
    console.log(`Trainer on ${name} · trainer ${MODEL} · at most ${rounds} rounds and $${budget.toFixed(2)} · everyday checks × ${repeat} · headless`);
    const r = await train({ start: read('glossary.md'), score, propose, sealed, rounds, budget, log: l => console.log(`  ${l}`) });
    const candidate = path.join(out, 'candidate'); fs.mkdirSync(path.join(candidate, 'agents'), { recursive: true }); fs.cpSync(dirOf(startDir), dirOf(candidate), { recursive: true });
    fs.writeFileSync(path.join(dirOf(candidate), 'glossary.md'), r.glossary); fs.rmSync(work, { recursive: true, force: true });
    const version = versionOf(candidate, name), { glossary, ...rest } = r;
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ run, agent: name, version, trainerModel: MODEL, at: new Date().toISOString(), ...rest }, null, 2));
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ run, agent: name, version, ...rest }, null, 2));
    console.log(`Stopped: ${r.stopped}. Spent about $${r.spent.toFixed(2)} of $${budget.toFixed(2)}.`);
    console.log(`Everyday checks: start ${r.start.of - r.start.failed} of ${r.start.of} cleared → best draft (round ${r.bestRound}) ${r.everyday.of - r.everyday.failed} of ${r.everyday.of}.`);
    console.log(r.sealed ? `Sealed cases, run once on the best draft: ${r.sealed.of - r.sealed.failed} of ${r.sealed.of} cleared.` : 'No draft beat the start, so the sealed cases were not run.');
    console.log(`Nothing was kept. Version ${version} waits in ${candidate} for a person: node bin/two-keys.mjs status ${name} ${candidate} --run ${run}`);
    process.exit(0);
  } catch (e) { console.error(`trainer: ${e.message}`); process.exit(2); }
}
