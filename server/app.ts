import { Hono, type Context } from 'hono';
import type { GraphMetrics, RecoveryAction, TopologySnapshot, IncidentReport, RecoveryOutcome } from '../engine/types.js';
import { Twin, type WebSearchHook } from '../engine/store.js';
import { NebiusAdapter, DEFAULT_BASE_URL } from '../engine/ai.js';
import { makeStoreAdapter } from './d1store.js';
import { OBJECTIVE, actionCost, detectIncident } from '../engine/recovery.js';
import type { WebEvidenceItem } from '../engine/types.js';

export interface EnvConfig {
  NEBIUS_API_KEY?: string;
  NEBIUS_MODEL?: string;
  NEBIUS_BASE_URL?: string;
  /** Optional Tavily runtime-search credential — enables live web-grounded diagnosis */
  TAVILY_API_KEY?: string;
  TAVILY_BASE_URL?: string;
  /** Optional D1 binding — present when deployed on Workers with durable state */
  DB?: unknown;
}

export type TwinEnv = { Bindings: EnvConfig };

const TAVILY_DEFAULT_BASE = 'https://api.tavily.com';

/**
 * Build the optional Tavily web-search hook consumed by the Twin.
 * - server mode (real key): direct runtime call to the Tavily Search API;
 * - embedded/browser mode ('browser-via-proxy'): same-origin /api/web proxy so the
 *   credential never ships to the client.
 * All failures resolve to null — diagnosis never depends on the web stage.
 */
function makeWebHook(env: EnvConfig): WebSearchHook | undefined {
  if (!env.TAVILY_API_KEY) return undefined;
  const browserMode = env.TAVILY_API_KEY === 'browser-via-proxy';
  const tavilyBase = (env.TAVILY_BASE_URL || TAVILY_DEFAULT_BASE).replace(/\/$/, '');

  return async (query: string): Promise<WebEvidenceItem[] | null> => {
    if (browserMode) {
      // Ask the same-origin server route (which holds the real key server-side).
      const res = await fetch('/api/web', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { evidence?: WebEvidenceItem[] };
      return j.evidence ?? null;
    }
    const evidence = await fetchTavilyEvidence(tavilyBase, env.TAVILY_API_KEY as string, query);
    return evidence;
  };
}

async function fetchTavilyEvidence(base: string, apiKey: string, query: string, maxResults = 4): Promise<WebEvidenceItem[] | null> {
  try {
    const res = await fetch(`${base}/search`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: (r.title ?? '').slice(0, 120),
        url: r.url as string,
        snippet: (r.content ?? '').replace(/\s+/g, ' ').slice(0, 400),
      }));
  } catch {
    return null;
  }
}

