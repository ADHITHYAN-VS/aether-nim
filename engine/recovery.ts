import type {
  AIPrompt, GraphMetrics, IncidentReport, RecoveryAction, RecoveryCandidate,
  RecoveryOutcome, RecoveryPlan, RecoveryVerification, ValidationIssue,
} from './types.js';
import type { NetworkWorld } from './graph.js';
import { computeMetrics } from './metrics.js';

/* ------------------------------------------------------------------ */
/* Objective J  (documented, deterministic)                            */
/* ------------------------------------------------------------------ */

export const OBJECTIVE = {
  /** α — repair-capital cost per action (values in ACTION_COSTS) */
  alphaRepair: 1,
  /** β — average shortest-path latency term, per ms */
  betaLatency: 0.01,
  /** γ — unmet demand share normalized to [0,1] */
  gammaCapacity: 400,
  /** δ — per structural disconnect: (extra components + isolated nodes) */
  deltaDisconnectivity: 500,
  /** ε — spectral deficit vs the scenario's own healthy λ2, per unit λ2 */
  epsilonSpectral: 50,
} as const;

const ACTION_COSTS = {
  RestoreEdge: 20,
  RestoreNode: 25,
  OpenCandidate: 30,
  Retune: 15,
} as const;

export function actionCost(a: RecoveryAction): number {
  void OBJECTIVE.alphaRepair;
  return ACTION_COSTS[a.type];
}

/**
 *   J = α·Σcost + β·avgLatency + γ·(1 − routed/demanded)
 *     + δ·((components−1) + isolated) + ε·max(0, λ2healthy − λ2)
 * Every term is measured by computeMetrics; nothing is estimated by a model.
 * The α repair term is added by the planner for candidate plans (J_plan).
 */
