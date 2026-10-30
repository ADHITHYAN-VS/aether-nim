import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NetworkWorld } from '../engine/graph.js';
import { computeMetrics } from '../engine/metrics.js';
import { runRecovery } from '../engine/recovery.js';
import { ALL_SCENARIOS } from '../engine/scenarios.js';
import { DAMAGE_PRESETS, applyDamage } from '../engine/damage.js';
import type { GraphMetrics } from '../engine/types.js';

/* servedPct is derived (kept out of GraphMetrics to avoid duplicate truth) */
const pct = (m: GraphMetrics) => (m.demandedMbps > 0 ? Math.round((m.routedMbps / m.demandedMbps) * 1000) / 10 : 100);

/* ------------------------------------------------------------------ */
/* Baseline strategies (scripted, deterministic, no lookahead)         */
/* ------------------------------------------------------------------ */

/** Trivial operator policy: restore every failed link/node, in sorted order. */
function baselineRestoreAll(world: NetworkWorld): string[] {
  const actions: string[] = [];
  for (const e of world.edges.filter((x) => x.state === 'down' && !x.openable).map((x) => x.id).sort()) {
    if (world.restoreEdge(e)) actions.push(`RestoreEdge:${e}`);
  }
  for (const n of world.nodes.filter((x) => x.state === 'down').map((x) => x.id).sort()) {
    if (world.restoreNode(n)) actions.push(`RestoreNode:${n}`);
  }
  return actions;
}

/** Non-lookahead greedy: repeatedly apply the single best next action by J, no pairwise search. */
function baselineGreedyNoLookahead(world: NetworkWorld, healthy: GraphMetrics): { actions: string[]; log: string[] } {
  const actions: string[] = [];
  const log: string[] = [];
  for (let step = 0; step < 12; step++) {
    const cur = computeMetrics(world);
    let curJ = objectiveQuick(cur, healthy);
    let best: { key: string; j: number; apply: () => boolean } | null = null;
    for (const e of world.edges) {
      if (e.state === 'down' && !e.openable) {
        const w = world.clone(); const ok = w.restoreEdge(e.id); if (!ok) continue;
        const j = objectiveQuick(computeMetrics(w), healthy) + 20;
        if (!best || j < best.j) best = { key: `RestoreEdge:${e.id}`, j, apply: () => world.restoreEdge(e.id) };
      } else if (e.state === 'down' && e.openable) {
        const w = world.clone(); const ok = w.openCandidateEdge(e.id); if (!ok) continue;
        const j = objectiveQuick(computeMetrics(w), healthy) + 30;
        if (!best || j < best.j) best = { key: `OpenCandidate:${e.id}`, j, apply: () => world.openCandidateEdge(e.id) };
      }
    }
    for (const n of world.nodes) {
      if (n.state === 'down') {
        const w = world.clone(); const ok = w.restoreNode(n.id); if (!ok) continue;
        const j = objectiveQuick(computeMetrics(w), healthy) + 25;
        if (!best || j < best.j) best = { key: `RestoreNode:${n.id}`, j, apply: () => world.restoreNode(n.id) };
      }
    }
    if (!best || best.j >= curJ - 1e-9 || !best.apply()) { log.push(`step ${step + 1}: stop`); break; }
    actions.push(best.key);
    curJ = best.j;
    log.push(`step ${step + 1}: ${best.key} → J=${best.j.toFixed(2)}`);
  }
  return { actions, log };
}

/** Lightweight standalone objective (no plan-cost coupling) for baseline scoring parity. */
function objectiveQuick(m: GraphMetrics, healthy: GraphMetrics): number {
  const unmet = m.demandedMbps > 0 ? Math.max(0, 1 - m.routedMbps / m.demandedMbps) : 0;
  const spec = Math.max(0, (healthy.algebraicConnectivity ?? 0) - (m.algebraicConnectivity ?? 0));
  return (
    0.01 * (m.avgShortestPathLatencyMs ?? 0) +
    400 * unmet +
    500 * ((m.components - 1) + m.isolatedNodes) +
    50 * spec
  );
}

/* ------------------------------------------------------------------ */

interface Row {
  scenario: string; preset: string; strategy: string;
  damagedServedPct?: number;
  servedPct: number; rerouted: boolean; isolated?: number;
  verified?: boolean; actions?: string[]; actionCount?: number; planMs?: number;
  rollback?: boolean; notes?: string;
}

const rows: Row[] = [];
const t_all = Date.now();

