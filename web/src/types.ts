/* Mirrors of the engine types as delivered by the API (kept loose on purpose). */

export interface ApiNode { id: string; label: string; role: string; state: 'up' | 'down'; x: number; y: number; tier?: number }
export interface ApiEdge {
  id: string; a: string; b: string; label: string; latencyMs: number; capacityMbps: number;
  state: 'up' | 'down'; kind: 'trunk' | 'spur' | 'candidate'; openable: boolean;
}
export interface ApiDemand { id: string; from: string; to: string; mbps: number; priority: number }

export interface Metrics {
  nodeCount: number; activeNodes: number; activeEdges: number;
  components: number; largestComponentSize: number; isolatedNodes: number;
  algebraicConnectivity: number | null; spectralSum: number;
  avgShortestPathLatencyMs: number | null; diameterMs: number | null;
  servedDemandPairs: number; totalDemandPairs: number;
  routedMbps: number; demandedMbps: number; capacityViolationMbps: number;
  betweenness: Record<string, number>; degree: Record<string, number>;
  bridgeEdgeIds: string[];
}

export interface TimelineEvent {
  at: string; stage: string; message: string;
  detail?: unknown; aiMode?: 'real' | 'fallback';
}

export interface AIInfo {
  mode: 'real' | 'fallback';
  model: string;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  attempts?: number | null;
  error?: string | null;
  parsed?: {
    incident_summary: string;
    root_cause_hypotheses: string[];
    reasoning_summary: string;
    expected_outcome: string;
    risks: string[];
    confidence: number;
    proposed_actions: { action: { type: string; [k: string]: unknown }; rationale: string; confidence: number }[];
    verification_requirements: string[];
  } | null;
}

export interface PlanInfo {
  actions: { type: string; edgeId?: string; nodeId?: string; toLatencyMs?: number }[];
  rationale: string;
  source: string;
  iterations: number;
}

export interface VerificationInfo {
  success: boolean;
  reasons: string[];
  before: Metrics;
  after: Metrics;
  deltaLambda2: number | null;
  planCost: number;
  wallMs: number;
}

export interface WebInfo {
  used: boolean;
  query?: string;
  count: number;
  sources?: { title: string; url: string }[];
}

export interface StateResponse {
  scenario: { id: string; name: string; scenarios: { id: string; name: string; description: string }[]; damagePresets: string[] };
  topology: { nodes: ApiNode[]; edges: ApiEdge[]; demands: ApiDemand[]; revision: number };
  metrics: Metrics;
  healthyBaseline: Metrics;
  incident: { failedNodeIds: string[]; failedEdgeIds: string[]; degradedEdgeIds: string[]; summary: string } | null;
  lastRecovery: { plan: PlanInfo | null; verification: VerificationInfo | null; revertedPlan?: unknown } | null;
  lastAI: AIInfo | null;
  timeline: TimelineEvent[];
  objective: Record<string, unknown>;
  ai: { enabled: boolean; model: string };
  web?: WebInfo | null;
}

export interface RecoverySummary {
  ok: boolean;
  plan: PlanInfo;
  verification: VerificationInfo | null;
  ai: AIInfo | null;
}
