export const config = { runtime: 'edge' };

import { createApp } from '../../server/app.js';

const app = createApp({
  NEBIUS_API_KEY: process.env.NEBIUS_API_KEY,
  NEBIUS_MODEL: process.env.NEBIUS_MODEL,
  NEBIUS_BASE_URL: process.env.NEBIUS_BASE_URL,
});

type EdgeContext = { params: { p?: string[] } };

const app = createApp({
  NEBIUS_API_KEY: process.env.NEBIUS_API_KEY,
  NEBIUS_MODEL: process.env.NEBIUS_MODEL,
  NEBIUS_BASE_URL: process.env.NEBIUS_BASE_URL,
});

export default async function handler(req: Request, ctx: EdgeContext): Promise<Response> {
  const p = ctx.params.p ?? [];
  const target = `/ai/${p.join('/')}`;
  return app.request(target, {
    method: 'POST',
    headers: { 'Content-Type': req.headers.get('Content-Type') ?? 'application/json' },
    body: await req.text(),
  });
}
