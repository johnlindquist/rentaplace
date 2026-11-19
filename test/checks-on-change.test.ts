import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentsFor, matches, onChange } from '../bin/checks-on-change.mjs';

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'on-change-'));
  const put = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); };
  put('agents/booking/expectations.md', '# x'); put('agents/booking/owns.txt', '# code it guards\nsrc/domain/bookings.ts\ndesk/**\n');
  put('agents/pricing/expectations.md', '# x'); put('agents/pricing/owns.txt', 'src/domain/pricing.ts\n');
  put('agents/notes/readme.md', 'no expectations here');
  return root;
}
const quiet = () => {};

test('owns.txt patterns: a path, * inside a folder, ** across folders, a folder', () => {
  assert.ok(matches('src/domain/bookings.ts', 'src/domain/bookings.ts'));
  assert.equal(matches('src/domain/bookings.ts', 'src/domain/bookings.tsx'), false);
  assert.ok(matches('desk/**', 'desk/tools/desk.ts'));
  assert.ok(matches('desk/', 'desk/desk.mjs'));
  assert.ok(matches('test/*.test.ts', 'test/holds.test.ts'));
  assert.equal(matches('test/*.test.ts', 'test/deep/holds.test.ts'), false);
  assert.equal(matches('desk/**', 'src/desk/x.ts'), false);
});

test('a change to an agent\'s folder or to the code it guards picks that agent, and only that agent', () => {
  const root = project();
  assert.deepEqual(agentsFor(['agents/booking/glossary.md'], root), { booking: ['agents/booking/glossary.md'] });
  assert.deepEqual(agentsFor(['src/domain/bookings.ts', 'README.md'], root), { booking: ['src/domain/bookings.ts'] });
  assert.deepEqual(agentsFor(['desk/desk.mjs'], root), { booking: ['desk/desk.mjs'] });
  assert.deepEqual(Object.keys(agentsFor(['src/domain/pricing.ts', 'desk/desk.mjs'], root)), ['booking', 'pricing']);
});

test('control: a change elsewhere runs nothing', () => {
  const root = project(); const started: string[][] = [];
  const r = onChange({ files: ['README.md', 'src/server.ts', 'agents/notes/readme.md'], root, run: (a: string[]) => { started.push(a); return 0; }, log: quiet });
  assert.deepEqual(started, []);
  assert.deepEqual(r, { ran: false, ok: true, runs: [] });
});

test('an owned change runs the everyday checks, then the sealed cases when the sealed folder has them', () => {
  const root = project(); const sealedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-')); fs.writeFileSync(path.join(sealedDir, 'booking.md'), '# sealed');
  const started: string[][] = [];
  const r = onChange({ files: ['agents/booking/glossary.md'], root, sealedDir, repeat: 3, run: (a: string[]) => { started.push(a); return 0; }, log: quiet });
  assert.deepEqual(started, [['booking', '--repeat', '3'], ['booking', '--cases', path.join(sealedDir, 'booking.md'), '--sealed', '--repeat', '3']]);
  assert.equal(r.ok, true);
  // pricing has no sealed file: everyday only
  started.length = 0;
  onChange({ files: ['src/domain/pricing.ts'], root, sealedDir, run: (a: string[]) => { started.push(a); return 0; }, log: quiet });
  assert.deepEqual(started, [['pricing', '--repeat', '2']]);
});

test('an agent whose expectations were deleted is still picked, and no sealed folder is said aloud', () => {
  const root = project(); fs.rmSync(path.join(root, 'agents/booking/expectations.md')); fs.writeFileSync(path.join(root, 'agents/booking/agent.md'), '# Booking');
  assert.deepEqual(Object.keys(agentsFor(['agents/booking/glossary.md'], root)), ['booking']);
  const said: string[] = [];
  onChange({ files: ['agents/booking/glossary.md'], root, run: () => 2, log: (l: string) => said.push(l) });
  assert.ok(said.some(l => /sealed cases were NOT run/.test(l)));
  assert.match(said.at(-1)!, /FAILED: booking everyday \(exit 2\)/);
});

test('a failing check makes the whole run fail and names what failed', () => {
  const root = project(); const said: string[] = [];
  const r = onChange({ files: ['desk/desk.mjs'], root, run: () => 1, log: (l: string) => said.push(l) });
  assert.equal(r.ok, false);
  assert.match(said.at(-1)!, /FAILED: booking everyday \(exit 1\)/);
});
