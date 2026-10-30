/**
 * AETHER-NIM engine — core types.
 * Pure data structures + operations; no IO so the whole engine is unit-testable.
 */

export type NodeState = 'up' | 'down';
export type EdgeState = 'up' | 'down';

export interface GridNode {
  id: string;
  label: string;
  /** role in the topology: core router, edge router, datacenter, endpoint */
  role: 'core' | 'edge' | 'dc' | 'endpoint';
  state: NodeState;
  /** normalized position in [0,1] for the 2-D canvas layout */
  x: number;
  y: number;
  /** relative importance for incident scoring */
  tier: number;
}

export interface GridEdge {
  id: string;
  a: string; // node id endpoint 1
  b: string; // node id endpoint 2
  label: string;
  latencyMs: number;
  capacityMbps: number;
  /** link reliability in [0,1] — metadata only */
  reliability: number;
  state: EdgeState;
  kind: 'trunk' | 'spur' | 'candidate';
  /** for candidate edges: planner may propose opening this spare corridor */
  openable: boolean;
  /** approved latency floor for the Retune action */
  minLatencyMs?: number;
}

export interface Demand {
  id: string;
  from: string;
  to: string;
  mbps: number;
  priority: number; // higher served first (deterministic tie-break by id)
}

export interface NetworkScenario {
  id: string;
  name: string;
  description: string;
  nodes: GridNode[];
  edges: GridEdge[];
  demands: Demand[];
  seed: number;
}

/** Serialized topology snapshot for API responses / replay. */
export interface TopologySnapshot {
  scenarioId: string;
  scenarioName: string;
  nodes: GridNode[];
  edges: GridEdge[];
  demands: Demand[];
  appliedActions: string[];
  revision: number;
}

/* ---------------- Actions (typed action vocabulary, §6) ---------------- */

export type RecoveryAction =
  | { type: 'RestoreEdge'; edgeId: string }
  | { type: 'RestoreNode'; nodeId: string }
  | { type: 'OpenCandidate'; edgeId: string }
  | { type: 'Retune'; edgeId: string; toLatencyMs: number };

/* ---------------- Metrics ---------------- */

export interface GraphMetrics {
  nodeCount: number;
  activeNodes: number;
  activeEdges: number;
  components: number;
  largestComponentSize: number;
  isolatedNodes: number;
  /** second-smallest eigenvalue of the weighted Laplacian; null when undefined (n<2) */
  algebraicConnectivity: number | null;
  /** sum of Laplacian eigenvalues ≥ λ2 — documented "spectral mass" indicator */
  spectralSum: number;
  avgShortestPathLatencyMs: number | null;
  diameterMs: number | null;
  servedDemandPairs: number;
  totalDemandPairs: number;
  routedMbps: number;
  demandedMbps: number;
  capacityViolationMbps: number;
  /** id → normalized betweenness centrality (active graph, hop-based) */
  betweenness: Record<string, number>;
  /** id → degree (active graph) */
  degree: Record<string, number>;
  bridgeEdgeIds: string[];
}

export interface IncidentReport {
  detectedAt: string;
  failedNodeIds: string[];
  failedEdgeIds: string[];
  degradedEdgeIds: string[];
  summary: string;
  baseline: GraphMetrics;
  damaged: GraphMetrics;
}

export interface ValidationIssue {
  action: RecoveryAction;
  ok: boolean;
  reason?: string;
}

export interface RecoveryCandidate {
  action: RecoveryAction;
  rationale: string;
  estCost: number;
}

export interface RecoveryPlan {
  actions: RecoveryAction[];
  rationale: string;
  source: 'greedy-optimizer' | 'ai-seeded';
  iterations: number;
}

export interface RecoveryVerification {
  success: boolean;
  reasons: string[];
  before: GraphMetrics;
  after: GraphMetrics;
  deltaLambda2: number | null;
  planCost: number;
  wallMs: number;
}

export interface RecoveryOutcome {
  plan: RecoveryPlan;
  verification: RecoveryVerification | null;
  revertedPlan: RecoveryPlan | null; // set when the verifier rolled the plan back
}

/** Full serializable twin state — used for durable cross-isolate persistence. */
export interface TwinState {
  scenarioId: string;
  world: {
    nodes: GridNode[];
    edges: GridEdge[];
    demands: Demand[];
    appliedActions: string[];
    revision: number;
  };
  healthyBaseline: GraphMetrics | null;
  timeline: TimelineEvent[];
  incidentSnapshot: { baseline: GraphMetrics; damaged: GraphMetrics } | null;
  lastRecovery: RecoveryOutcome | null;
  lastAI: unknown;
  lastWeb?: WebEvidenceSummary | null;
}

export type Stage = 'reset' | 'failure_injected' | 'measured' | 'incident_detected'
  | 'diagnosis' | 'ai_request' | 'ai_response' | 'ai_failed'
  | 'candidates' | 'plan_built' | 'action_rejected'
  | 'web_evidence' | 'web_failed'
  | 'verified' | 'scenario_switched';

export interface TimelineEvent {
  at: string;
  stage: Stage;
  message: string;
  detail?: unknown;
  /** proof field for the UI: truthful AI mode ('real' = actual Token Factory call) */
  aiMode?: 'real' | 'fallback';
}

/* -------- passed to the AI: compact report over the REAL measurements -------- */

/* -------- optional web evidence (Tavily) fetched at diagnosis time -------- */

export interface WebEvidenceItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebEvidenceSummary {
  used: boolean;
  query?: string;
  count: number;
  sources?: { title: string; url: string }[];
}

export interface AIPrompt {
  scenarioId: string;
  /** optional live-web context (via Tavily runtime search) for root-cause grounding */
  web_evidence?: WebEvidenceItem[];
  graphSummary: {
    nodes: number;
    activeEdges: number;
    failedNodes: string[];
    failedEdges: string[];
    degradedEdges: string[];
  };
  metrics: {
    baselineLambda2: number | null;
    damagedLambda2: number | null;
    baselineComponents: number;
    damagedComponents: number;
    baselineAvgLatency: number | null;
    damagedAvgLatency: number | null;
    servedDemandPairs: number;
    totalDemandPairs: number;
    capacityViolationMbps: number;
  };
  bottlenecks: { kind: 'bridge' | 'isolated-node' | 'capacity'; id: string; note: string }[];
  feasibleCandidateActions: RecoveryCandidate[];
  objectiveJ: {
    alphaRepair: number;
    betaLatency: number;
    gammaCapacity: number;
    deltaDisconnectivity: number;
    hardConstraint: string;
  };
}

export interface AIResponse {
  incident_summary: string;
  root_cause_hypotheses: string[];
  proposed_actions: {
    action: RecoveryAction;
    rationale: string;
    confidence: number;
  }[];
  reasoning_summary: string;
  expected_outcome: string;
  risks: string[];
  confidence: number;
  verification_requirements: string[];
}
