/**
 * Embedded twin API — runs the engine + the full HTTP surface in the browser.
 * Each viewer gets an isolated twin; no server state is required, so the demo
 * deploys as a static bundle (plus a stateless /ai proxy for the model call).
 */
import { createApp } from '../../server/app.js';

const app = createApp({
  // Truthy key so the AI adapter activates; every model call is proxied via the
  // same-origin /ai route (the real credential lives server-side only).
  NEBIUS_API_KEY: 'browser-via-proxy',
  NEBIUS_BASE_URL: '/api/ai',
});

async function request(path: string, init: { method: string; body?: string }): Promise<Response> {
  return app.request(path, {
    method: init.method,
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body,
  });
}

export async function state(): Promise<Response> {
  return request('/api/state', { method: 'GET' });
}

export async function post(path: string, body?: unknown): Promise<Response> {
  return request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

export const isEmbedded = true;
