import { Hono } from 'hono';
import type { GraphMetrics, RecoveryAction, TopologySnapshot, IncidentReport, RecoveryOutcome } from '../engine/types.js';
import { Twin } from '../engine/store.js';
import { NebiusAdapter, DEFAULT_BASE_URL } from '../engine/ai.js';
import { makeStoreAdapter } from './d1store.js';
import { OBJECTIVE, actionCost, detectIncident } from '../engine/recovery.js';

export interface EnvConfig {
  NEBIUS_API_KEY?: string;
  NEBIUS_MODEL?: string;
  NEBIUS_BASE_URL?: string;
  /** Optional D1 binding — present when deployed on Workers with durable state */
  DB?: unknown;
}

export type TwinEnv = { Bindings: EnvConfig };

export function createApp(env: EnvConfig): Hono {
  const ai = new NebiusAdapter({
    apiKey: env.NEBIUS_API_KEY,
    model: env.NEBIUS_MODEL,
    baseUrl: env.NEBIUS_BASE_URL,
  });
  const store = makeStoreAdapter(env.DB as Parameters<typeof makeStoreAdapter>[0]);

  /** Per-request state lifecycle: load → (caller mutates) → save. */
  const loadTwin = async (): Promise<Twin> => {
    const state = await store.load();
    if (state) {
      const tw = Twin.restore(state, ai);
      if (tw) return tw;
    }
    return new Twin('bridge-failure', ai);
  };
  const saveTwin = (tw: Twin): Promise<void> => store.save(tw.serialize());

  const app = new Hono();

  /**
   * Stateless model proxy: forwards a Token Factory /chat/completions request
   * with the server-held key. Lets a pure-static front end keep real inference
   * without ever shipping a credential to the browser.
   */
  app.post('/ai/*', async (c) => {
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
      stateStore: store.kind,
    });
  });

  app.post('/api/scenario', async (c) => {
    const body = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
    const scenarios = Twin.scenarioList();
    if (!body.id || !scenarios.some((s) => s.id === body.id)) {
      return c.json({ error: `unknown scenario id; valid: ${scenarios.map((s) => s.id).join(', ')}` }, 400);
    }
    const twin = new Twin(body.id, ai);
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
    return c.json({ incident, candidates, ai: lastAISummary(twin, aiRes) });
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
    timeline: twin.timelineList().slice(0, 120),
  };
}
