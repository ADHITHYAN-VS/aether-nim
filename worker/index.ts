import { createApp } from '../server/app.js';

interface Env {
  NEBIUS_API_KEY?: string;
  NEBIUS_MODEL?: string;
  NEBIUS_BASE_URL?: string;
  /** D1 binding — durable twin state across isolates */
  DB?: unknown;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

let cached: { sig: string; app: ReturnType<typeof createApp> } | null = null;

function getApi(env: Env) {
  const sig = `${env.NEBIUS_MODEL ?? ''}|${env.NEBIUS_BASE_URL ?? ''}|${!!env.NEBIUS_API_KEY}|${!!env.DB}`;
  if (!cached || cached.sig !== sig) {
    try {
      cached = { sig, app: createApp({ NEBIUS_API_KEY: env.NEBIUS_API_KEY, NEBIUS_MODEL: env.NEBIUS_MODEL, NEBIUS_BASE_URL: env.NEBIUS_BASE_URL, DB: env.DB }) };
    } catch (e) {
      // Never leak env contents; a transient failure must not cascade.
      return null;
    }
  }
  return cached.app;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
      const api = getApi(env);
      if (!api) return new Response(JSON.stringify({ error: 'API init failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      return api.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
