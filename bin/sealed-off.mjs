#!/usr/bin/env node
// Run a command with the sealed folder out of reach: it and everything it starts can neither read nor write it.
//   node bin/sealed-off.mjs [--sealed DIR] -- <command> [args…]      DIR defaults to $RAP_SEALED_DIR
//   node bin/sealed-off.mjs [--sealed DIR] --check                    the proof, with its control
// This is how the agent that makes changes is started. The sealed cases (and the approvals a person writes) live in
// DIR, outside the project; the checks runner is started without this wrapper and reads them.
// macOS only: it uses the system sandbox (sandbox-exec). The rule is enforced by the system, not by asking the agent;
// changing file permissions from inside does not lift it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function sealedDir(dir = process.env.RAP_SEALED_DIR) {
  if (!dir) throw Error('no sealed folder: set RAP_SEALED_DIR or pass --sealed DIR');
  return fs.realpathSync(dir);
}
/** The sandbox rule: everything allowed except reading or writing under the sealed folder. */
export const profile = dir => `(version 1)(allow default)(deny file-read* file-write* (subpath ${JSON.stringify(dir)}))`;
/** Start a command that cannot reach the sealed folder. */
export function sealedOff(dir, command, args = [], options = {}) {
  if (process.platform !== 'darwin') throw Error('sealed-off uses the macOS sandbox; on another system keep the sealed folder on another account or machine');
  return spawnSync('/usr/bin/sandbox-exec', ['-p', profile(sealedDir(dir)), command, ...args], { encoding: 'utf8', ...options });
}
/** The proof, with its control. Returns { ok, lines }. */
export function check(dir) {
  const real = sealedDir(dir);
  const file = fs.readdirSync(real).map(f => path.join(real, f)).find(f => fs.statSync(f).isFile());
  if (!file) throw Error(`${real} holds no file to try to read`);
  const probe = path.join(real, '.write-probe'), copy = path.join(fs.realpathSync('/tmp'), `sealed-copy-probe-${process.pid}`);
  const q = JSON.stringify;
  const tries = [
    ['read a sealed file', sealedOff(real, '/bin/cat', [file]).status !== 0],
    ['list the sealed folder', sealedOff(real, '/bin/ls', [real]).status !== 0],
    ['write into the sealed folder', sealedOff(real, '/bin/sh', ['-c', `echo x > ${q(probe)}`]).status !== 0 && !fs.existsSync(probe)],
    ['change its permissions, then read', sealedOff(real, '/bin/sh', ['-c', `chmod -R 777 ${q(real)}; cat ${q(file)}`]).stdout === ''],
    ['copy it out', sealedOff(real, '/bin/cp', [file, copy]).status !== 0 && !fs.existsSync(copy)],
  ];
  fs.rmSync(probe, { force: true }); fs.rmSync(copy, { force: true });
  const control = spawnSync('/bin/cat', [file], { encoding: 'utf8' });
  const controlOk = control.status === 0 && control.stdout.length > 0;
  const lines = tries.map(([what, refused]) => `${refused ? '✓ refused' : '✗ ALLOWED'}: ${what}`);
  lines.push(`${controlOk ? '✓' : '✗'} control: the same read without the wrapper ${controlOk ? 'succeeds' : 'fails, so the refusals above prove nothing'}`);
  return { ok: tries.every(t => t[1]) && controlOk, lines };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let dir; const i = args.indexOf('--sealed'); if (i >= 0) { dir = args[i + 1]; args.splice(i, 2); }
    if (args[0] === '--check') { const r = check(dir); console.log(r.lines.join('\n')); process.exit(r.ok ? 0 : 1); }
    const at = args.indexOf('--'); const cmd = at >= 0 ? args.slice(at + 1) : args;
    if (!cmd.length) throw Error('give a command after --');
    const r = sealedOff(dir, cmd[0], cmd.slice(1), { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  } catch (e) { console.error(`sealed-off: ${e.message}`); process.exit(2); }
}
