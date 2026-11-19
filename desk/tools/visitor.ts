// The visiting agent's only tool: HTTP to one site. It stands in for a stranger's agent that was given an address.
// VISITOR_SITE is the only origin allowed; VISITOR_COOKIE (optional) is the guest's own sign-in; every call is written to VISITOR_LOG.
import { appendFileSync } from 'node:fs';
import { Type } from 'typebox';
const SITE = (process.env.VISITOR_SITE || '').replace(/\/$/, '');
export default function visitor(pi: any) {
  pi.registerTool({
    name: 'http_request', label: 'HTTP request',
    description: `Make one HTTP request to the site ${SITE}. Only this site can be reached. Returns the status and the body (HTML is reduced to its text and links).`,
    parameters: Type.Object({
      method: Type.String({ description: 'GET or POST' }),
      path: Type.String({ description: 'Path on the site, starting with /, with any query string' }),
      body: Type.Optional(Type.String({ description: 'For POST: a JSON object as text' })),
    }),
    async execute(_id: string, p: any) {
      const method = String(p.method || 'GET').toUpperCase();
      let status = 0, text = '';
      if (!['GET', 'POST'].includes(method) || !String(p.path).startsWith('/') || String(p.path).startsWith('//')) text = 'Refused: only GET or POST to a path on this site.';
      else try {
        const res = await fetch(SITE + p.path, { method, redirect: 'manual', headers: { ...(process.env.VISITOR_COOKIE ? { cookie: process.env.VISITOR_COOKIE } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? (p.body || '{}') : undefined });
        status = res.status; text = await res.text();
        if (res.headers.get('location')) text = `Redirect to ${res.headers.get('location')}\n` + text;
        if ((res.headers.get('content-type') || '').includes('html')) text = text.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<a [^>]*href="([^"]+)"[^>]*>/g, ' [link $1] ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
      } catch (e: any) { text = `The site did not answer: ${e.message}`; }
      if (process.env.VISITOR_LOG) appendFileSync(process.env.VISITOR_LOG, JSON.stringify({ method, path: p.path, body: p.body, status }) + '\n');
      return { content: [{ type: 'text', text: `HTTP ${status}\n${text.slice(0, 6000)}` }], details: { status } };
    },
  });
}
