import type { GridEdge, GridNode, NetworkScenario, TopologySnapshot, Demand } from './types.js';

/**
 * Graph world state.
 * The engine operates only on ACTIVE nodes/edges; a failed component is removed
 * from the analysis graph rather than simulated in place, which keeps every
 * metric (λ2, components, routing) unambiguous.
 * Deterministic: identical action sequences always produce identical state.
 */
export class NetworkWorld {
  readonly scenario: NetworkScenario;
  nodes: GridNode[];
  edges: GridEdge[];
  demands: Demand[];
  appliedActions: string[]; // human-readable audit trail
  revision: number;

  constructor(scenario: NetworkScenario) {
    this.scenario = scenario;
    this.nodes = structuredClone(scenario.nodes);
    this.edges = structuredClone(scenario.edges);
    this.demands = structuredClone(scenario.demands);
    this.appliedActions = [];
    this.revision = 0;
  }

  clone(): NetworkWorld {
    const w = Object.create(NetworkWorld.prototype) as {
      scenario: NetworkScenario;
      nodes: GridNode[];
      edges: GridEdge[];
      demands: Demand[];
      appliedActions: string[];
      revision: number;
    } & NetworkWorld;
    w.scenario = this.scenario;
    w.nodes = structuredClone(this.nodes);
    w.edges = structuredClone(this.edges);
    w.demands = structuredClone(this.demands);
    w.appliedActions = [...this.appliedActions];
    w.revision = this.revision;
    return w;
  }

  reset(): void {
    this.nodes = structuredClone(this.scenario.nodes);
    this.edges = structuredClone(this.scenario.edges);
    this.demands = structuredClone(this.scenario.demands);
    this.appliedActions = [];
    this.revision++;
  }

  nodeById(id: string): GridNode | undefined { return this.nodes.find((n) => n.id === id); }
  edgeById(id: string): GridEdge | undefined { return this.edges.find((e) => e.id === id); }

  /* ---------- injection operations (validated, auditable) ---------- */

  failNode(id: string): boolean {
    const n = this.nodeById(id);
    if (!n || n.state === 'down') return false;
    n.state = 'down';
    this.audit(`fail:node:${id}`);
    return true;
  }

  failEdge(id: string): boolean {
    const e = this.edgeById(id);
    if (!e || e.state === 'down') return false;
    e.state = 'down';
    this.audit(`fail:edge:${id}`);
    return true;
  }

  degradeEdge(id: string, latencyFactor: number): boolean {
    const e = this.edgeById(id);
    if (!e || e.state === 'down') return false;
    e.latencyMs = Math.max(1, Math.round(e.latencyMs * latencyFactor));
    this.audit(`degrade:edge:${id}:latency_x${latencyFactor}`);
    return true;
  }

  shrinkCapacity(id: string, capacityFactor: number): boolean {
    const e = this.edgeById(id);
    if (!e || e.state === 'down') return false;
    e.capacityMbps = Math.max(1, Math.round(e.capacityMbps * capacityFactor));
    this.audit(`degrade:edge:${id}:capacity_x${capacityFactor}`);
    return true;
  }

  restoreNode(id: string): boolean {
    const n = this.nodeById(id);
    if (!n || n.state !== 'down') return false;
    n.state = 'up';
    this.audit(`recover:node:${id}`);
    return true;
  }

  restoreEdge(id: string): boolean {
    const e = this.edgeById(id);
    if (!e || e.state !== 'down') return false;
    e.state = 'up';
    this.audit(`recover:edge:${id}`);
    return true;
  }

  openCandidateEdge(id: string): boolean {
    const e = this.edgeById(id);
    if (!e || !e.openable || e.state !== 'down') return false;
    e.state = 'up';
    e.openable = false;
    this.audit(`open:edge:${id}`);
    return true;
  }

  retune(id: string, toLatencyMs: number): boolean {
    const e = this.edgeById(id);
    if (!e || e.state !== 'up') return false;
    if (e.minLatencyMs !== undefined && toLatencyMs < e.minLatencyMs) return false;
    e.latencyMs = toLatencyMs;
    this.audit(`retune:edge:${id}:${toLatencyMs}`);
    return true;
  }

  private audit(entry: string): void {
    this.appliedActions.push(entry);
    this.revision++;
  }

  snapshot(): TopologySnapshot {
    return {
      scenarioId: this.scenario.id,
      scenarioName: this.scenario.name,
      nodes: this.nodes,
      edges: this.edges,
      demands: this.demands,
      appliedActions: [...this.appliedActions],
      revision: this.revision,
    };
  }
}
