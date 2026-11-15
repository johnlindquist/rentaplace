import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTHING, Once, globToRegExp, loadAgents, mainContext, note, owners, parseOwns, projectPath, systemPrompt, touched, wakePrompt, warningFrom } from '../extensions/wake-up/core.ts';

const root = process.cwd();

test('owns.txt: globs, folders, comments', () => {
  assert.deepEqual(parseOwns('# reservations\nsrc/domain/bookings.ts\n\n./test/book*.ts\napp/trips/\n'), ['src/domain/bookings.ts', 'test/book*.ts', 'app/trips/**']);
  assert.ok(globToRegExp('src/domain/bookings.ts').test('src/domain/bookings.ts'));
  assert.ok(!globToRegExp('src/domain/bookings.ts').test('src/domain/bookingsXts'));
  assert.ok(globToRegExp('test/book*.ts').test('test/bookings.test.ts'));
  assert.ok(!globToRegExp('test/*.ts').test('test/deep/x.ts'));
  assert.ok(globToRegExp('app/trips/**').test('app/trips/[id]/page.tsx'));
  assert.ok(globToRegExp('src/**/pricing.ts').test('src/pricing.ts'));
  assert.ok(globToRegExp('src/**/pricing.ts').test('src/domain/pricing.ts'));
});

test('the real agents: Booking owns bookings.ts, nobody owns search', () => {
  const agents = loadAgents(root);
  assert.deepEqual(agents.map(a => a.name), ['booking', 'pricing']);
  assert.deepEqual(owners(agents, 'src/domain/bookings.ts').map(a => a.name), ['booking']);
  assert.deepEqual(owners(agents, 'src/domain/search.ts'), []);
  assert.deepEqual(owners(agents, 'README.md'), []);
});

test('paths are compared from the project root; outside the project is ignored', () => {
  assert.equal(projectPath('/p', '/p', 'src/a.ts'), 'src/a.ts');
  assert.equal(projectPath('/p', '/p/src', '../test/a.ts'), 'test/a.ts');
  assert.equal(projectPath('/p', '/p', '/p/src/a.ts'), 'src/a.ts');
  assert.equal(projectPath('/p', '/p', '/etc/hosts'), null);
  assert.equal(projectPath('/p', '/p', '../q/a.ts'), null);
});

test('which files a tool call touches', () => {
  assert.deepEqual(touched('read', { path: 'src/domain/bookings.ts' }, '/p', '/p'), { tool: 'read', paths: ['src/domain/bookings.ts'], change: undefined });
  assert.equal(touched('ls', { path: 'src' }, '/p', '/p'), null);
  assert.equal(touched('read', {}, '/p', '/p'), null);
  const edit = touched('edit', { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }, '/p', '/p');
  assert.equal(edit?.change, '- a\n+ b');
  assert.deepEqual(touched('bash', { command: 'grep -n closed src/domain/bookings.ts | head' }, '/p', '/p')?.paths, ['src/domain/bookings.ts']);
  assert.equal(touched('bash', { command: 'npm test' }, '/p', '/p'), null);
});

test('an agent speaks once about a path', () => {
  const once = new Once();
  assert.equal(once.mark('booking', 'src/domain/bookings.ts'), true);
  assert.equal(once.mark('booking', 'src/domain/bookings.ts'), false);
  assert.equal(once.mark('booking', 'test/bookings.test.ts'), true);
  assert.equal(once.mark('pricing', 'src/domain/bookings.ts'), true);
  once.clear();
  assert.equal(once.mark('booking', 'src/domain/bookings.ts'), true);
});

test('what Main is doing: the latest request and what Main said after it', () => {
  const entries = [
    { type: 'message', message: { role: 'user', content: 'old request' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } },
    { type: 'custom', customType: 'wake-up', data: {} },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'A closed home is still bookable.' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'I will add a check.' }, { type: 'toolCall', name: 'read' }] } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'file' }] } },
  ];
  assert.deepEqual(mainContext(entries), { request: 'A closed home is still bookable.', said: 'I will add a check.' });
  assert.deepEqual(mainContext([]), { request: '', said: '' });
});

test('the agent is given its job, glossary and memories, never its expectations, and Main is given a labelled note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-'));
  mkdirSync(join(dir, 'agents', 'booking'), { recursive: true });
  const put = (f: string, t: string) => writeFileSync(join(dir, 'agents', 'booking', f), t);
  put('agent.md', '# Booking\n\n## Job\nYou are read-only.\n\n## Files\n- not part of the job\n');
  put('owns.txt', 'src/b.ts\n'); put('glossary.md', '- **Hold**: locks the price.'); put('memories.md', '- Replays return the first reservation. (commit abc)');
  put('expectations.md', 'Expect: SECRET');
  const [agent] = loadAgents(dir);
  const system = systemPrompt(agent);
  assert.match(system, /You are read-only\./); assert.match(system, /locks the price/); assert.match(system, /commit abc/);
  assert.doesNotMatch(system, /SECRET|not part of the job/);
  assert.match(system, new RegExp(`reply with exactly: ${NOTHING}`));
  const prompt = wakePrompt({ tool: 'edit', paths: ['src/b.ts'], change: '- a\n+ b' }, 'src/b.ts', { request: 'Fix it', said: '' });
  assert.match(prompt, /used `edit` on `src\/b\.ts`/); assert.match(prompt, /Fix it/); assert.match(prompt, /\+ b/);
  assert.equal(warningFrom('NOTHING'), null); assert.equal(warningFrom(' nothing.\n'), null); assert.equal(warningFrom(''), null);
  assert.equal(warningFrom('Check replays first. [commit abc]'), 'Check replays first. [commit abc]');
  assert.match(note('booking', 'src/b.ts', 'Check replays.'), /\[Booking domain agent, woken because you touched src\/b\.ts\. It is read-only; you decide and you write\.\]\nCheck replays\./);
});
