#!/usr/bin/env node
// Two keys: a changed agent is kept only when (1) the checks passed on exactly this version, everyday and sealed,
// and (2) a person approved exactly this version. Either key alone is refused, and the version kept before is saved
// so it can be put back.
//   node bin/two-keys.mjs check   <agent> <candidate dir> --run ID       run the everyday checks and the sealed cases on it, once, and record the result
//   node bin/two-keys.mjs status  <agent> <candidate dir> --run ID       what is missing
//   node bin/two-keys.mjs approve <agent> <candidate dir> --by "Name"    a person's yes, for this exact version
//   node bin/two-keys.mjs keep    <agent> <candidate dir> --run ID       keep it, if both keys are there
//   node bin/two-keys.mjs restore <agent> --run ID                       put the previous version back
// The recorded results ($RAP_SEALED_DIR/results/<run>.json) and the approvals ($RAP_SEALED_DIR/approvals/) live in
// the sealed folder: an agent started with bin/sealed-off.mjs can neither read nor write them, so it cannot write
// its own pass or its own approval. A candidate dir holds agents/<agent>/ like the project does.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FILES = ['agent.md', 'glossary.md', 'memories.md', 'desk.md'];
const agentDir = (root, name) => path.join(root, 'agents', name);

/** The version: one hash over the agent's knowledge files. Any edit after scoring or approval gives another version. */
export function versionOf(root, name) {
  const h = createHash('sha256');
  for (const f of FILES) { const file = path.join(agentDir(root, name), f); h.update(`${f}\n`); if (fs.existsSync(file)) h.update(fs.readFileSync(file)); h.update('\n--\n'); }
  return h.digest('hex').slice(0, 16);
}
const clean = part => !!part && part.of > 0 && part.failed === 0;
/**
 * The rule. `result` is what the runner recorded ({ version, everyday: { of, failed }, sealed: { of, failed } });
 * `approval` is a person's yes ({ version, by }). Returns { keep, checksPassed, approved, reasons }.
 */
