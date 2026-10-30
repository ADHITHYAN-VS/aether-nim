import type {
  GraphMetrics, RecoveryAction, RecoveryCandidate, RecoveryOutcome, TimelineEvent, TopologySnapshot, Stage, TwinState,
} from './types.js';
import { NetworkWorld } from './graph.js';
import { computeMetrics } from './metrics.js';
import { buildAIPrompt, detectIncident, generateCandidates, runRecovery, validateAction } from './recovery.js';
import { ALL_SCENARIOS, scenarioById } from './scenarios.js';
import { DAMAGE_PRESETS, type DamageStep } from './damage.js';
import type { AIAdapter, AIResult } from './ai.js';

function actionKey(a: RecoveryAction): string {
  switch (a.type) {
    case 'RestoreEdge': case 'OpenCandidate': return `${a.type}:${a.edgeId}`;
    case 'RestoreNode': return `RestoreNode:${a.nodeId}`;
    case 'Retune': return `Retune:${a.edgeId}`;
  }
}

/**
 * Twin — one digital-twin instance per scenario. Holds the mutable world and a
 * circular timeline; every metric comes from the engine; the AI stage is an
 * injected AIAdapter so the deterministic core never imports IO.
 */
export class Twin {
  world: NetworkWorld;
  healthyBaseline: GraphMetrics;
  timeline: TimelineEvent[] = [];
  incidentSnapshot: { baseline: GraphMetrics; damaged: GraphMetrics } | null = null;
  lastRecovery: RecoveryOutcome | null = null;
  lastAI: AIResult | null = null;

  constructor(public scenarioId: string, private ai: AIAdapter) {
    const s = scenarioById(scenarioId) ?? ALL_SCENARIOS[0];
    this.scenarioId = s.id;
    this.world = new NetworkWorld(s);
    this.healthyBaseline = computeMetrics(this.world);
    this.log('reset', `Scenario "${s.name}" loaded — healthy baseline measured (λ2=${this.healthyBaseline.algebraicConnectivity ?? 'n/a'})`);
  }

  log(stage: Stage, message: string, detail?: unknown, aiMode?: 'real' | 'fallback'): void {
    this.timeline.push({ at: new Date().toISOString(), stage, message, detail, aiMode });
    if (this.timeline.length > 400) this.timeline.splice(0, this.timeline.length - 400);
  }

  reset(): void {
    this.world.reset();
    this.healthyBaseline = computeMetrics(this.world);
    this.timeline = [];
    this.incidentSnapshot = null;
    this.lastRecovery = null;
    this.lastAI = null;
    this.log('reset', 'Scenario reset to healthy state');
  }

  static scenarioList() {
    return ALL_SCENARIOS.map((s) => ({ id: s.id, name: s.name, description: s.description }));
  }

  /* ---------- injections ---------- */

  applyDamagePreset(presetId: string): boolean {
    const steps = DAMAGE_PRESETS[presetId];
    if (!steps) return false;
    this.inject(steps, `demo damage preset "${presetId}"`);
    return true;
  }

  async inject(steps: DamageStep[], label?: string): Promise<string[]> {
    for (const s of steps) {
      const ok = (() => {
        switch (s.kind) {
          case 'failEdge': return this.world.failEdge(s.id);
          case 'failNode': return this.world.failNode(s.id);
          case 'degradeEdge': return this.world.degradeEdge(s.id, s.latencyFactor);
          case 'shrinkCapacity': return this.world.shrinkCapacity(s.id, s.capacityFactor);
          default: return false;
        }
      })();
      if (ok) {
        const m = computeMetrics(this.world);
        this.log('failure_injected', label ?? `${s.kind} ${'id' in s ? s.id : ''}`, {
          components: m.components, lambda2: m.algebraicConnectivity, routedMbps: m.routedMbps,
        });
        this.incidentSnapshot = null;
      }
    }
    return steps.map((s) => (s.kind === 'failEdge' || s.kind === 'failNode' ? `${s.kind}:${s.id}` : `${s.kind}`));
  }

  restoreComponent(kind: 'node' | 'edge', id: string): boolean {
    const ok = kind === 'node' ? this.world.restoreNode(id) : this.world.restoreEdge(id);
    if (ok) {
      const m = computeMetrics(this.world);
      this.log('measured', `restored ${kind} ${id}`, { components: m.components });
    }
    return ok;
  }

  /* ---------- diagnosis + AI stage ---------- */