for (const scenario of ALL_SCENARIOS) {
  for (const presetKey of Object.keys(DAMAGE_PRESETS)) {
    const steps = DAMAGE_PRESETS[presetKey];

    // healthy reference
    const healthyM = computeMetrics(new NetworkWorld(scenario));

    // damaged reference
    const wDamaged = new NetworkWorld(scenario);
    applyDamage(wDamaged, steps);
    const damagedM = computeMetrics(wDamaged);

    // --- Ours: full pipeline (AI ranking is exercised separately by the integration check) ---
    {
      const w = new NetworkWorld(scenario);
      applyDamage(w, steps);
      const t0 = Date.now();
      const out = runRecovery(w, healthyM, damagedM, null, t0);
      const m = computeMetrics(w);
      rows.push({
        scenario: scenario.id, preset: presetKey, strategy: 'objJ-plan (ours)',
        damagedServedPct: pct(damagedM),
        servedPct: pct(m),
        rerouted: m.routedMbps >= healthyM.routedMbps * 0.9,
        verified: out.verification ? out.verification.success : false,
        actions: out.plan.actions.map(sortKeyOf),
        actionCount: out.plan.actions.length,
        planMs: t0 ? Date.now() - t0 : undefined,
        rollback: !!out.revertedPlan,
        notes: out.plan.rationale,
      });
    }

    // --- Baseline 1: restore-all-failed (scripted operator policy) ---
    {
      const w = new NetworkWorld(scenario);
      applyDamage(w, steps);
      const actions = baselineRestoreAll(w);
      const m = computeMetrics(w);
      const verified = m.components === healthyM.components && m.routedMbps >= healthyM.routedMbps * 0.9 && m.capacityViolationMbps === 0;
      rows.push({
        scenario: scenario.id, preset: presetKey, strategy: 'restore-all-failed (baseline)',
        damagedServedPct: pct(damagedM),
        servedPct: pct(m),
        rerouted: m.routedMbps >= healthyM.routedMbps * 0.9,
        isolated: m.isolatedNodes,
        verified, actions, actionCount: actions.length,
      });
    }

    // --- Baseline 2: greedy-no-lookahead ---
    {
      const w = new NetworkWorld(scenario);
      applyDamage(w, steps);
      const t0 = Date.now();
      const out = baselineGreedyNoLookahead(w, healthyM);
      const m = computeMetrics(w);
      const verified = m.components === healthyM.components && m.routedMbps >= healthyM.routedMbps * 0.9 && m.capacityViolationMbps === 0;
      rows.push({
        scenario: scenario.id, preset: presetKey, strategy: 'greedy-no-lookahead (baseline)',
        damagedServedPct: pct(damagedM),
        servedPct: pct(m),
        rerouted: m.routedMbps >= healthyM.routedMbps * 0.9,
        isolated: m.isolatedNodes,
        verified, actions: out.actions, actionCount: out.actions.length,
        planMs: Date.now() - t0,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Aggregate summary                                                   */
/* ------------------------------------------------------------------ */

type ActionObj = import('../engine/types.js').RecoveryAction;
function sortKeyOf(a: ActionObj): string {
  switch (a.type) {
    case 'RestoreEdge': return `RestoreEdge:${a.edgeId}`;
    case 'OpenCandidate': return `OpenCandidate:${a.edgeId}`;
    case 'Retune': return `Retune:${a.edgeId}`;
    case 'RestoreNode': return `RestoreNode:${a.nodeId}`;
  }
}

function summarize(strategy: string) {
  const r = rows.filter((x) => x.strategy.startsWith(strategy.split(' (')[0]));
  const wins = r.filter((x) => x.verified).length;
  const avgActions = r.reduce((s, x) => s + (x.actionCount ?? 0), 0) / Math.max(1, r.length);
  const avgMs = r.reduce((s, x) => s + (x.planMs ?? 0), 0) / Math.max(1, r.length);
  return { strategy, cases: r.length, verified: wins, avgActions: Math.round(avgActions * 10) / 10, avgPlanMs: Math.round(avgMs) };
}
const summary = [summarize('objJ-plan'), summarize('restore-all-failed'), summarize('greedy-no-lookahead')];

const outDir = resolve('benchmarks/results');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = resolve(outDir, `benchmark-results-${stamp}.json`);
const payload = { generatedAt: new Date().toISOString(), totalMs: Date.now() - t_all, environment: { platform: process.platform, node: process.version }, summary, rows };
writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ summary, outFile }, null, 2));

/* Keep the latest-results pointer at a stable filename for docs/deep-links */
writeFileSync(resolve(outDir, 'latest.json'), JSON.stringify(payload, null, 2));

