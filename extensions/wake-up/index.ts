// Wake-up: when the main agent reads or changes a file a domain agent owns
// (agents/<name>/owns.txt), that agent is run once for that file in this conversation
// and its short, cited warning is attached to what the main agent reads next.
// It never blocks a tool, never edits, and says nothing when nothing applies.
//
//   pi -e extensions/wake-up                      this run only
//   .pi/settings.json  {"extensions": ["../extensions/wake-up"]}   every run in this project
//
// The domain agent is Pi in print mode on a small model with no tools: it sees its job,
// glossary and memories and what the main agent was asked and is doing, never the code. WAKE_MODEL changes the model.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Agent, type Touch, Once, loadAgents, mainContext, note, owners, systemPrompt, touched, wakePrompt, warningFrom } from './core.ts';

const MODEL = process.env.WAKE_MODEL || 'anthropic/claude-haiku-5-5';
const PI = process.env.PI_BIN || 'pi';

type Reply = { text: string; model: string; cost: number };

function ask(system: string, prompt: string, signal?: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const argv = ['-p', '--mode', 'json', '--no-session', '-ne', '-ns', '-np', '-nc', '--no-mcp', '--no-tools', '--thinking', 'off', '--model', MODEL, '--system-prompt', system, prompt];
    const child = spawn(PI, argv, { cwd: tmpdir(), env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      let text = '', model = '', cost = 0;
      for (const line of out.split('\n')) {
        let e: any; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'message_end' && e.message?.role === 'assistant') {
          text = (e.message.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
          model = `${e.message.provider}/${e.message.model}`; cost += e.message.usage?.cost?.total || 0;
          if (e.message.errorMessage) err += e.message.errorMessage;
        }
      }
      if (!text.trim()) return reject(Error(`${MODEL} gave no reply (exit ${code}): ${err.trim().split('\n').slice(-1)[0] || 'no output'}`));
      if (model !== MODEL) return reject(Error(`asked for ${MODEL}, but ${model} answered`));
      resolve({ text: text.trim(), model, cost });
    });
  });
}

export default function wakeUp(pi: any) {
  const once = new Once();
  const waiting = new Map<string, Promise<string>[]>();
  let root = '';

  const record = (line: object) => {
    try { mkdirSync(join(root, 'lab-reports'), { recursive: true }); appendFileSync(join(root, 'lab-reports', 'wake-up.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n'); } catch {}
  };

  async function wake(agent: Agent, touch: Touch, path: string, ctx: any): Promise<string> {
    const started = Date.now();
    const main = mainContext(ctx.sessionManager.getBranch());
    try {
      const reply = await ask(systemPrompt(agent), wakePrompt(touch, path, main), ctx.signal);
      const warning = warningFrom(reply.text);
      record({ agent: agent.name, path, tool: touch.tool, model: reply.model, cost: reply.cost, ms: Date.now() - started, request: main.request, warning });
      if (!warning) return '';
      if (ctx.hasUI) ctx.ui.notify(`${agent.name} warned Main about ${path}`, 'info');
      return note(agent.name, path, warning);
    } catch (e: any) {
      record({ agent: agent.name, path, tool: touch.tool, model: MODEL, ms: Date.now() - started, error: e.message });
      return `\n\n[${agent.name} domain agent owns ${path} but could not be asked (${e.message}). No warning was given; read agents/${agent.name}/memories.md yourself.]`;
    }
  }

  pi.on('session_start', (_event: any, ctx: any) => {
    root = ctx.cwd; once.clear(); waiting.clear();
    for (const e of ctx.sessionManager.getEntries()) if (e.type === 'custom' && e.customType === 'wake-up') once.mark(e.data.agent, e.data.path);
  });

  // Before the tool runs: start the owning agent. Nothing is returned, so the tool is never blocked.
  pi.on('tool_call', (event: any, ctx: any) => {
    root ||= ctx.cwd;
    const touch = touched(event.toolName, event.input, root, ctx.cwd);
    if (!touch) return;
    const agents = loadAgents(root);
    const runs: Promise<string>[] = [];
    for (const path of touch.paths) for (const agent of owners(agents, path)) {
      if (!once.mark(agent.name, path)) continue;
      pi.appendEntry('wake-up', { agent: agent.name, path });
      runs.push(wake(agent, touch, path, ctx));
    }
    if (runs.length) waiting.set(event.toolCallId, runs);
  });

  // When the tool has finished: attach what the agent said to what Main reads.
  pi.on('tool_result', async (event: any) => {
    const runs = waiting.get(event.toolCallId);
    if (!runs) return;
    waiting.delete(event.toolCallId);
    const notes = (await Promise.all(runs)).filter(Boolean);
    if (!notes.length) return;
    return { content: [...(event.content ?? []), { type: 'text', text: notes.join('') }] };
  });
}
