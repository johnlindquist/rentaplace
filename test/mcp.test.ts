// The MCP endpoint, spoken to by the official SDK's own client over real HTTP. No model is asked anything here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/server.ts';
import { makeSession } from '../src/auth.ts';
import { quote } from '../src/domain/bookings.ts';
import { requestKey } from '../desk/request-key.mjs';
import { fixture, guest, otherGuest } from './helpers.ts';

const stay = { slug: 'lakeside-a-frame', from: '2026-11-16', to: '2026-11-19', guests: 2 };
const signIn = (id: string) => ({ cookie: `rap_session=${makeSession(id)}` });

/** A running app on a free port and a way to connect the SDK client to it, with or without a guest's sign-in. */
async function site(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  const set = { RAP_DESK_RECEIPTS: path.join(dir, 'receipts.jsonl'), PI_BIN: path.join(dir, 'no-model-here'), ...env };
  for (const [k, v] of Object.entries(set)) process.env[k] = v;
  const { db } = fixture(); const { server } = createApp(db); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`, clients: Client[] = [];
  // Pinned to the 2026-07-28 revision (no fallback), unless a test asks for the 2025 handshake that older clients still open with.
  const connect = async (headers: Record<string, string> = {}, legacy = false) => {
    const client = new Client({ name: 'test-visitor', version: '1.0.0' }, legacy ? {} : { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    clients.push(client); return client;
  };
  const close = async () => { for (const c of clients) await c.close(); await new Promise(r => server.close(r)); for (const k of Object.keys(set)) delete process.env[k]; fs.rmSync(dir, { recursive: true, force: true }); };
  return { db, url, connect, close, receipts: set.RAP_DESK_RECEIPTS };
}
const body = (result: any) => JSON.parse(result.content[0].text);

test('MCP: the endpoint lists exactly four tools, none for money, reserving, cancelling or releasing, and says truthfully which only read', async () => {
  const s = await site();
  try {
    const { tools } = await (await s.connect()).listTools();
    assert.deepEqual(tools.map(t => t.name), ['quote', 'house_rules', 'place_hold', 'ask_desk']);
    const hint = Object.fromEntries(tools.map(t => [t.name, t.annotations]));
    assert.deepEqual([hint.quote?.readOnlyHint, hint.house_rules?.readOnlyHint, hint.place_hold?.readOnlyHint, hint.ask_desk?.readOnlyHint], [true, true, false, false]);
    assert.deepEqual(tools.map(t => t.annotations?.destructiveHint), [false, false, false, false]);
    assert.equal(hint.place_hold?.idempotentHint, true);
    assert.deepEqual((tools[2].inputSchema as any).required, ['slug', 'from', 'to', 'guests'], 'the caller cannot send a request key');
    assert.equal('requestKey' in (tools[2].inputSchema as any).properties, false);
  } finally { await s.close(); }
});

test('MCP: the same endpoint serves the 2026-07-28 revision and, statelessly, a client that still opens with the 2025 handshake', async () => {
  const s = await site();
  try {
    const modern = await s.connect(signIn(guest.id)), older = await s.connect(signIn(guest.id), true);
    assert.deepEqual([modern.getProtocolEra(), modern.getNegotiatedProtocolVersion()], ['modern', '2026-07-28']);
    assert.deepEqual([older.getProtocolEra(), older.getNegotiatedProtocolVersion()], ['legacy', '2025-11-25']);
    const a: any = await modern.callTool({ name: 'place_hold', arguments: stay }), b: any = await older.callTool({ name: 'place_hold', arguments: stay });
    assert.deepEqual([body(b).hold.reference, body(b).sameRequestAsBefore], [body(a).hold.reference, true], 'one hold, whichever revision asked');
  } finally { await s.close(); }
});

test('MCP: quote returns the product\'s own price, with or without a sign-in', async () => {
  const s = await site();
  try {
    const expected = quote(s.db, stay.slug, stay.from, stay.to, stay.guests);
    const r: any = await (await s.connect()).callTool({ name: 'quote', arguments: stay });
    assert.equal(r.isError, undefined);
    assert.deepEqual(body(r), JSON.parse(JSON.stringify(expected)));
    assert.equal(r.structuredContent.totalCents, expected.totalCents);
    const bad: any = await (await s.connect()).callTool({ name: 'quote', arguments: { ...stay, slug: 'no-such-home' } });
    assert.deepEqual([bad.isError, body(bad).error.code], [true, 'NOT_FOUND']);
  } finally { await s.close(); }
});

test('MCP: place_hold twice with the same input is one hold and the same reference; the key is the desk\'s key, made in code', async () => {
  const s = await site();
  try {
    const quoted = quote(s.db, stay.slug, stay.from, stay.to, stay.guests).totalCents;
    const client = await s.connect(signIn(guest.id));
    const first: any = await client.callTool({ name: 'place_hold', arguments: stay }), second: any = await client.callTool({ name: 'place_hold', arguments: stay });
    assert.equal(first.isError, undefined);
    assert.match(body(first).hold.reference, /^HOLD-[0-9A-F]{8}$/);
    assert.deepEqual([body(first).sameRequestAsBefore, body(second).sameRequestAsBefore], [false, true]);
    assert.equal(body(second).hold.reference, body(first).hold.reference);
    const rows: any[] = s.db.prepare('SELECT reference,guest_id,total_cents,request_key FROM holds').all();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].reference, rows[0].guest_id, rows[0].total_cents], [body(first).hold.reference, guest.id, body(first).hold.totalCents]);
    assert.equal(rows[0].request_key, requestKey(guest.id, stay), 'the same key the desk would make for this request');
    assert.equal(body(first).hold.totalCents, quoted, 'the hold keeps the quoted price');
    // The product's rules still apply: another guest cannot hold nights that are held.
    const other: any = await (await s.connect(signIn(otherGuest.id))).callTool({ name: 'place_hold', arguments: stay });
    assert.deepEqual([other.isError, body(other).error.code], [true, 'DATES_UNAVAILABLE']);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM bookings').get()!.n, 0, 'no reservation, no money');
  } finally { await s.close(); }
});

test('MCP: with no sign-in, place_hold is refused by name and nothing is saved', async () => {
  const s = await site();
  try {
    const r: any = await (await s.connect()).callTool({ name: 'place_hold', arguments: stay });
    assert.deepEqual([r.isError, body(r).error.code, r.structuredContent.error.code], [true, 'SIGN_IN_REQUIRED', 'SIGN_IN_REQUIRED']);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM holds').get()!.n, 0);
  } finally { await s.close(); }
});

test('MCP: the door\'s rate limit applies to every tool call, per visitor, and the refusal is a tool error with the door\'s code', async () => {
  const s = await site({ RAP_DESK_VISITS_PER_MINUTE: '2' });
  try {
    const mira = await s.connect(signIn(guest.id));
    assert.equal(((await mira.callTool({ name: 'quote', arguments: stay })) as any).isError, undefined);
    assert.equal(((await mira.callTool({ name: 'house_rules', arguments: { home: stay.slug, topic: 'pets' } })) as any).isError, undefined);
    const third: any = await mira.callTool({ name: 'place_hold', arguments: stay });
    assert.deepEqual([third.isError, body(third).error.code], [true, 'TOO_MANY_VISITS']);
    assert.ok(body(third).error.retryAfterSeconds >= 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM holds').get()!.n, 0, 'a refused call did nothing');
    const ask: any = await mira.callTool({ name: 'ask_desk', arguments: { message: 'What is a hold?' } });
    assert.equal(body(ask).error.code, 'TOO_MANY_VISITS', 'the desk tool is on the same count, and no model was asked');
    assert.equal(((await mira.listTools()).tools.length), 4, 'listing the tools is not a visit');
    const ellis: any = await (await s.connect(signIn(otherGuest.id))).callTool({ name: 'quote', arguments: stay });
    assert.equal(ellis.isError, undefined, 'another visitor is not affected');
    const lines = fs.readFileSync(s.receipts, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => [l.visitor, l.turnedAway, l.costUsd, l.tools]), [['guest:guest-1', 'TOO_MANY_VISITS', 0, ['place_hold']], ['guest:guest-1', 'TOO_MANY_VISITS', 0, []]]);
  } finally { await s.close(); }
});

test('MCP: ask_desk passes the door\'s size limit before any model, as POST /desk does', async () => {
  const s = await site({ RAP_DESK_MAX_CHARS: '40' });
  try {
    const r: any = await (await s.connect()).callTool({ name: 'ask_desk', arguments: { message: 'x'.repeat(41) } });
    assert.deepEqual([r.isError, body(r).error.code], [true, 'MESSAGE_TOO_LONG']);
    const lines = fs.readFileSync(s.receipts, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => [l.turnedAway, l.costUsd]), [['MESSAGE_TOO_LONG', 0]]);
  } finally { await s.close(); }
});

test('MCP: when the desk is closed for the day, ask_desk is refused by name and the typed tools still answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-closed-')), file = path.join(dir, 'receipts.jsonl');
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), visitor: 'guest:x', costUsd: 5 }) + '\n');
  const s = await site({ RAP_DESK_RECEIPTS: file });
  try {
    const client = await s.connect(signIn(guest.id));
    const ask: any = await client.callTool({ name: 'ask_desk', arguments: { message: 'What is a hold?' } });
    assert.deepEqual([ask.isError, body(ask).error.code], [true, 'DESK_CLOSED_FOR_TODAY']);
    assert.equal(((await client.callTool({ name: 'quote', arguments: stay })) as any).isError, undefined);
    assert.equal(((await client.callTool({ name: 'place_hold', arguments: stay })) as any).isError, undefined);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MCP: RAP_MCP=off removes the endpoint; RAP_DESK=off removes only ask_desk', async () => {
  const off = await site({ RAP_MCP: 'off' });
  try {
    const res = await fetch(off.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.deepEqual([res.status, (await res.json() as any).error.code], [404, 'NOT_FOUND']);
    await assert.rejects(off.connect());
  } finally { await off.close(); }
  const noDesk = await site({ RAP_DESK: 'off' });
  try { assert.deepEqual((await (await noDesk.connect()).listTools()).tools.map(t => t.name), ['quote', 'house_rules', 'place_hold']); } finally { await noDesk.close(); }
});
