// The parts of the wake-up that need no Pi and no model: which agent owns a path,
// whether it has already spoken about it, and what it is asked.
// Tested in test/wake-up.test.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type Agent = { name: string; dir: string; owns: string[] };
export type Touch = { tool: string; paths: string[]; change?: string };

/** The reply an agent gives when it has nothing to warn about. */
export const NOTHING = 'NOTHING';
/** Tools that look at or change a file. */
export const WATCHED = ['read', 'edit', 'write', 'bash'];

/** One line of owns.txt as a pattern: `*` stays inside a folder, `**` crosses folders, `?` is one character. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** owns.txt: one path or glob per line; blank lines and # comments are skipped. A line ending in / owns the folder. */
export function parseOwns(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => l.replace(/^\.?\//, '')).map(l => l.endsWith('/') ? `${l}**` : l);
}

/** Every agents/<name>/ folder that has an owns.txt. */
export function loadAgents(root: string): Agent[] {
  const dir = join(root, 'agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap(name => {
    const file = join(dir, name, 'owns.txt');
    return existsSync(file) ? [{ name, dir: join(dir, name), owns: parseOwns(readFileSync(file, 'utf8')) }] : [];
  });
}

/** A path as the project writes it (forward slashes, from the project root), or null when it is outside the project. */
export function projectPath(root: string, cwd: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(cwd, path.replace(/^@/, ''));
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

export function owners(agents: Agent[], path: string): Agent[] {
  return agents.filter(a => a.owns.some(g => globToRegExp(g).test(path)));
}

/** The files a tool call touches. For a shell command: the words in it that look like paths. */
export function touched(tool: string, input: any, root: string, cwd: string): Touch | null {
  if (!WATCHED.includes(tool) || !input) return null;
  let raw: string[] = [], change: string | undefined;
  if (tool === 'bash') raw = String(input.command ?? '').split(/[\s'"`;|&<>()=]+/).filter(w => w.includes('/') || w.includes('.'));
  else if (typeof input.path === 'string') raw = [input.path];
  if (tool === 'edit') change = (input.edits ?? [input]).map((e: any) => `- ${clip(e.oldText ?? '', 600)}\n+ ${clip(e.newText ?? '', 600)}`).join('\n');
  if (tool === 'write') change = `+ ${clip(String(input.content ?? ''), 1200)}`;
  if (tool === 'bash') change = clip(String(input.command ?? ''), 600);
  const paths = [...new Set(raw.map(p => projectPath(root, cwd, p)).filter((p): p is string => !!p))];
  return paths.length ? { tool, paths, change } : null;
}

/** Each agent speaks once about each path in a conversation. */
export class Once {
  private seen = new Set<string>();
  private key(agent: string, path: string) { return `${agent}\n${path}`; }
  has(agent: string, path: string) { return this.seen.has(this.key(agent, path)); }
  /** True the first time, false after. */
  mark(agent: string, path: string) { if (this.has(agent, path)) return false; this.seen.add(this.key(agent, path)); return true; }
  clear() { this.seen.clear(); }
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters]` : text;
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c?.type === 'text').map(c => c.text).join('\n');
}

/** What Main is doing, from its conversation: the person's latest request and Main's latest words. */
export function mainContext(entries: any[]): { request: string; said: string } {
  let request = '', said = '';
  for (const e of entries) {
    const m = e?.type === 'message' ? e.message : null;
    if (!m) continue;
    const t = textOf(m.content).trim();
    if (!t) continue;
    if (m.role === 'user') { request = t; said = ''; }
    else if (m.role === 'assistant') said = t;
  }
  return { request: clip(request, 2000), said: clip(said, 1200) };
}

/** The agent's standing instructions: its job, its glossary, its memories, and how to answer a wake-up. */
export function systemPrompt(agent: Agent): string {
  const read = (f: string) => existsSync(join(agent.dir, f)) ? readFileSync(join(agent.dir, f), 'utf8').trim() : '';
  const job = (read('agent.md').match(/^## Job\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m)?.[1] ?? read('agent.md')).trim();
  return [job, read('glossary.md'), read('memories.md'), `## When you are woken
The main agent has just opened or changed a file you own. You are told what it was asked to do and what it is doing. You are speaking to the main agent directly. You cannot read or change anything; the main agent does the work.
You are not a code reviewer and you have not seen the file. Your only job is to pass on what your memories and glossary already say that bears on this task.
Go through your memories one line at a time. For each, ask: could the change the main agent was asked to make break what this line protects, or does it depend on something this line says is not decided? Pass on only the lines where the answer is yes.
- At most four short lines, the most likely trap first. Say in terms of this task what to check or avoid, and why, as the memory gives it.
- Say nothing that is not in a memory or a glossary term. Never invent a rule, a number, a column or a source. Never write code.
- End each line with the source the memory itself cites, in brackets, copied as written, for example [commit 1a2b3c4] or [tracker card name].
If nothing you know applies to this task, reply with exactly: ${NOTHING}`].filter(Boolean).join('\n\n');
}

export function wakePrompt(touch: Touch, path: string, main: { request: string; said: string }): string {
  return [`The main agent used \`${touch.tool}\` on \`${path}\`, a file you own.`,
    main.request ? `What it was asked to do:\n"""\n${main.request}\n"""` : 'It has not said what it was asked to do.',
    main.said ? `What it last said:\n"""\n${main.said}\n"""` : '',
    touch.change ? `The ${touch.tool === 'bash' ? 'command' : 'change'}:\n"""\n${touch.change}\n"""` : '',
    `Warn it, or reply ${NOTHING}.`].filter(Boolean).join('\n\n');
}

/** The agent's reply as a warning, or null when it had nothing to say. */
export function warningFrom(reply: string): string | null {
  const t = reply.trim();
  if (!t || /^\W*NOTHING\W*$/i.test(t)) return null;
  return t;
}

/** What Main reads, attached to the result of the tool call that woke the agent. */
export function note(agent: string, path: string, warning: string): string {
  const title = agent[0].toUpperCase() + agent.slice(1);
  return `\n\n[${title} domain agent, woken because you touched ${path}. It is read-only; you decide and you write.]\n${warning}`;
}
