import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { check, profile, sealedOff } from '../bin/sealed-off.mjs';

const mac = process.platform === 'darwin';
const sealed = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-'))); fs.writeFileSync(path.join(d, 'cases.md'), 'SECRET-CASE\n'); return d; };

test('the sealed-off rule denies reading and writing under the sealed folder only', () => {
  assert.equal(profile('/x/sealed'), '(version 1)(allow default)(deny file-read* file-write* (subpath "/x/sealed"))');
});

test('a command started sealed-off cannot read, list, write, re-permission or copy the sealed folder; outside the wrapper it can', { skip: !mac }, () => {
  const d = sealed();
  const r = check(d);
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.equal(r.lines.length, 6);
  const inside = sealedOff(d, '/bin/cat', [path.join(d, 'cases.md')]);
  assert.notEqual(inside.status, 0);
  assert.equal(inside.stdout.includes('SECRET-CASE'), false);
  assert.equal(spawnSync('/bin/cat', [path.join(d, 'cases.md')], { encoding: 'utf8' }).stdout, 'SECRET-CASE\n'); // the control
  // everything else stays reachable, so the wrapper is not passing by breaking the command
  assert.equal(sealedOff(d, '/bin/cat', [path.resolve('package.json')]).status, 0);
});

test('the proof fails when there is nothing sealed to refuse', { skip: !mac }, () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-empty-')));
  assert.throws(() => check(d), /holds no file/);
});
