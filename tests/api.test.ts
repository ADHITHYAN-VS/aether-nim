import { describe, it, expect } from 'vitest';
import { createApp } from '../server/app.js';

const app = createApp({}); // AI disabled by default → honest fallback mode

describe('API', () => {
  it('health reports state and honest aiConfigured=false', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.status).toBe('ok');
    expect(j.aiConfigured).toBe(false);
  });

  it('state returns topology, metrics, baseline and timeline', async () => {
    const res = await app.request('/api/state');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.healthyBaseline.components).toBe(1);
    expect(j.metrics.components).toBe(1);
    expect(j.topology.nodes.length).toBe(17);
    expect(j.ai.enabled).toBe(false);
  });

  it('full damage preset + recover round-trip succeeds without AI', async () => {
    expect((await (await app.request('/api/damage-preset', { method: 'POST', body: JSON.stringify({ id: 'bridge-failure' }), headers: { 'Content-Type': 'application/json' } })).json()).ok).toBe(true);
    let state = await (await app.request('/api/state')).json();
    expect(state.metrics.components).toBe(2);
    const rec = await (await app.request('/api/recover', { method: 'POST' })).json();
    expect(rec.ok).toBe(true);
    expect(rec.plan.source).toBe('greedy-optimizer');
    expect(rec.ai.mode).toBe('fallback'); // honest mode, never faked
    state = await (await app.request('/api/state')).json();
    expect(state.metrics.components).toBe(1);
  });

  it('rejects invalid injections and unknown scenarios', async () => {
    const bad = await app.request('/api/inject', { method: 'POST', body: JSON.stringify({ kind: 'explode' }), headers: { 'Content-Type': 'application/json' } });
    expect(bad.status).toBe(400);
    const badScenario = await app.request('/api/scenario', { method: 'POST', body: JSON.stringify({ id: 'not-a-scenario' }), headers: { 'Content-Type': 'application/json' } });
    expect(badScenario.status).toBe(400);
    const malformed = await app.request('/api/inject', { method: 'POST', body: 'not-json{', headers: { 'Content-Type': 'application/json' } });
    expect(malformed.status).toBe(400);
  });

  it('manual restore endpoint works and rejects bad ids', async () => {
    await app.request('/api/reset', { method: 'POST' });
    const fail = await app.request('/api/inject', { method: 'POST', body: JSON.stringify({ kind: 'failEdge', id: 'wr1' }), headers: { 'Content-Type': 'application/json' } });
    expect(fail.status).toBe(200);
    const restore = await app.request('/api/restore', { method: 'POST', body: JSON.stringify({ kind: 'edge', id: 'wr1' }), headers: { 'Content-Type': 'application/json' } });
    expect(restore.status).toBe(200);
    const badRestore = await app.request('/api/restore', { method: 'POST', body: JSON.stringify({ kind: 'edge', id: 'zzz' }), headers: { 'Content-Type': 'application/json' } });
    expect(badRestore.status).toBe(400);
  });

  it('scenario switch resets to healthy state', async () => {
    const r = await app.request('/api/scenario', { method: 'POST', body: JSON.stringify({ id: 'cascading-degradation' }), headers: { 'Content-Type': 'application/json' } });
    expect(r.status).toBe(200);
    const state = await (await app.request('/api/state')).json();
    expect(state.scenario.id).toBe('cascading-degradation');
    expect(state.metrics.components).toBe(1); // fresh healthy world
  });
});
