import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { createApp } from './app.js';

// minimal .env loader (no dependency)
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const api = new Hono();
api.use('*', cors());
const app = createApp({
  NEBIUS_API_KEY: process.env.NEBIUS_API_KEY,
  NEBIUS_MODEL: process.env.NEBIUS_MODEL,
  NEBIUS_BASE_URL: process.env.NEBIUS_BASE_URL,
});
api.route('/', app);

const port = Number(process.env.PORT) || 8787;
console.log(`AETHER-NIM API listening on http://localhost:${port}`);
serve({ fetch: api.fetch, port });
