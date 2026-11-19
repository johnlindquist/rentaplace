import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { decide, keep, restore, versionOf, approvalFile } from '../bin/two-keys.mjs';
import { sealedOff } from '../bin/sealed-off.mjs';

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function agent(root: string, glossary: string) {
  const dir = path.join(root, 'agents', 'booking'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.md'), '# Booking\n## Job\nAnswer.\n'); fs.writeFileSync(path.join(dir, 'memories.md'), '- a memory\n'); fs.writeFileSync(path.join(dir, 'glossary.md'), glossary);
  return root;
}
const live = () => agent(tmp('live-'), '- **Hold**: old\n');
const cand = () => agent(tmp('cand-'), '- **Hold**: new\n');
const passed = (version: string) => ({ version, everyday: { of: 5, failed: 0 }, sealed: { of: 6, failed: 0 } });
const glossary = (root: string) => fs.readFileSync(path.join(root, 'agents', 'booking', 'glossary.md'), 'utf8');

test('first refusal: the checks pass and nobody approved, so nothing is kept', () => {
  const root = live(), candidate = cand(), version = versionOf(candidate, 'booking');
  const r = keep({ root, name: 'booking', candidate, result: passed(version), approval: null, previous: tmp('prev-') });
  assert.equal(r.kept, false); assert.equal(r.checksPassed, true); assert.equal(r.approved, false);
  assert.deepEqual(r.reasons, ['no person has approved this version']);
  assert.equal(glossary(root), '- **Hold**: old\n');
});

test('second refusal: a person approved and a sealed case failed, so nothing is kept', () => {
  const root = live(), candidate = cand(), version = versionOf(candidate, 'booking');
  const r = keep({ root, name: 'booking', candidate, result: { ...passed(version), sealed: { of: 6, failed: 1 } }, approval: { version, by: 'John' }, previous: tmp('prev-') });
  assert.equal(r.kept, false); assert.equal(r.approved, true); assert.equal(r.checksPassed, false);
  assert.deepEqual(r.reasons, ['1 of 6 sealed cases failed']);
  assert.equal(glossary(root), '- **Hold**: old\n');
});

test('approval cannot push a version whose everyday checks failed, or one that was never run on the sealed cases', () => {
  const version = 'v1', approval = { version, by: 'John' };
  assert.equal(decide({ version, result: { version, everyday: { of: 5, failed: 2 }, sealed: { of: 6, failed: 0 } }, approval }).keep, false);
  assert.deepEqual(decide({ version, result: { version, everyday: { of: 5, failed: 0 }, sealed: null }, approval }).reasons, ['the sealed cases were not run']);
  assert.deepEqual(decide({ version, result: null, approval }).reasons, ['no recorded check run for this candidate']);
  assert.equal(decide({ version, result: { version, everyday: { of: 0, failed: 0 }, sealed: { of: 6, failed: 0 } }, approval }).keep, false, 'a run of no checks is not a pass');
});

test('both keys must be for exactly this version: an edit after the checks or after the approval is refused', () => {
  const root = live(), candidate = cand(), version = versionOf(candidate, 'booking');
  fs.appendFileSync(path.join(candidate, 'agents', 'booking', 'glossary.md'), '- **Extra**: slipped in afterwards\n');
  const r = keep({ root, name: 'booking', candidate, result: passed(version), approval: { version, by: 'John' }, previous: tmp('prev-') });
  assert.equal(r.kept, false); assert.equal(r.reasons.length, 2);
  assert.match(r.reasons[0], /the checks ran on version/); assert.match(r.reasons[1], /the approval names version/);
  assert.equal(decide({ version, result: passed(version), approval: { version, by: ' ' } }).keep, false, 'an approval by nobody is not an approval');
});

test('with both keys the version is kept, the previous one is saved, and it can be put back', () => {
  const root = live(), candidate = cand(), version = versionOf(candidate, 'booking'), previous = tmp('prev-'), before = versionOf(root, 'booking');
  const r = keep({ root, name: 'booking', candidate, result: passed(version), approval: { version, by: 'John' }, previous });
  assert.equal(r.kept, true); assert.equal(glossary(root), '- **Hold**: new\n'); assert.equal(versionOf(root, 'booking'), version);
  assert.equal('previousVersion' in r && r.previousVersion, before); assert.equal(glossary(previous), '- **Hold**: old\n');
  assert.equal(restore({ root, name: 'booking', previous }), before); assert.equal(glossary(root), '- **Hold**: old\n');
});

test('an agent started sealed-off cannot write its own approval or its own pass; outside the wrapper a person can', { skip: process.platform !== 'darwin' }, () => {
  const sealedDir = tmp('sealed-'), candidate = cand(), cli = path.resolve('bin/two-keys.mjs');
  fs.mkdirSync(path.join(sealedDir, 'results'));
  const env = { ...process.env, RAP_SEALED_DIR: sealedDir }, argv = [cli, 'approve', 'booking', candidate, '--by', 'An agent'];
  const inside = sealedOff(sealedDir, process.execPath, argv, { env });
  assert.notEqual(inside.status, 0);
  assert.equal(fs.existsSync(approvalFile(sealedDir, 'booking', versionOf(candidate, 'booking'))), false);
  assert.notEqual(sealedOff(sealedDir, '/bin/sh', ['-c', `echo '{}' > ${sealedDir}/results/forged.json`]).status, 0);
  assert.equal(fs.existsSync(path.join(sealedDir, 'results', 'forged.json')), false);
  const outside = spawnSync(process.execPath, argv, { env, encoding: 'utf8' }); // the control
  assert.equal(outside.status, 0, outside.stderr);
  assert.equal(fs.existsSync(approvalFile(sealedDir, 'booking', versionOf(candidate, 'booking'))), true);
});
