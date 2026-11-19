import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { houseRules, parseHouseRules } from '../src/domain/house-rules.ts';
import { createApp } from '../src/server.ts';
import { fixture } from './helpers.ts';

const home = 'lakeside-a-frame';

test('house documents keep each heading attached to its current text and revision', () => {
  const header = '# Test rules\n\nHome: lakeside-a-frame\nRevision: 2026-11-16\n\n';
  const { passages } = parseHouseRules(header + '## Pets\n\nTwo small dogs.\n\n## Check-out\n\n10 am.\n', home);
  assert.deepEqual(passages[0], { home, revision: '2026-11-16', heading: 'Pets', text: 'Two small dogs.', source: `/api/listings/${home}/house-rules?topic=pets` });
  assert.equal(parseHouseRules(header + '## Check-out\n\n10 am.', home).passages.some(p => p.heading === 'Pets'), false);
  assert.throws(() => parseHouseRules(header, 'another-home'), /metadata/);
  assert.throws(() => parseHouseRules(header + '## Pets\nFirst.\n## pets\nSecond.', home), /repeated/);
});

test('public house rules separate unknown homes, missing documents and missing topics', () => {
  const { db } = fixture();
  try {
    const all = houseRules(db, home, '');
    assert.equal(all.status, 'FOUND');
    assert.equal(all.passages.length, 7);
    assert.deepEqual(houseRules(db, home, ' PeTs ').passages, [all.passages[0]]);
    const absent = houseRules(db, home, 'unlisted topic');
    assert.equal(absent.status, 'TOPIC_NOT_FOUND');
    assert.deepEqual(absent.passages, []);
    assert.deepEqual(absent.listing.amenities, ['Wifi', 'Kitchen']);
    assert.equal(houseRules(db, 'fern-cottage', 'pets').status, 'NO_HOUSE_RULES');
    assert.throws(() => houseRules(db, '../../notes', ''), { code: 'HOME_NOT_FOUND' });
    db.prepare("UPDATE listings SET status = 'paused' WHERE slug = ?").run(home);
    assert.throws(() => houseRules(db, home, ''), { code: 'HOME_NOT_FOUND' });
  } finally { db.close(); }
});

test('a visitor can open a house-rule passage source on the read-only product route', async () => {
  const { db } = fixture();
  const { server } = createApp(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const rules = await fetch(`${base}/api/listings/${home}/house-rules`);
    assert.equal(rules.status, 200);
    const { passages } = await rules.json();
    const pets = passages.find((p: { heading: string }) => p.heading === 'Pets');
    const source = await fetch(new URL(pets.source, base));
    assert.equal(source.status, 200);
    assert.deepEqual((await source.json()).passages, [pets]);
    const unknown = await fetch(`${base}/api/listings/unknown-home/house-rules`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'HOME_NOT_FOUND');
    const contract = await (await fetch(`${base}/api/openapi.json`)).json();
    assert.ok(contract.paths['/api/listings/{slug}/house-rules'].get);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});
