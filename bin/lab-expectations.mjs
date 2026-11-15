// Expectations: a plain Markdown file a person can read and edit. Parsing,
// observed checks and quote matching are deterministic; only "Expect" and
// "Never" lines need the tester's judgment.
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['do', 'run', 'expect', 'never', 'see', 'absent'];
export const SETUP_TITLES = /^(before|setup|before the role opens)$/i;

export const FORMAT = `# <Agent> expectations

## Before
Run: <optional: a shell command the lab runs in the project copy first, e.g. to plant a bug>
Do (Main): <optional: a prompt Main gets before the role opens>

## <Expectation title>
Do (Main): <what to type in Main>
Do (Agent): <only when the check is about typing in the role's own pane, e.g. /agent send main …>
Expect (Agent): <what must happen, judged from the screen>
Never (Agent): <what must not happen>
See (Main): "<exact text that must appear>"
Absent (Main): "<exact text that must not appear>"`;

export function slug(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function strip(text) {
  const t = text.trim();
  const m = t.match(/^["“'‘](.*)["”'’]$/s);
  return m ? m[1] : t;
}

/** Parse expectations Markdown into {title, before:[steps], items:[{id,title,lines}]}. Throws with a line number on mistakes. */
export function parse(markdown, role = 'Agent') {
  const out = { title: '', before: [], items: [] };
  let section = null, n = 0;
  for (const raw of String(markdown).split(/\r?\n/)) {
    n++;
    const line = raw.replace(/^\s*[-*]\s+/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('<!--')) continue;
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) { out.title = h1[1].trim(); continue; }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      const title = h2[1].replace(/^\d+[.)]\s*/, '').trim();
      if (SETUP_TITLES.test(title)) section = { setup: true, lines: out.before };
      else { const item = { id: out.items.length + 1, title, lines: [] }; out.items.push(item); section = item; }
      continue;
    }
    const m = line.match(/^(Do|Run|Expect|Never|See|Absent)\s*(?:\(([^)]+)\))?\s*:\s*(.+)$/i);
    if (!m) {
      if (section && section.lines.length && /^\s/.test(raw)) { section.lines.at(-1).text += ' ' + line.trim(); continue; }
      if (!section) continue; // prose before the first section is commentary
      throw Error(`Line ${n}: start with Do, Run, Expect, Never, See or Absent, e.g. "Expect (${role}): asks which homes it covers".`);
    }
    if (!section) throw Error(`Line ${n}: put "${m[1]}" under a "## Title" heading.`);
    const kind = m[1].toLowerCase();
    let pane = (m[2] || (kind === 'do' ? 'Main' : 'Agent')).trim();
    if (/^(agent|role)$/i.test(pane)) pane = role; // (Role) is the old spelling of (Agent)
    if (/^main$/i.test(pane)) pane = 'Main';
    if (section.setup && kind !== 'do' && kind !== 'run') throw Error(`Line ${n}: the Before section only holds Do and Run lines.`);
    if (kind === 'run' && !section.setup) throw Error(`Line ${n}: Run lines belong under "## Before"; the lab runs them before the first prompt.`);
    if (kind === 'run') { section.lines.push({ kind, pane: 'lab', text: m[3].trim(), line: n }); continue; }
    const text = kind === 'see' || kind === 'absent' ? strip(m[3]) : m[3].trim();
    section.lines.push({ kind, pane, text, line: n });
  }
  if (!out.items.length) throw Error('No expectations yet. Add a "## Title" section with at least one Expect, Never, See or Absent line.');
  for (const item of out.items) {
    if (!item.lines.some(l => l.kind !== 'do')) throw Error(`"${item.title}" has no check. Add an Expect, Never, See or Absent line.`);
  }
  return out;
}

export function judged(item) { return item.lines.filter(l => l.kind === 'expect' || l.kind === 'never'); }
export function observed(item) { return item.lines.filter(l => l.kind === 'see' || l.kind === 'absent'); }
export function steps(item) { return item.lines.filter(l => l.kind === 'do'); }

/** Panes named in the file other than Main and the agent. */
export function panes(spec, role) {
  const all = new Set();
  for (const l of [...spec.before, ...spec.items.flatMap(i => i.lines)]) all.add(l.pane);
  all.delete('Main'); all.delete(role); all.delete('lab');
  return [...all];
}

// Terminal text wraps, pads and decorates lines. Compare letters and digits only.
export function fold(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}]+/gu, '');
}
export function contains(screen, quote) {
  const q = fold(quote);
  return q.length > 0 && fold(screen).includes(q);
}
/**
 * Is this the judge's quote from the reply? Either the quote is in the reply as it stands, or the judge joined
 * several exact pieces with an ellipsis ("first part … second part") or put them on separate lines, as happens
 * when one Expect line holds two facts. Then every piece must be in the reply, in that order. A piece that is not in the reply is still refused.
 */
export function quoted(reply, quote) {
  if (contains(reply, quote)) return true;
  const pieces = String(quote).split(/…|\.{3,}|\n+/).map(fold).filter(Boolean);
  if (pieces.length < 2) return false;
  const text = fold(reply);
  let from = 0;
  for (const piece of pieces) { const at = text.indexOf(piece, from); if (at < 0) return false; from = at + piece.length; }
  return true;
}

/** Find the expectations file for a role: agents/<slug>/expectations.md, then agents/<slug>/expectations.md. */
export function locate(project, role) {
  const s = slug(role);
  for (const dir of ['agents', 'roles']) { // roles/ is the folder's old name
    const file = path.join(project, dir, s, 'expectations.md');
    if (fs.existsSync(file)) return { file, dir: path.dirname(file) };
  }
  return { file: path.join(project, 'agents', s, 'expectations.md'), dir: path.join(project, 'agents', s), missing: true };
}

/** A custom agent's job is the "## Job" section of agent.md beside the expectations. */
/** "Access: work" in agent.md means the agent changes files or runs commands, so the lab opens it with /agent --work. */
/** agent.md, or role.md (its name until 2026-11-11) when that is what the folder has. */
export function agentFile(dir) { const now = path.join(dir, 'agent.md'), old = path.join(dir, 'role.md'); return !fs.existsSync(now) && fs.existsSync(old) ? old : now; }

export function access(dir) {
  const file = agentFile(dir);
  if (!fs.existsSync(file)) return 'read';
  return /^Access:\s*work\b/im.test(fs.readFileSync(file, 'utf8')) ? 'work' : 'read';
}

export function job(dir) {
  const file = agentFile(dir);
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^##\s+Job\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  const body = (m ? m[1] : text.replace(/^#.*$/m, '')).replace(/\s+/g, ' ').trim();
  if (!body) throw Error(`${file} needs a "## Job" section: one paragraph telling the agent what to do.`);
  if (body.length > 2400) throw Error(`${file}: the Job section is ${body.length} characters; /agent accepts up to 2,400.`);
  return body;
}