export function createApp(env: EnvConfig): Hono {
  const ai = new NebiusAdapter({
    apiKey: env.NEBIUS_API_KEY,
    model: env.NEBIUS_MODEL,
    baseUrl: env.NEBIUS_BASE_URL,
  });
  const web = makeWebHook(env);
  const store = makeStoreAdapter(env.DB as Parameters<typeof makeStoreAdapter>[0]);

  /** Per-request state lifecycle: load → (caller mutates) → save. */
  const loadTwin = async (): Promise<Twin> => {
    const state = await store.load();
    if (state) {
      const tw = Twin.restore(state, ai, web);
      if (tw) return tw;
    }
    return new Twin('bridge-failure', ai, web);
  };
  const saveTwin = (tw: Twin): Promise<void> => store.save(tw.serialize());

  const app = new Hono();

  /**
   * CORS preflight: the API is a stateless proxy with no server-held session,
   * so cross-origin reads are safe; OPTIONS was previously unhandled (404),
   * which breaks cross-origin POST callers (e.g. judge tooling / other origins).
   * Same-origin usage is unaffected — browsers skip preflight there.
   */
  app.use('*', async (c, next) => {
    const p = c.req.path.replace(/^\/api/, '');
    const allowed = p === '/health' || p.startsWith('/ai') || p.startsWith('/web');
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.body(null, 404);
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
    }
    await next();
    if (allowed) c.header('Access-Control-Allow-Origin', '*');
  });

  /**
   * Stateless model proxy: forwards a Token Factory /chat/completions request
   * with the server-held key. Lets a pure-static front end keep real inference
   * without ever shipping a credential to the browser.
   */
  async function proxyAI(c: Context): Promise<Response> {
    if (!ai.enabled()) return c.json({ error: 'model proxy not configured' }, 503);
    const base = (env.NEBIUS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.NEBIUS_API_KEY}`, 'Content-Type': 'application/json' },
        body: await c.req.text(),
      });
    } catch {
      return c.json({ error: 'model proxy upstream failed' }, 502);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  // Same proxy reachable at both prefixes (browser callers use /api/ai).
  app.post('/ai/*', proxyAI);
  app.post('/api/ai/*', proxyAI);

  /**
   * Stateless Tavily runtime-search proxy used by the embedded twin to ground the
   * AI diagnosis in real-world web context. Mirrors the /ai credential pattern.
   */
  app.post('/web', async (c) => {
    if (!web || env.TAVILY_API_KEY === 'browser-via-proxy') return c.json({ error: 'web search not configured' }, 503);
    const body = await c.req.json<{ query?: string }>().catch(() => ({}) as { query?: string });
    if (!body.query || typeof body.query !== 'string') return c.json({ error: 'query required' }, 400);
    const evidence = await fetchTavilyEvidence(TAVILY_DEFAULT_BASE, env.TAVILY_API_KEY as string, body.query.slice(0, 400));
    if (!evidence) return c.json({ error: 'web search upstream failed' }, 502);
    return c.json({ evidence, source: 'tavily' });
  });

  app.get('/health', (c) => c.json({
    status: 'ok',
    service: 'aether-nim',
    scenario: 'bridge-failure',
    aiConfigured: ai.enabled(),
    model: ai.modelId(),
    stateStore: store.kind,
  }));

  app.get('/api/state', async (c) => {
    const twin = await loadTwin();
    const snap: TopologySnapshot = twin.snapshot();
    const metrics: GraphMetrics = twin.metrics();
    return c.json({
      scenario: {
        id: snap.scenarioId, name: snap.scenarioName,
        scenarios: Twin.scenarioList(),
        damagePresets: Object.keys(damagePresetsFor(snap.scenarioId)),
      },
      topology: { nodes: snap.nodes, edges: snap.edges, demands: snap.demands, revision: snap.revision },
      metrics,
      healthyBaseline: twin.healthyBaseline,
      incident: currentIncident(twin),
      lastRecovery: twin.lastRecovery,
      lastAI: lastAISummary(twin),
      timeline: twin.timelineList().slice(0, 120),
      objective: OBJECTIVE,
      ai: { enabled: ai.enabled(), model: ai.modelId() },
      web: twin.lastWeb,
      stateStore: store.kind,
    });
  });

  app.post('/api/scenario', async (c) => {
    const body = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
    const scenarios = Twin.scenarioList();
    if (!body.id || !scenarios.some((s) => s.id === body.id)) {
      return c.json({ error: `unknown scenario id; valid: ${scenarios.map((s) => s.id).join(', ')}` }, 400);
    }
    const twin = new Twin(body.id, ai, web);
    await saveTwin(twin);
    return c.json({ ok: true, scenario: body.id });
  });

  app.post('/api/reset', async (c) => {
    const twin = await loadTwin();
    twin.reset();
    await saveTwin(twin);
    return c.json({ ok: true });
  });

  app.post('/api/damage-preset', async (c) => {
    const body = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
    if (!body.id) return c.json({ error: 'id required' }, 400);
    const twin = await loadTwin();
    const ok = twin.applyDamagePreset(body.id);
    if (!ok) return c.json({ error: `unknown or non-applicable damage preset ${body.id}` }, 400);
    await saveTwin(twin);
    return c.json({ ok: true });
  });

  app.post('/api/inject', async (c) => {
    type InjectBody = { kind?: string; id?: string; latencyFactor?: number; capacityFactor?: number };
    const body = await c.req.json<InjectBody>().catch(() => ({}) as InjectBody);
    if (!body.kind || !body.id) return c.json({ error: 'kind and id are required' }, 400);
    const steps = [] as Parameters<Twin['inject']>[0];
    switch (body.kind) {
      case 'failNode': steps.push({ kind: 'failNode', id: body.id }); break;
      case 'failEdge': steps.push({ kind: 'failEdge', id: body.id }); break;
      case 'degradeEdge': steps.push({ kind: 'degradeEdge', id: body.id, latencyFactor: clampFactor(body.latencyFactor ?? 3) }); break;
      case 'shrinkCapacity': steps.push({ kind: 'shrinkCapacity', id: body.id, capacityFactor: clampFactor(body.capacityFactor ?? 0.4) }); break;
      default: return c.json({ error: `unknown kind ${body.kind}` }, 400);
    }
    const twin = await loadTwin();
    const applied = await twin.inject(steps);
    await saveTwin(twin);
    return c.json({ ok: true, applied });
  });

  app.post('/api/restore', async (c) => {
    const body = await c.req.json<{ kind?: string; id?: string }>().catch(() => ({}) as { kind?: string; id?: string });
    if (!body.kind || !body.id) return c.json({ error: 'kind and id are required' }, 400);
    if (body.kind !== 'node' && body.kind !== 'edge') return c.json({ error: 'kind must be node|edge' }, 400);
    const twin = await loadTwin();
    const ok = twin.restoreComponent(body.kind, body.id);
    if (!ok) return c.json({ error: `cannot restore ${body.kind} ${body.id}` }, 400);
    await saveTwin(twin);
    return c.json({ ok: true });
  });

  app.post('/api/diagnose', async (c) => {
    const twin = await loadTwin();
    const { incident, candidates, ai: aiRes } = await twin.diagnose();
    await saveTwin(twin);
    return c.json({ incident, candidates, ai: lastAISummary(twin, aiRes), web: twin.lastWeb });
  });

  app.post('/api/recover', async (c) => {
    const twin = await loadTwin();
    const outcome = await twin.recover();
    await saveTwin(twin);
    return c.json(summarizeRecovery(twin, outcome));
  });

  return app;
}

/* ---------- helpers ---------- */

function clampFactor(f: number): number {
  if (!Number.isFinite(f)) return 1;
  return Math.max(0.05, Math.min(50, f));
}

function damagePresetsFor(_scenarioId: string): Record<string, unknown> {
  void _scenarioId;
  return { 'bridge-failure': 1, 'cascading-degradation': 2, 'capacity-constrained': 3 };
}

function currentIncident(twin: Twin): IncidentReport | null {
  if (!twin.incidentSnapshot) return null;
  return detectIncident(twin.world, twin.incidentSnapshot.baseline, twin.incidentSnapshot.damaged);
}

function lastAISummary(twin: Twin, direct?: Awaited<ReturnType<Twin['diagnose']>>['ai']) {
  const ai = direct ?? twin.lastAI;
  if (!ai) return null;
  return {
    mode: ai.mode,
    model: ai.model,
    latencyMs: ai.latencyMs ?? null,
    promptTokens: ai.promptTokens ?? null,
    completionTokens: ai.completionTokens ?? null,
    attempts: ai.attempts ?? null,
    error: ai.error ?? null,
    parsed: ai.parsed ?? null,
  };
}

function summarizeRecovery(twin: Twin, outcome: RecoveryOutcome) {
  return {
    ok: outcome.verification?.success ?? false,
    plan: outcome.plan,
    verification: outcome.verification,
    revertedPlan: outcome.revertedPlan,
    metrics: twin.metrics(),
    actionCosts: outcome.plan.actions.map((a: RecoveryAction) => ({ action: a, cost: actionCost(a) })),
    ai: lastAISummary(twin),
    web: twin.lastWeb,
    timeline: twin.timelineList().slice(0, 120),
  };
}
