/**
 * Vercel Node function: stateless proxy for the browser-embedded twin's AI stage.
 * Forwards Token Factory /chat/completions requests with the server-held key.
 *
 * The /api/* → /api/[...p] route rewrite carries the original sub-path in the
 * `...p` query parameter; direct function invocations keep the real pathname.
 */
import { createApp } from './app.js';

type NodeReq = {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  on?: unknown;
  [Symbol.asyncIterator]?: unknown;
};
type NodeRes = { statusCode: number; setHeader(k: string, v: string): void; end(b: Uint8Array): void };

const app = createApp({
  NEBIUS_API_KEY: process.env.NEBIUS_API_KEY,
  NEBIUS_MODEL: process.env.NEBIUS_MODEL,
  NEBIUS_BASE_URL: process.env.NEBIUS_BASE_URL,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
});

async function readBody(req: NodeReq): Promise<string> {
  if (!req[Symbol.asyncIterator]) return '';
  let out = '';
  for await (const chunk of req as unknown as AsyncIterable<Uint8Array>) out += Buffer.from(chunk).toString('utf8');
  return out;
}

function resolveTarget(req: NodeReq): string {
  const url = new URL(req.url ?? '/api/[...p]', 'http://localhost');
  let pathname = url.pathname;
  const injected = url.searchParams.get('...p');
  if (injected) pathname = `/api/${injected}`;
  return pathname
    .replace(/^\/api\/health$/, '/health')
    .replace(/^\/api\/(ai|web)/, '/$1');
}

export default async function handler(req: NodeReq, res: NodeRes): Promise<void> {
  const target = resolveTarget(req);
  const method = req.method ?? 'POST';
  try {
    const r = await app.request(target, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' || method === 'HEAD' ? undefined : await readBody(req),
    });
    res.statusCode = r.status;
    for (const [k, v] of r.headers) if (k !== 'content-encoding' && k !== 'transfer-encoding') res.setHeader(k, v);
    res.end(new Uint8Array(await r.arrayBuffer()));
  } catch {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(new TextEncoder().encode(JSON.stringify({ error: 'model proxy upstream failed' })));
  }
}
