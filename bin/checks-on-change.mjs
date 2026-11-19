#!/usr/bin/env node
// Runs an agent's checks when its files change, without anyone asking. Started by the local Git hook
// (.githooks/post-commit after every commit, .githooks/post-merge after a pull or merge); can also be run by hand.
//   node bin/checks-on-change.mjs                 files changed by the last commit
//   node bin/checks-on-change.mjs --since REF     files changed since REF
//   node bin/checks-on-change.mjs --files a b …   these files
// An agent's files are its own folder (agents/<name>/) and every path listed in agents/<name>/owns.txt: the code it guards.
// For each agent whose files changed: its everyday checks (agents/<name>/expectations.md), then its sealed cases if
// $RAP_SEALED_DIR/<name>.md exists. A change to anything else runs nothing. The result is printed and kept in
// <git dir>/agent-checks/last.json. It does not undo the commit: it says loudly what failed.
// Turn it on in a clone:  git config core.hooksPath .githooks      (local to that clone; nothing here is about GitHub)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** owns.txt globs: * within a folder, ** across folders; a line ending in / owns the folder. */
export function matches(glob, file) {
  if (glob.trim().endsWith('/')) glob = `${glob.trim()}**`;
  const re = glob.trim().replace(/^\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`).test(file);
}
/** Which agents own any of these files: { name: [files] }. */
export function agentsFor(files, root) {
  const dir = path.join(root, 'agents'), out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!fs.existsSync(path.join(dir, name, 'expectations.md')) && !fs.existsSync(path.join(dir, name, 'agent.md'))) continue; // an agent whose expectations were deleted still runs, and fails
    const ownsFile = path.join(dir, name, 'owns.txt');
    const globs = fs.existsSync(ownsFile) ? fs.readFileSync(ownsFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) : [];
    const mine = files.filter(f => f.startsWith(`agents/${name}/`) || globs.some(g => matches(g, f)));
    if (mine.length) out[name] = mine;
  }
  return out;
}
/**
 * Run the checks for every agent that owns a changed file. `run(args)` starts the checks runner and returns its exit code.
 * @param {{ files: string[], root: string, sealedDir?: string, repeat?: number, run: (args: string[]) => number, log?: (line: string) => void }} o
 */
export function onChange({ files, root, sealedDir, repeat = 2, run, log = console.log }) {
  const owners = agentsFor(files, root), names = Object.keys(owners), runs = [];
  if (!names.length) { log(`checks-on-change: ${files.length} file(s) changed, none belongs to an agent. Nothing to run.`); return { ran: false, ok: true, runs }; }
  for (const name of names) {
    log(`checks-on-change: ${owners[name].join(', ')} belongs to ${name}. Running its checks; nobody asked.`);
    const everyday = run([name, '--repeat', String(repeat)]);
    runs.push({ agent: name, kind: 'everyday', exit: everyday });
    const sealed = sealedDir && path.join(sealedDir, `${name}.md`);
    if (!sealedDir) log('checks-on-change: no sealed folder is set (RAP_SEALED_DIR), so the sealed cases were NOT run.');
    if (sealed && fs.existsSync(sealed)) runs.push({ agent: name, kind: 'sealed', exit: run([name, '--cases', sealed, '--sealed', '--repeat', String(repeat)]) });
  }
  const ok = runs.every(r => r.exit === 0);
  log(ok ? 'checks-on-change: every check passed.' : `checks-on-change: FAILED: ${runs.filter(r => r.exit !== 0).map(r => `${r.agent} ${r.kind} (exit ${r.exit})`).join(', ')}. The commit stands; fix it or take it back.`);
  return { ran: true, ok, runs };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const git = (...a) => { const r = spawnSync('git', a, { encoding: 'utf8' }); if (r.status !== 0) throw Error(`git ${a.join(' ')}: ${r.stderr.trim()}`); return r.stdout.trim(); };
  try {
    const root = git('rev-parse', '--show-toplevel');
    const i = args.indexOf('--files'), s = args.indexOf('--since');
    let files;
    if (i >= 0) files = args.slice(i + 1);
    else if (s >= 0) files = git('diff', '--name-only', args[s + 1]).split('\n').filter(Boolean);
    else if (spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD^1']).status === 0) files = git('diff', '--name-only', 'HEAD^1', 'HEAD').split('\n').filter(Boolean); // also right for a merge commit
    else files = git('diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD').split('\n').filter(Boolean);
    const runner = process.env.AGENT_CHECKS_BIN || path.join(HERE, 'agent-checks.mjs');
    const run = a => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', runner, ...a], { cwd: root, stdio: 'inherit' }).status ?? 2;
    const result = onChange({ files, root, sealedDir: process.env.RAP_SEALED_DIR, repeat: Number(process.env.CHECKS_REPEAT || 2), run });
    const keep = path.join(path.resolve(root, git('rev-parse', '--git-dir')), 'agent-checks');
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(path.join(keep, 'last.json'), JSON.stringify({ at: new Date().toISOString(), commit: git('rev-parse', '--short', 'HEAD'), files, ...result }, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (e) { console.error(`checks-on-change: ${e.message}`); process.exit(2); }
}
