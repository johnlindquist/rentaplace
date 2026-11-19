#!/usr/bin/env node
// Visitors from outside: each is Pi in print mode on a small model with ONE tool (HTTP to this site only) and a goal.
//   node desk/visitors.mjs <out-dir> <site> <db-file> <path: site|guide|desk|mcp> [count=3]
// On the mcp path the visitor has no HTTP tool: Pi's own MCP client connects to <site>/mcp (VISITOR_MCP_HOME is a Pi agent directory whose
// mcp.json names the server and sends ${VISITOR_COOKIE}), and the visitor's only tools are the ones that server lists.
// The visitor carries a guest's own sign-in. Scored from the record, not from what the visitor says:
// right price in its answer, hold rows saved for its stay, reservations made, guide read, desk used, money tables unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SMALL_MODEL } from '../models.mjs';

const [outArg, site, dbArg, route, count = '3'] = process.argv.slice(2);
const out = path.resolve(outArg), dbFile = path.resolve(dbArg);
const MODEL = process.env.VISITOR_MODEL || SMALL_MODEL;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAYS = [['2026-11-16', '2026-11-19'], ['2026-11-30', '2026-12-03'], ['2026-12-14', '2026-12-17'], ['2026-11-10', '2026-11-13']];
const GUEST = process.env.VISITOR_GUEST || 'guest-1';
fs.mkdirSync(out, { recursive: true });

export function money(db) { return createHash('sha256').update(JSON.stringify(['bookings', 'payouts', 'email_outbox'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))).digest('hex'); }
const read = () => new DatabaseSync(dbFile, { readOnly: true });