export function decide({ version, result, approval }) {
  const reasons = [];
  let checksPassed = false, approved = false;
  if (!result) reasons.push('no recorded check run for this candidate');
  else if (result.version !== version) reasons.push(`the checks ran on version ${result.version}, not on this version ${version}`);
  else if (!clean(result.everyday)) reasons.push(result.everyday ? `${result.everyday.failed} of ${result.everyday.of} everyday checks failed` : 'the everyday checks were not run');
  else if (!clean(result.sealed)) reasons.push(result.sealed ? `${result.sealed.failed} of ${result.sealed.of} sealed cases failed` : 'the sealed cases were not run');
  else checksPassed = true;
  if (!approval) reasons.push('no person has approved this version');
  else if (approval.version !== version) reasons.push(`the approval names version ${approval.version}, not this version ${version}`);
  else if (!String(approval.by || '').trim()) reasons.push('the approval does not say who approved');
  else approved = true;
  return { keep: checksPassed && approved, checksPassed, approved, reasons };
}
/** Keep the candidate as the live agent if both keys are there; otherwise change nothing. The previous version goes to `previous`. */
export function keep({ root, name, candidate, result, approval, previous }) {
  const version = versionOf(candidate, name);
  const d = decide({ version, result, approval });
  if (!d.keep) return { kept: false, version, ...d };
  fs.mkdirSync(path.join(previous, 'agents'), { recursive: true });
  fs.cpSync(agentDir(root, name), agentDir(previous, name), { recursive: true });
  for (const f of FILES) { const from = path.join(agentDir(candidate, name), f); if (fs.existsSync(from)) fs.copyFileSync(from, path.join(agentDir(root, name), f)); }
  return { kept: true, version, previousVersion: versionOf(previous, name), previous, ...d };
}
/** Put the previous version back. */
export function restore({ root, name, previous }) {
  if (!fs.existsSync(agentDir(previous, name))) throw Error(`no previous version kept in ${previous}`);
  for (const f of FILES) { const from = path.join(agentDir(previous, name), f); if (fs.existsSync(from)) fs.copyFileSync(from, path.join(agentDir(root, name), f)); }
  return versionOf(root, name);
}
const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
export const approvalFile = (sealedDir, name, version) => path.join(sealedDir, 'approvals', `${name}-${version}.json`);
export const resultFile = (sealedDir, run) => path.join(sealedDir, 'results', `${run}.json`);

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const flag = n => { const i = args.indexOf(`--${n}`); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
    const run = flag('run'), by = flag('by'), root = path.resolve(flag('project') || process.cwd());
    const sealedDir = process.env.RAP_SEALED_DIR; if (!sealedDir) throw Error('set RAP_SEALED_DIR (the sealed folder holds results and approvals)');
    const [verb, name, candidateArg] = args;
    if (!verb || !name) throw Error('usage: two-keys.mjs check|status|approve|keep|restore <agent> [candidate dir] [--run ID] [--by Name]');
    const previous = run && path.join(sealedDir, 'previous', run);
    if (verb === 'restore') { if (!run) throw Error('give --run ID'); console.log(`Put back version ${restore({ root, name, previous })} of ${name}.`); process.exit(0); }
    const candidate = path.resolve(candidateArg || ''); if (!candidateArg || !fs.existsSync(agentDir(candidate, name))) throw Error(`no agents/${name}/ in the candidate dir`);
    const version = versionOf(candidate, name);
    if (verb === 'approve') {
      if (!String(by || '').trim()) throw Error('say who approves: --by "Name"');
      const file = approvalFile(sealedDir, name, version); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ agent: name, version, by, at: new Date().toISOString() }, null, 2));
      console.log(`${by} approved ${name} version ${version}.`); process.exit(0);
    }
    if (!run) throw Error('give --run ID (the recorded check run)');
    if (verb === 'check') {
      const record = resultFile(sealedDir, run); if (fs.existsSync(record)) throw Error(`run ${run} already has a recorded result; the sealed cases are run once per run`);
      const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-checks.mjs'), repeat = process.env.CHECKS_REPEAT || '3';
      const one = (extra, file) => { const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', runner, name, '--project', candidate, '--repeat', repeat, '--json', file, ...extra], { stdio: ['ignore', 'inherit', 'inherit'] }); if (r.status === 2 || !fs.existsSync(file)) throw Error('the checks run broke'); const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { of: j.cases, failed: j.failed }; };
      fs.mkdirSync(path.dirname(record), { recursive: true });
      // The everyday checks are the live project's, not the candidate's own copy: a candidate cannot pass by bringing easier checks.
      const everyday = one(['--cases', path.join(agentDir(root, name), 'expectations.md')], path.join(sealedDir, 'results', `${run}-everyday-detail.json`));
      const sealed = one(['--cases', path.join(sealedDir, `${name}.md`), '--sealed'], path.join(sealedDir, 'results', `${run}-sealed-detail.json`));
      fs.writeFileSync(record, JSON.stringify({ run, agent: name, version, at: new Date().toISOString(), everyday, sealed }, null, 2));
      console.log(`Recorded for ${name} version ${version}: everyday ${everyday.of - everyday.failed} of ${everyday.of} cleared, sealed ${sealed.of - sealed.failed} of ${sealed.of} cleared.`); process.exit(everyday.failed || sealed.failed ? 1 : 0);
    }
    const result = readJson(resultFile(sealedDir, run)), approval = readJson(approvalFile(sealedDir, name, version));
    if (verb === 'status') { const d = decide({ version, result, approval }); console.log(`${name} version ${version}: checks ${d.checksPassed ? 'passed' : 'NOT passed'} · person ${d.approved ? `approved (${approval.by})` : 'has NOT approved'}${d.reasons.length ? `\n  ${d.reasons.join('\n  ')}` : ''}\n${d.keep ? 'Both keys are there: it can be kept.' : 'It cannot be kept.'}`); process.exit(d.keep ? 0 : 1); }
    if (verb === 'keep') {
      const r = keep({ root, name, candidate, result, approval, previous });
      console.log(r.kept ? `Kept ${name} version ${r.version}. The previous version (${r.previousVersion}) is saved; put it back with: two-keys.mjs restore ${name} --run ${run}` : `REFUSED: ${name} version ${r.version} is not kept. Nothing changed.\n  ${r.reasons.join('\n  ')}`);
      process.exit(r.kept ? 0 : 1);
    }
    throw Error(`unknown verb ${verb}`);
  } catch (e) { console.error(`two-keys: ${e.message}`); process.exit(2); }
}