  async diagnose(): Promise<{
    incident: ReturnType<typeof detectIncident>;
    candidates: RecoveryCandidate[];
    ai: AIResult | null;
  }> {
    const damaged = computeMetrics(this.world);
    const incident = detectIncident(this.world, this.healthyBaseline, damaged);
    this.incidentSnapshot = { baseline: this.healthyBaseline, damaged };
    this.log('incident_detected', incident.summary, {
      failedNodes: incident.failedNodeIds,
      failedEdges: incident.failedEdgeIds,
      degraded: incident.degradedEdgeIds,
    });

    const candidates = generateCandidates(this.world);
    this.log('candidates', `${candidates.length} feasible candidate action(s) identified`, candidates.map((c) => actionKey(c.action)));

    let ai: AIResult | null = null;
    if (this.ai.enabled()) {
      const prompt = buildAIPrompt(this.world, incident, candidates);
      this.log('ai_request', `Querying ${this.ai.modelId()} on Nebius Token Factory with the structured incident report`, prompt);
      ai = await this.ai.complete(prompt, this.world);
      if (ai.mode === 'real' && ai.parsed) {
        const rejected = ai.rejectedNotes ?? [];
        this.log('ai_response', `Nemotron responded (${ai.latencyMs}ms, ${ai.completionTokens ?? '?'} completion tokens)`, {
          incident_summary: ai.parsed.incident_summary,
          root_cause_hypotheses: ai.parsed.root_cause_hypotheses,
          proposed: ai.parsed.proposed_actions,
          expected_outcome: ai.parsed.expected_outcome,
          risks: ai.parsed.risks,
          confidence: ai.parsed.confidence,
        }, 'real');
        void rejected;
      } else {
        this.log('ai_failed', `AI call failed after ${ai.attempts ?? 1} attempt(s): ${ai.error ?? 'unknown'} — deterministic fallback engaged`, undefined, 'fallback');
      }
      this.lastAI = ai;
    } else {
      this.log('ai_failed', 'AI disabled (no API key) — deterministic fallback engaged', undefined, 'fallback');
      this.lastAI = { mode: 'fallback', model: this.ai.modelId(), error: 'disabled' };
    }
    return { incident, candidates, ai };
  }

  /* ---------- full recovery run ---------- */

  async recover(): Promise<RecoveryOutcome & { incident?: ReturnType<typeof detectIncident>; candidates?: RecoveryCandidate[]; ai?: AIResult | null }> {
    const t0 = Date.now();
    const { incident, candidates, ai } = await this.diagnose();
    if (!incident || !this.incidentSnapshot) throw new Error('diagnosis failed');

    let aiRanked: RecoveryCandidate[] | null = null;
    if (ai?.parsed) {
      const ranked: RecoveryCandidate[] = [];
      const rejected: string[] = [];
      for (const pa of ai.parsed.proposed_actions) {
        const v = validateAction(this.world, pa.action);
        if (!v.ok) { rejected.push(`${JSON.stringify(pa.action)}: ${v.reason}`); continue; }
        ranked.push({ action: pa.action, rationale: pa.rationale, estCost: pa.confidence });
      }
      if (rejected.length) {
        this.log('action_rejected', `${rejected.length} AI-proposed action(s) rejected by the validator`, rejected, 'fallback');
      }
      if (ranked.length) {
        ranked.sort((x, y) => y.estCost - x.estCost);
        aiRanked = ranked;
        this.log('plan_built', `AI ranking accepted: ${ranked.length} feasible action(s) seed the deterministic optimizer`, ranked.map((r) => actionKey(r.action)), 'real');
      }
    }

    const outcome = runRecovery(this.world, this.healthyBaseline, this.incidentSnapshot.damaged, aiRanked, t0);
    this.lastRecovery = outcome;
    this.log('verified',
      outcome.verification?.success
        ? `Recovery SUCCEEDED — independently verified (${outcome.verification.wallMs}ms, cost ${outcome.verification.planCost}, Δλ2=${outcome.verification.deltaLambda2})`
        : `Recovery FAILED and was rolled back: ${(outcome.verification?.reasons ?? []).join('; ')}`,
      outcome.verification);
    return { ...outcome, incident, candidates, ai };
  }

  snapshot(): TopologySnapshot { return this.world.snapshot(); }
  metrics(): GraphMetrics { return computeMetrics(this.world); }
  timelineList(): TimelineEvent[] { return [...this.timeline].reverse(); }

  /* ---------- durable state (cross-isolate persistence) ---------- */

  serialize(): TwinState {
    return {
      scenarioId: this.scenarioId,
      world: {
        nodes: structuredClone(this.world.nodes),
        edges: structuredClone(this.world.edges),
        demands: structuredClone(this.world.demands),
        appliedActions: [...this.world.appliedActions],
        revision: this.world.revision,
      },
      healthyBaseline: this.healthyBaseline,
      timeline: [...this.timeline],
      incidentSnapshot: this.incidentSnapshot ? structuredClone(this.incidentSnapshot) : null,
      lastRecovery: this.lastRecovery,
      lastAI: this.lastAI,
    };
  }

  static restore(state: TwinState, ai: AIAdapter): Twin | null {
    const scenario = scenarioById(state.scenarioId);
    if (!scenario) return null;
    const twin = new Twin(state.scenarioId, ai);
    const { nodes, edges, demands, appliedActions, revision } = state.world;
    if (!Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(demands)) return null;
    twin.world.nodes = nodes;
    twin.world.edges = edges;
    twin.world.demands = demands;
    twin.world.appliedActions = [...appliedActions];
    twin.world.revision = revision;
    if (state.healthyBaseline) twin.healthyBaseline = state.healthyBaseline;
    twin.timeline = Array.isArray(state.timeline) ? state.timeline.slice(-400) : [];
    twin.incidentSnapshot = state.incidentSnapshot ?? null;
    twin.lastRecovery = state.lastRecovery ?? null;
    twin.lastAI = (state.lastAI as AIResult | null) ?? null;
    return twin;
  }
}