export function objectiveJ(m: GraphMetrics, healthy: GraphMetrics): { J: number; terms: Record<string, number> } {
  const unmetShare = m.demandedMbps > 0 ? Math.max(0, 1 - m.routedMbps / m.demandedMbps) : 0;
  const spectralDeficit = (healthy.algebraicConnectivity ?? 0) > 0
    ? Math.max(0, (healthy.algebraicConnectivity ?? 0) - (m.algebraicConnectivity ?? 0))
    : 0;
  const terms = {
    latency: OBJECTIVE.betaLatency * (m.avgShortestPathLatencyMs ?? 0),
    capacity: OBJECTIVE.gammaCapacity * unmetShare,
    disconnectivity: OBJECTIVE.deltaDisconnectivity * ((m.components - 1) + m.isolatedNodes),
    spectral: OBJECTIVE.epsilonSpectral * spectralDeficit,
  };
  const J = terms.latency + terms.capacity + terms.disconnectivity + terms.spectral;
  return { J, terms };
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

export function detectIncident(world: NetworkWorld, baseline: GraphMetrics, damaged: GraphMetrics): IncidentReport {
  const failedNodeIds = world.nodes.filter((n) => n.state === 'down').map((n) => n.id);
  const failedEdgeIds = world.edges.filter((e) => e.state === 'down').map((e) => e.id);
  const degradedEdgeIds: string[] = [];
  for (const e of world.edges) {
    const orig = world.scenario.edges.find((o) => o.id === e.id);
    if (!orig || e.state !== 'up') continue;
    if (e.latencyMs > orig.latencyMs * 1.4 || e.capacityMbps < orig.capacityMbps * 0.6) degradedEdgeIds.push(e.id);
  }
  const notes: string[] = [];
  if (damaged.components > baseline.components) notes.push(`components ${baseline.components} → ${damaged.components}`);
  if (damaged.isolatedNodes > 0) notes.push(`${damaged.isolatedNodes} isolated node(s)`);
  if (failedEdgeIds.length) notes.push(`${failedEdgeIds.length} link(s) down`);
  if (failedNodeIds.length) notes.push(`${failedNodeIds.length} node(s) down`);
  if (degradedEdgeIds.length) notes.push(`${degradedEdgeIds.length} degraded link(s)`);
  if (damaged.routedMbps < baseline.routedMbps * 0.95) notes.push(`throughput ${Math.round(damaged.routedMbps)} of healthy ${Math.round(baseline.routedMbps)} Mbps`);
  return {
    detectedAt: new Date().toISOString(),
    failedNodeIds, failedEdgeIds, degradedEdgeIds,
    summary: notes.length ? `Incident detected: ${notes.join('; ')}.` : 'No incident detected.',
    baseline, damaged,
  };
}

/* ------------------------------------------------------------------ */
/* Candidate generation (deterministic graph analysis)                 */
/* ------------------------------------------------------------------ */

function sortKey(a: RecoveryAction): string {
  switch (a.type) {
    case 'RestoreEdge': return `RestoreEdge:${a.edgeId}`;
    case 'OpenCandidate': return `OpenCandidate:${a.edgeId}`;
    case 'Retune': return `Retune:${a.edgeId}`;
    case 'RestoreNode': return `RestoreNode:${a.nodeId}`;
  }
}

export function generateCandidates(world: NetworkWorld): RecoveryCandidate[] {
  const out: RecoveryCandidate[] = [];
  for (const e of world.edges) {
    if (e.state === 'down' && !e.openable && e.kind !== 'candidate') {
      out.push({
        action: { type: 'RestoreEdge', edgeId: e.id },
        rationale: `link ${e.id} is down — restoring reactivates the physical trunk`,
        estCost: ACTION_COSTS.RestoreEdge,
      });
    }
    if (e.state === 'down' && e.openable) {
      out.push({
        action: { type: 'OpenCandidate', edgeId: e.id },
        rationale: `approved spare corridor ${e.id} adds ${e.capacityMbps} Mbps of alternate capacity`,
        estCost: ACTION_COSTS.OpenCandidate,
      });
    }
    const orig = world.scenario.edges.find((o) => o.id === e.id);
    if (e.state === 'up' && orig && e.kind !== 'candidate' && e.latencyMs > orig.latencyMs * 1.3 && e.minLatencyMs !== undefined) {
      out.push({
        action: { type: 'Retune', edgeId: e.id, toLatencyMs: e.minLatencyMs },
        rationale: `link ${e.id} latency ${e.latencyMs}ms exceeds engineered value — retune toward ${e.minLatencyMs}ms`,
        estCost: ACTION_COSTS.Retune,
      });
    }
  }
  for (const n of world.nodes) {
    if (n.state === 'down') {
      out.push({
        action: { type: 'RestoreNode', nodeId: n.id },
        rationale: `node ${n.id} is down — reactivating restores it and its attached links`,
        estCost: ACTION_COSTS.RestoreNode,
      });
    }
  }
  out.sort((x, y) => x.estCost - y.estCost || sortKey(x.action).localeCompare(sortKey(y.action)));
  return out;
}

/* ------------------------------------------------------------------ */
/* Validation (every action is checked against actual state)           */
/* ------------------------------------------------------------------ */

export function validateAction(world: NetworkWorld, action: RecoveryAction): ValidationIssue {
  switch (action.type) {
    case 'RestoreEdge': {
      const e = world.edgeById(action.edgeId);
      if (!e) return { action, ok: false, reason: `unknown edge ${action.edgeId}` };
      if (e.openable) return { action, ok: false, reason: `edge ${action.edgeId} is a decommissioned spare — use OpenCandidate` };
      if (e.state !== 'down') return { action, ok: false, reason: `edge ${action.edgeId} is already up` };
      return { action, ok: true };
    }
    case 'OpenCandidate': {
      const e = world.edgeById(action.edgeId);
      if (!e) return { action, ok: false, reason: `unknown edge ${action.edgeId}` };
      if (!e.openable) return { action, ok: false, reason: `edge ${action.edgeId} is not an approved candidate corridor` };
      if (e.state !== 'down') return { action, ok: false, reason: `candidate ${action.edgeId} is already open` };
      return { action, ok: true };
    }
    case 'Retune': {
      const e = world.edgeById(action.edgeId);
      if (!e) return { action, ok: false, reason: `unknown edge ${action.edgeId}` };
      if (e.state !== 'up') return { action, ok: false, reason: `edge ${action.edgeId} is down` };
      if (!Number.isFinite(action.toLatencyMs) || action.toLatencyMs < 1) return { action, ok: false, reason: 'latency must be a positive number' };
      if (e.minLatencyMs !== undefined && action.toLatencyMs < e.minLatencyMs) {
        return { action, ok: false, reason: `proposed ${action.toLatencyMs}ms violates engineered floor ${e.minLatencyMs}ms for ${action.edgeId}` };
      }
      if (action.toLatencyMs >= e.latencyMs) return { action, ok: false, reason: 'retune must reduce latency' };
      return { action, ok: true };
    }
    case 'RestoreNode': {
      const n = world.nodeById(action.nodeId);
      if (!n) return { action, ok: false, reason: `unknown node ${action.nodeId}` };
      if (n.state !== 'down') return { action, ok: false, reason: `node ${action.nodeId} is already up` };
      return { action, ok: true };
    }
    default:
      return { action, ok: false, reason: 'unsupported action type' };
  }
}

/** Applies one valid action to the world; returns false without mutating if invalid. */
export function applyAction(world: NetworkWorld, action: RecoveryAction): boolean {
  switch (action.type) {
    case 'RestoreEdge': return world.restoreEdge(action.edgeId);
    case 'RestoreNode': return world.restoreNode(action.nodeId);
    case 'OpenCandidate': return world.openCandidateEdge(action.edgeId);
    case 'Retune': return world.retune(action.edgeId, action.toLatencyMs);
    default: return false;
  }
}

/** Non-mutating simulation on a clone; null if any action is invalid. */
function simulate(world: NetworkWorld, actions: RecoveryAction[]): GraphMetrics | null {
  const w = world.clone();
  for (const a of actions) {
    if (!validateAction(w, a).ok) return null;
    if (!applyAction(w, a)) return null;
  }
  return computeMetrics(w);
}

/* ------------------------------------------------------------------ */
/* Optimizer: greedy + bounded 2-step lookahead (deterministic)        */
/* ------------------------------------------------------------------ */

const MAX_SINGLE_ACTIONS = 8;
const MAX_LOOKAHEAD_WIDTH = 12;

export interface PlanStage {
  world: NetworkWorld;
  baseline: GraphMetrics;   // healthy scenario metrics (J reference)
  priorDamagedJ: number;    // J of the damaged baseline for reporting
}

export function buildPlan(
  world: NetworkWorld,
  baseline: GraphMetrics,
  aiRanking: RecoveryCandidate[] | null,
): { plan: RecoveryPlan; committed: RecoveryAction[]; log: string[] } {
  const log: string[] = [];
  const simJ = (m: GraphMetrics, extra: RecoveryAction[]): number => {
    const { J } = objectiveJ(m, baseline);
    return J + extra.reduce((s, a) => s + actionCost(a), 0);
  };

  const sim = world.clone(); // the planner NEVER mutates the live world
  const currentMetrics = computeMetrics(sim);
  let currentJ = simJ(currentMetrics, []);
  const J0 = currentJ;
  log.push(`J(damaged, no plan) = ${currentJ.toFixed(2)}`);

  const orderCandidates = (w: NetworkWorld): RecoveryCandidate[] => {
    const base = generateCandidates(w);
    if (!aiRanking || aiRanking.length === 0) return base;
    const rank = new Map<string, number>();
    aiRanking.forEach((c, i) => rank.set(sortKey(c.action), i));
    return [...base].sort((x, y) =>
      (rank.get(sortKey(x.action)) ?? 999) - (rank.get(sortKey(y.action)) ?? 999)
      || sortKey(x.action).localeCompare(sortKey(y.action)));
  };

  const committed: RecoveryAction[] = [];
  let steps = 0;
  while (steps < MAX_SINGLE_ACTIONS) {
    steps++;
    const candidates = orderCandidates(sim);
    // 1st: single-step greedy — first strictly-improving candidate wins
    let didSingle = false;
    for (const c of candidates) {
      const m = simulate(sim, [c.action]);
      if (!m) continue;
      const j = simJ(m, [...committed, c.action]);
      if (j < currentJ - 1e-9) {
        applyAction(sim, c.action);
        committed.push(c.action);
        currentJ = j;
        log.push(`step ${steps}: ${sortKey(c.action)} → J=${j.toFixed(2)}`);
        didSingle = true;
        break;
      }
    }
    if (didSingle) continue;
    // 2nd: bounded pairwise lookahead (chained repairs like node→trunk)
    const cand = candidates.slice(0, MAX_LOOKAHEAD_WIDTH);
    let done = false;
    let bestJ = currentJ;
    let bestPair: [RecoveryAction, RecoveryAction] | null = null;
    for (let i = 0; i < cand.length; i++) {
      for (let j2 = i + 1; j2 < cand.length; j2++) {
        const m = simulate(sim, [cand[i].action, cand[j2].action]);
        if (!m) continue;
        const pairJ = simJ(m, [...committed, cand[i].action, cand[j2].action]);
        if (pairJ < bestJ - 1e-9) {
          bestJ = pairJ;
          bestPair = [cand[i].action, cand[j2].action];
        }
      }
    }
    if (bestPair) {
      applyAction(sim, bestPair[0]);
      applyAction(sim, bestPair[1]);
      committed.push(bestPair[0], bestPair[1]);
      currentJ = bestJ;
      log.push(`step ${steps} (pair): ${sortKey(bestPair[0])} + ${sortKey(bestPair[1])} → J=${bestJ.toFixed(2)}`);
      done = true;
    }
    if (!done) { log.push('no strictly-improving action at this state — plan complete'); break; }
  }

  void J0;
  return {
    committed,
    log,
    plan: {
      actions: committed,
      rationale: committed.length
        ? `Deterministic greedy optimizer selected ${committed.length} action(s) to minimize J.`
        : 'No strictly-improving feasible action found under objective J — nothing committed.',
      source: aiRanking && aiRanking.length ? 'ai-seeded' : 'greedy-optimizer',
      iterations: steps,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Full recovery run (plan → execute → verify → rollback if failed)    */
/* ------------------------------------------------------------------ */


/** Inverts one applied recovery action (used by rollback of a failed plan). */
function invert(world: NetworkWorld, action: RecoveryAction): void {
  switch (action.type) {
    case 'RestoreEdge': { const e = world.edgeById(action.edgeId); if (e) e.state = 'down'; break; }
    case 'RestoreNode': { const n = world.nodeById(action.nodeId); if (n) n.state = 'down'; break; }
    case 'OpenCandidate': { const e = world.edgeById(action.edgeId); if (e) { e.state = 'down'; e.openable = true; } break; }
    case 'Retune': { void world; break; } // retuned latency is a permanent tuning decision; rollback keeps it
  }
}

export function runRecovery(
  world: NetworkWorld,
  healthy: GraphMetrics,
  damaged: GraphMetrics,
  aiRankedCandidates: RecoveryCandidate[] | null,
  t0: number,
): RecoveryOutcome {
  const priorActions = [...world.appliedActions];
  const { plan, log } = buildPlan(world, healthy, aiRankedCandidates);

  // Executor: re-validate each action against CURRENT state, apply, keep trace.
  const executed: RecoveryAction[] = [];
  for (const a of plan.actions) {
    if (validateAction(world, a).ok && applyAction(world, a)) executed.push(a);
  }
  const wallMs = Date.now() - t0;
  const after = computeMetrics(world);
  const verification = verifyRecovery(healthy, damaged, after, { ...plan, actions: executed }, wallMs);

  if (!verification.success) {
    // rollback to damaged state (before this recovery run)
    for (const a of [...executed].reverse()) invert(world, a);
    world.appliedActions = priorActions;
    world.revision++;
    log.push('verification FAILED → plan rolled back to damaged state');
    return {
      plan: { ...plan, actions: executed, rationale: `${plan.rationale} [ROLLED BACK: ${verification.reasons.join('; ')}]` },
      verification,
      revertedPlan: { ...plan, actions: executed },
    };
  }
  return { plan: { ...plan, actions: executed }, verification, revertedPlan: null };
}

/* ------------------------------------------------------------------ */
/* Independent verifier                                                */
/* ------------------------------------------------------------------ */

export function verifyRecovery(
  healthy: GraphMetrics,
  damaged: GraphMetrics,
  after: GraphMetrics,
  plan: RecoveryPlan,
  wallMs: number,
): RecoveryVerification {
  const reasons: string[] = [];
  let success = true;
  if (after.components !== healthy.components) { success = false; reasons.push(`components ${after.components} ≠ healthy ${healthy.components}`); }
  if (after.capacityViolationMbps > 0) { success = false; reasons.push('capacity constraint violated'); }
  if (after.routedMbps + 1e-9 < healthy.routedMbps * 0.9) {
    success = false;
    reasons.push(`throughput ${Math.round(after.routedMbps)} < 90% of healthy ${Math.round(healthy.routedMbps)} Mbps`);
  }
  const latH = healthy.avgShortestPathLatencyMs ?? 0;
  const latA = after.avgShortestPathLatencyMs ?? 0;
  if (latA > latH * 1.25 + 5) { success = false; reasons.push(`avg latency ${latA}ms exceeds healthy ${latH}ms ×1.25`); }
  const deltaLambda2 = ((after.algebraicConnectivity ?? 0) - (damaged.algebraicConnectivity ?? 0));
  return {
    success, reasons,
    before: damaged, after,
    deltaLambda2: Math.round(deltaLambda2 * 1e6) / 1e6,
    planCost: plan.actions.reduce((s, a) => s + actionCost(a), 0),
    wallMs,
  };
}

/* ------------------------------------------------------------------ */
/* AI prompt construction (everything the model sees, nothing more)    */
/* ------------------------------------------------------------------ */

/** top-3 betweenness nodes in the current metrics (deterministic order). */
export function topBottleneckNodes(m: GraphMetrics): { id: string; betweenness: number }[] {
  return Object.entries(m.betweenness)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([id, betweenness]) => ({ id, betweenness }));
}

export function buildAIPrompt(world: NetworkWorld, incident: IncidentReport, candidates: RecoveryCandidate[]): AIPrompt {
  return {
    scenarioId: world.scenario.id,
    graphSummary: {
      nodes: world.nodes.length,
      activeEdges: world.edges.filter((e) => e.state === 'up').length,
      failedNodes: incident.failedNodeIds,
      failedEdges: incident.failedEdgeIds,
      degradedEdges: incident.degradedEdgeIds,
    },
    metrics: {
      baselineLambda2: incident.baseline.algebraicConnectivity,
      damagedLambda2: incident.damaged.algebraicConnectivity,
      baselineComponents: incident.baseline.components,
      damagedComponents: incident.damaged.components,
      baselineAvgLatency: incident.baseline.avgShortestPathLatencyMs,
      damagedAvgLatency: incident.damaged.avgShortestPathLatencyMs,
      servedDemandPairs: incident.damaged.servedDemandPairs,
      totalDemandPairs: incident.damaged.totalDemandPairs,
      capacityViolationMbps: incident.damaged.capacityViolationMbps,
    },
    bottlenecks: [
      ...incident.damaged.bridgeEdgeIds.map((id) => ({ kind: 'bridge' as const, id, note: 'bridge edge in the damaged graph' })),
      ...topBottleneckNodes(incident.damaged).map(({ id, betweenness }) => ({ kind: 'capacity' as const, id, note: `betweenness ${betweenness}` })),
    ],
    feasibleCandidateActions: candidates,
    objectiveJ: {
      alphaRepair: OBJECTIVE.alphaRepair,
      betaLatency: OBJECTIVE.betaLatency,
      gammaCapacity: OBJECTIVE.gammaCapacity,
      deltaDisconnectivity: OBJECTIVE.deltaDisconnectivity,
      hardConstraint: 'capacity violation is forbidden; actions outside the vocabulary are rejected',
    },
  };
}
