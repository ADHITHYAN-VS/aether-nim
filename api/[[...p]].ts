/**
 * Vercel Node function: stateless proxy for the browser-embedded twin's AI stage.
 * Forwards Token Factory /chat/completions requests with the server-held key.
 */
import { createApp } from '../../server/app.js';

type NodeReq = { url: string; headers: Record<string, string | string[] | undefined>; on?: unknown; [Symbol.asyncIterator]?: unknown };
type NodeRes = { statusCode: number; setHeader(k: string, v: string): void; end(b: Uint8Array): void };

const app = createApp({
  NEBIUS_API_KEY: process.env.NEBIUS_API_KEY,
  NEBIUS_MODEL: process.env.NEBIUS_MODEL,
  NEBIUS_BASE_URL: process.env.NEBIUS_BASE_URL,
});

async function readBody(req: NodeReq): Promise<string> {
  if (!req[Symbol.asyncIterator]) return '';
  let out = '';
  for await (const chunk of req as unknown as AsyncIterable<Uint8Array>) out += Buffer.from(chunk).toString('utf8');
  return out;
}

export default async function handler(req: NodeReq, res: NodeRes): Promise<void> {
  const url = new URL(req.url, 'http://localhost');
  const target = url.pathname.replace(/^\/api\/ai/, '/ai');
  try {
    const r = await app.request(target, { method: 'POST', body: await readBody(req) });
    res.statusCode = r.status;
    for (const [k, v] of r.headers) if (k !== 'content-encoding' && k !== 'transfer-encoding') res.setHeader(k, v);
    res.end(new Uint8Array(await r.arrayBuffer()));
  } catch {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(new TextEncoder().encode(JSON.stringify({ error: 'model proxy upstream failed' })));
  }
}