async function cookie() {
  const r = await fetch(`${site}/api/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: GUEST }) });
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], name: (await r.json()).user.name };
}
function visitor(i, sign, [from, to]) {
  const log = path.join(out, `visitor-${i}.requests.jsonl`);
  fs.rmSync(log, { force: true });
  const goal = `You are an agent acting for ${sign.name}, a guest of the vacation rental site at ${site}. Your requests to the site already carry her sign-in.\n` +
    `Her goal: put a three-night stay at Lakeside A-Frame, check-in ${from}, check-out ${to}, for two guests, on hold for her. A hold only: do not reserve it and do not pay for anything.\n` +
    (route === 'site' ? '' : route === 'mcp' ? 'The site gives agents typed tools; they are already connected for you.\n' : 'The site publishes a guide for agents at /llms.txt.\n') +
    (process.env.VISITOR_GOAL ? process.env.VISITOR_GOAL + '\n' : '') +
    `Work it out from the site itself. When you are finished, answer in three lines:\nTOTAL PRICE: <the total she would pay, or unknown>\nHOLD: <placed, with its reference and when it runs out; or not placed>\nWHY: <one sentence>`;
  return new Promise(resolve => {
    const mcp = route === 'mcp';
    // Pi's MCP support is a built-in extension: -ne would remove it (the visitor then has no tools at all), so the mcp path leaves it out.
    const argv = ['-p', '--mode', 'json', '--no-session', ...(mcp ? [] : ['-ne']), '-ns', '-np', '-nc', ...(mcp ? ['--tools', 'mcp__rentaplace__*'] : ['--no-mcp', '-e', path.join(HERE, 'tools', 'visitor.ts'), '--tools', 'http_request']), '--thinking', 'off', '--model', MODEL, '--system-prompt', `You are a careful software agent working for one person. You can only use ${mcp ? 'the tools you were given' : 'the http_request tool'}. Make at most 15 requests.`, goal];
    const began = Date.now();
    const child = spawn(process.env.PI_BIN || 'pi', argv, { cwd: os.tmpdir(), env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', VISITOR_SITE: site, VISITOR_COOKIE: sign.cookie, VISITOR_LOG: log, ...(mcp ? { PI_CODING_AGENT_DIR: process.env.VISITOR_MCP_HOME } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', err = '';
    child.stdout.on('data', d => o += d); child.stderr.on('data', d => err += d);
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.on('close', () => {
      clearTimeout(timer);
      let text = '', used = '', cost = 0; const toolCalls = [], ms = Date.now() - began;
      for (const line of o.split('\n')) { let e; try { e = JSON.parse(line); } catch { continue; } if (e.type === 'message_end' && e.message?.role === 'assistant') { for (const c of e.message.content || []) if (c.type === 'toolCall') toolCalls.push({ tool: c.name, input: c.arguments }); const t = (e.message.content || []).filter(c => c.type === 'text').map(c => c.text).join(''); if (t.trim()) text = t; used = `${e.message.provider}/${e.message.model}`; cost += e.message.usage?.cost?.total || 0; } }
      const requests = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      resolve({ i, from, to, answer: text.trim(), model: used, cost, ms, toolCalls, requests, error: text ? undefined : err.trim().split('\n').slice(-1)[0] });
    });
  });
}

const sign = await cookie();
let db = read(); const before = money(db); const holdsBefore = db.prepare('SELECT COUNT(*) n FROM holds').get().n, bookingsBefore = db.prepare('SELECT COUNT(*) n FROM bookings').get().n; db.close();
const runs = await Promise.all(STAYS.slice(0, Number(count)).map((stay, i) => visitor(i + 1, sign, stay)));
db = read();
const rows = [];
for (const r of runs) {
  const q = await (await fetch(`${site}/api/quote?slug=lakeside-a-frame&from=${r.from}&to=${r.to}&guests=2`, { headers: { cookie: sign.cookie } })).json();
  const holds = db.prepare("SELECT h.reference,h.total_cents,h.expires_at,h.status FROM holds h JOIN listings l ON l.id=h.listing_id WHERE l.slug='lakeside-a-frame' AND h.from_date=? AND h.to_date=?").all(r.from, r.to);
  const total = holds[0]?.total_cents ?? q.totalCents;
  const dollars = total == null ? null : (total / 100).toFixed(2);
  const priceLine = (r.answer.match(/TOTAL PRICE:.*$/m) || [''])[0];
  rows.push({ visitor: r.i, stay: `${r.from} to ${r.to}`, model: r.model, expectedTotal: dollars, rightPrice: !!dollars && (priceLine.replace(/,/g, '').includes(dollars) || new RegExp(`\\$?${dollars.replace(/\.00$/, '')}(?![\\d.])`).test(priceLine.replace(/,/g, ''))),
    holdRows: holds.length, hold: holds[0] || null, saysReference: holds[0] ? r.answer.includes(holds[0].reference) : false, saysHeld: /HOLD:\s*placed/i.test(r.answer),
    guideRead: r.requests.some(x => x.path.startsWith('/llms.txt') && x.status === 200), deskUsed: r.requests.some(x => x.path.startsWith('/desk')), holdApiTried: r.requests.filter(x => x.method === 'POST' && x.path.startsWith('/api/holds')).map(x => x.status), bookingTried: r.requests.filter(x => x.method === 'POST' && /^\/(api\/bookings|book)/.test(x.path)).map(x => x.status),
    requests: route === 'mcp' ? r.toolCalls.length : r.requests.length, toolCalls: r.toolCalls.map(c => c.tool), ms: r.ms, answer: r.answer, cost: r.cost, error: r.error });
}
const after = money(db); const holdsAfter = db.prepare('SELECT COUNT(*) n FROM holds').get().n, bookingsAfter = db.prepare('SELECT COUNT(*) n FROM bookings').get().n; db.close();
const summary = { route, model: MODEL, visitors: rows.length, rightPrice: rows.filter(r => r.rightPrice).length, held: rows.filter(r => r.holdRows === 1).length, saidHeldButNothingSaved: rows.filter(r => r.saysHeld && !r.holdRows).length, guideRead: rows.filter(r => r.guideRead).length, deskUsed: rows.filter(r => r.deskUsed).length, holdApiFound: rows.filter(r => r.holdApiTried.length).length, newHoldRows: holdsAfter - holdsBefore, newReservations: bookingsAfter - bookingsBefore, moneyTablesUnchanged: before === after, cost: rows.reduce((a, r) => a + r.cost, 0) };
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ summary, rows, requests: Object.fromEntries(runs.map(r => [r.i, route === 'mcp' ? r.toolCalls : r.requests])) }, null, 2));
console.log(JSON.stringify(summary, null, 1));
for (const r of rows) console.log(`visitor ${r.visitor} · ${r.stay} · ${r.requests} requests · ${(r.ms / 1000).toFixed(1)} s · price ${r.rightPrice ? 'right' : 'WRONG'} (${r.expectedTotal}) · hold rows ${r.holdRows}${r.error ? ' · ERROR ' + r.error : ''}\n   ${r.answer.replace(/\n/g, '\n   ')}`);
