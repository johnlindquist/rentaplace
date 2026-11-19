import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { doorLimits, makeDoor, receipt, saveReceipt, spentOn } from '../desk/door.mjs';
import { createApp } from '../src/server.ts';
import { fixture } from './helpers.ts';

const limits = { maxMessageChars: 20, visitsPerMinute: 2, dailySpendUsd: 0.01 };
const clock = (start = Date.parse('2026-11-18T10:00:00Z')) => { let t = start; const now = () => t; now.add = (ms: number) => { t += ms; }; return now; };

test('a message over the size limit is turned away by name, and does not count as a visit', () => {
  const door = makeDoor({ limits, now: clock() });
  const r: any = door.admit({ visitor: 'guest:1', message: 'x'.repeat(21) });
  assert.deepEqual([r.ok, r.status, r.code], [false, 413, 'MESSAGE_TOO_LONG']);
  assert.equal(door.admit({ visitor: 'guest:1', message: 'short' }).ok, true);
  assert.equal(door.admit({ visitor: 'guest:1', message: 'short' }).ok, true);
});

test('one visitor is limited per minute; another visitor is not affected; the limit lifts as the minute passes', () => {
  const now = clock(), door = makeDoor({ limits, now });
  assert.equal(door.admit({ visitor: 'guest:1', message: 'a' }).ok, true); now.add(10000);
  assert.equal(door.admit({ visitor: 'guest:1', message: 'b' }).ok, true); now.add(10000);
  const third: any = door.admit({ visitor: 'guest:1', message: 'c' });
  assert.deepEqual([third.ok, third.status, third.code, third.retryAfterSeconds], [false, 429, 'TOO_MANY_VISITS', 40]);
  assert.equal(door.admit({ visitor: 'guest:2', message: 'c' }).ok, true, 'another visitor');
  assert.equal(door.admit({ visitor: 'address:10.0.0.9', message: 'c' }).ok, true, 'a visitor with no sign-in is counted by address');
  now.add(40000);
  assert.equal(door.admit({ visitor: 'guest:1', message: 'd' }).ok, true, 'the first visit is now over a minute old');
  now.add(1000);
  assert.equal(door.admit({ visitor: 'guest:1', message: 'e' }).ok, false, 'a refused visit did not buy extra room');
});

test('the desk closes for the day at its spending limit, for every visitor, and opens the next day', () => {
  const now = clock(), door = makeDoor({ limits, now });
  assert.equal(door.admit({ visitor: 'guest:1', message: 'a' }).ok, true); door.charge(0.004);
  assert.equal(door.admit({ visitor: 'guest:2', message: 'a' }).ok, true); door.charge(0.006);
  const closed: any = door.admit({ visitor: 'guest:3', message: 'a' });
  assert.deepEqual([closed.ok, closed.status, closed.code], [false, 503, 'DESK_CLOSED_FOR_TODAY']);
  now.add(24 * 3600 * 1000);
  assert.equal(door.spentToday(), 0);
  assert.equal(door.admit({ visitor: 'guest:3', message: 'a' }).ok, true);
});

test('a restart does not reopen a closed desk: today\'s spend is read back from the receipts', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'door-')), 'receipts.jsonl');
  assert.equal(spentOn(file, '2026-11-18'), 0, 'no file yet');
  saveReceipt(file, receipt({ at: '2026-11-17T23:59:00.000Z', visitor: 'guest:1', ms: 900, cost: 0.5 }));
  saveReceipt(file, receipt({ at: '2026-11-18T09:00:00.000Z', visitor: 'guest:1', ms: 900, cost: 0.006 }));
  fs.appendFileSync(file, 'not json\n');
  saveReceipt(file, receipt({ at: '2026-11-18T09:01:00.000Z', visitor: 'guest:2', ms: 0, turnedAway: 'TOO_MANY_VISITS' }));
  saveReceipt(file, receipt({ at: '2026-11-18T09:02:00.000Z', visitor: 'guest:2', ms: 900, cost: 0.005 }));
  assert.equal(Math.round(spentOn(file, '2026-11-18') * 1000), 11, "yesterday's half dollar is not counted");
  const door = makeDoor({ limits, now: clock(), spentToday: spentOn(file, '2026-11-18') });
  assert.equal((door.admit({ visitor: 'guest:9', message: 'a' }) as any).code, 'DESK_CLOSED_FOR_TODAY');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('a receipt says how long, how much of the prompt came from the cache, what it cost and whether the words matched the record', () => {
  const r = receipt({ at: '2026-11-18T09:00:00.000Z', visitor: 'guest:1', ms: 1234.6, usage: { input: 100, cacheRead: 800, cacheWrite: 100, output: 60 }, cost: 0.0012345678, model: 'm', tools: ['quote'], replyAgrees: true, held: 'HOLD-1' });
  assert.deepEqual(r, { at: '2026-11-18T09:00:00.000Z', visitor: 'guest:1', ms: 1235, model: 'm', promptTokens: 1000, cachedTokens: 800, cachedShare: 0.8, outputTokens: 60, costUsd: 0.001235, tools: ['quote'], held: 'HOLD-1', replyAgrees: true, turnedAway: null });
  assert.equal(receipt({ at: 'x', visitor: 'v', ms: 0, turnedAway: 'MESSAGE_TOO_LONG' }).cachedShare, 0, 'no prompt, no division by zero');
});

test('a limit set to something that is not a positive number is refused, not ignored', () => {
  process.env.RAP_DESK_DAILY_USD = 'lots';
  try { assert.throws(() => doorLimits(), /RAP_DESK_DAILY_USD must be a positive number/); } finally { delete process.env.RAP_DESK_DAILY_USD; }
  assert.deepEqual(doorLimits(), { maxMessageChars: 2000, visitsPerMinute: 10, dailySpendUsd: 2 });
});

test('HTTP: the desk turns an over-long message away as JSON with its code, before any model, and writes a receipt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'door-http-')), file = path.join(dir, 'receipts.jsonl');
  process.env.RAP_DESK_RECEIPTS = file; process.env.RAP_DESK_MAX_CHARS = '40'; process.env.PI_BIN = path.join(dir, 'no-model-here');
  const { db } = fixture(); const { server } = createApp(db); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/desk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(41) }) });
    const body: any = await res.json();
    assert.deepEqual([res.status, body.error.code], [413, 'MESSAGE_TOO_LONG']);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => [l.turnedAway, l.costUsd, l.visitor.startsWith('address:')]), [['MESSAGE_TOO_LONG', 0, true]]);
  } finally {
    await new Promise(r => server.close(r)); delete process.env.RAP_DESK_RECEIPTS; delete process.env.RAP_DESK_MAX_CHARS; delete process.env.PI_BIN; fs.rmSync(dir, { recursive: true, force: true });
  }
});
