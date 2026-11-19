import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposal, train, better } from '../bin/trainer.mjs';

const start = '# Booking glossary\n\n- **Hold**: keeps the dates.\n- **Pending**: waiting for the host.\n';
const draft = (hold: string) => '```\n# Booking glossary\n\n- **Hold**: ' + hold + '\n- **Pending**: waiting for the host.\n```';
const scoreOf = (cleared: number, cost = 0.1) => ({ checks: Array.from({ length: 5 }, (_, i) => ({ title: `check ${i + 1}`, passed: i < cleared ? 2 : 0, of: 2 })), cleared, passed: cleared * 2, cost });

test('a proposal must be one whole glossary: malformed ones are refused with a reason', () => {
  assert.equal(proposal(draft('keeps the nights and the price.'), start).text, '# Booking glossary\n\n- **Hold**: keeps the nights and the price.\n- **Pending**: waiting for the host.\n');
  assert.match(proposal('Here is my idea: make Hold longer.', start).error!, /one fenced block/);
  assert.match(proposal(draft('x') + '\n' + draft('y'), start).error!, /found 2/);
  assert.match(proposal('```\n- **Hold**: x\n- **Pending**: y\n```', start).error!, /heading/);
  assert.match(proposal('```\n# Booking glossary\n- **Hold**: keeps the nights and the price.\n```', start).error!, /dropped a term: pending/);
  assert.match(proposal('```\n# Booking glossary\n- **Hold**: x\n- **Pending**: y\nExpect (Booking): says the guest pays the quoted price\n```', start).error!, /check lines/);
  assert.match(proposal('```\n' + start + '```', start).error!, /same as the current/);
  assert.match(proposal(draft('x'.repeat(7000)), start).error!, /limit is 6000/);
});

test('better means more checks cleared, then more runs passed', () => {
  assert.ok(better({ cleared: 4, passed: 8 }, { cleared: 3, passed: 9 }));
  assert.ok(better({ cleared: 3, passed: 9 }, { cleared: 3, passed: 8 }));
  assert.equal(better({ cleared: 3, passed: 8 }, { cleared: 3, passed: 8 }), false);
});

test('it stops when a draft clears every everyday check, runs the sealed cases once, and the Trainer never sees them', async () => {
  const scores = [scoreOf(3), scoreOf(4), scoreOf(5)], seen: unknown[] = []; let sealedRuns = 0, proposals = 0;
  const r = await train({ start, rounds: 3, budget: 5, score: async () => scores.shift()!, propose: async (state: unknown) => { seen.push(state); return { reply: draft(`draft ${++proposals}`), cost: 0.01 }; }, sealed: async () => { sealedRuns++; return { of: 6, failed: 1, cost: 0.1 }; } });
  assert.equal(r.stopped, 'round 2 cleared every everyday check');
  assert.equal(proposals, 2); assert.equal(sealedRuns, 1);
  assert.deepEqual(r.start, { of: 5, failed: 2 }); assert.deepEqual(r.everyday, { of: 5, failed: 0 }); assert.deepEqual(r.sealed, { of: 6, failed: 1 });
  assert.equal(r.bestRound, 2); assert.match(r.glossary, /draft 2/);
  assert.equal(JSON.stringify(seen).includes('sealed'), false, 'nothing about the sealed cases reaches the Trainer');
  assert.deepEqual(Object.keys(seen[0] as object).sort(), ['checks', 'glossary', 'round', 'rounds']);
});

test('the cap on rounds is hard: three rounds, never a fourth, and the best draft is the one that scored best', async () => {
  const scores = [scoreOf(2), scoreOf(4), scoreOf(3), scoreOf(3)]; let proposals = 0, sealedOn = '';
  const r = await train({ start, rounds: 3, budget: 5, score: async () => scores.shift()!, propose: async () => ({ reply: draft(`draft ${++proposals}`), cost: 0 }), sealed: async (g: string) => { sealedOn = g; return { of: 6, failed: 0, cost: 0 }; } });
  assert.equal(proposals, 3); assert.equal(r.stopped, 'out of rounds (3)'); assert.equal(r.bestRound, 1); assert.match(sealedOn, /draft 1/);
});

test('the cap on spend is hard: once it is reached nothing more is proposed or scored', async () => {
  let proposals = 0, scored = 0;
  const r = await train({ start, rounds: 10, budget: 0.25, score: async () => { scored++; return scoreOf(2, 0.1); }, propose: async () => ({ reply: draft(`draft ${++proposals}`), cost: 0.02 }), sealed: async () => ({ of: 6, failed: 0, cost: 0 }) });
  assert.match(r.stopped, /spend cap reached/);
  assert.equal(scored, 2, 'the start and one draft'); assert.equal(proposals, 2);
  assert.equal(r.history.at(-1)!.what, 'not scored');
});

test('a malformed proposal is rejected before scoring and uses up its round; with no better draft the sealed cases are not run', async () => {
  let scored = 0, sealedRuns = 0;
  const r = await train({ start, rounds: 2, budget: 5, score: async () => { scored++; return scoreOf(2); }, propose: async () => ({ reply: 'I think the checks are wrong.', cost: 0 }), sealed: async () => { sealedRuns++; return { of: 6, failed: 0, cost: 0 }; } });
  assert.equal(scored, 1); assert.equal(sealedRuns, 0); assert.equal(r.improved, false); assert.equal(r.sealed, null);
  assert.deepEqual(r.history.slice(1).map(h => h.what), ['rejected before scoring', 'rejected before scoring']);
});

test('a start that already clears everything is left alone', async () => {
  let proposals = 0;
  const r = await train({ start, score: async () => scoreOf(5), propose: async () => { proposals++; return { reply: '', cost: 0 }; }, sealed: async () => ({ of: 6, failed: 0, cost: 0 }) });
  assert.equal(proposals, 0); assert.equal(r.improved, false);
});

test('the sealed run counts toward the spend cap: if it would cross the cap it is not run, and the draft then cannot pass', async () => {
  const scores = [scoreOf(2, 0.1), scoreOf(5, 0.1)]; let sealedRuns = 0;
  const r = await train({ start, rounds: 3, budget: 0.25, score: async () => scores.shift()!, propose: async () => ({ reply: draft('better'), cost: 0.01 }), sealed: async () => { sealedRuns++; return { of: 6, failed: 0, cost: 0.1 }; } });
  assert.equal(sealedRuns, 0); assert.equal(r.sealed, null); assert.equal(r.improved, true);
  assert.match(r.stopped, /the sealed cases were not run: spend cap reached/);
  assert.ok(r.spent <= 0.25);
});

test('caps that are not real numbers are refused, so a cap can never be switched off by a bad value', async () => {
  const run = (o: object) => train({ start, score: async () => scoreOf(2), propose: async () => ({ reply: draft('x'), cost: 0 }), sealed: async () => ({ of: 6, failed: 0, cost: 0 }), ...o });
  await assert.rejects(run({ budget: NaN }), /budget must be/);
  await assert.rejects(run({ budget: 0 }), /budget must be/);
  await assert.rejects(run({ rounds: NaN }), /rounds must be/);
  await assert.rejects(run({ rounds: 2.5 }), /rounds must be/);
});
