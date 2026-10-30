import type { GridEdge, GridNode, NetworkScenario, Demand } from './types.js';

/** Deterministic seeded PRNG (mulberry32) so every scenario rebuild is identical. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function node(id: string, label: string, role: GridNode['role'], x: number, y: number, tier: number): GridNode {
  return { id, label, role, state: 'up', x, y, tier };
}

function edge(id: string, a: string, b: string, latencyMs: number, capacityMbps: number, kind: GridEdge['kind'] = 'trunk'): GridEdge {
  return {
    id, a, b, label: `${a}–${b}`,
    latencyMs, capacityMbps,
    reliability: 0.95,
    state: 'up', kind,
    openable: false,
    minLatencyMs: Math.round(latencyMs * 0.6),
  };
}

/**
 * Metro digital-twin topology, 17 nodes / 25 links, hand-placed for a legible
 * dashboard. Deliberate cut structure (verified by unit tests):
 *
 *  - West region (full mesh ring + spurs) attaches to the Metro Hub via two
 *    trunks t1, t2. East region attaches ONLY via trunk t4 → t4 is a genuine
 *    bridge edge, so a single failure splits the network ("Bridge Failure").
 *  - Failing t1+t2+t4 plus node e-c1 strands three components and isolates the
 *    hub ("Cascading Degradation"); recovery needs a RestoreNode + RestoreEdge
 *    sequence, and order matters (t4 is dead until e-c1 is restored).
 *  - Shrinking t1/t2 to 25% while t4 is failed makes simple reconnection
 *    insufficient: cross-region demand cannot fit, so the optimizer must ALSO
 *    open an approved spare corridor x1 ("Capacity-Constrained Recovery").
 *  - x1/x2 are pre-approved spare corridors (kind=candidate, openable), the
 *    only links the planner may add. Retune may only lower latency down to the
 *    edge's approved minLatencyMs.
 */
function buildMetro(): { nodes: GridNode[]; edges: GridEdge[]; demands: Demand[] } {
  const nodes: GridNode[] = [
    // West region
    node('w-dc1', 'West DC-1', 'dc', 0.12, 0.40, 1),
    node('w-dc2', 'West DC-2', 'dc', 0.16, 0.68, 1),
    node('w-c1', 'West Core A', 'core', 0.23, 0.50, 2),
    node('w-c2', 'West Core B', 'core', 0.30, 0.26, 2),
    node('w-c3', 'West Core C', 'core', 0.31, 0.74, 2),
    node('w-e1', 'West Edge 1', 'edge', 0.10, 0.20, 3),
    node('w-e2', 'West Edge 2', 'edge', 0.09, 0.52, 3),
    node('w-e3', 'West Edge 3', 'edge', 0.40, 0.12, 3),
    // East region
    node('e-dc1', 'East DC-1', 'dc', 0.87, 0.42, 1),
    node('e-dc2', 'East DC-2', 'dc', 0.83, 0.70, 1),
    node('e-c1', 'East Core A', 'core', 0.74, 0.52, 2),
    node('e-c2', 'East Core B', 'core', 0.68, 0.28, 2),
    node('e-c3', 'East Core C', 'core', 0.66, 0.76, 2),
    node('e-e1', 'East Edge 1', 'edge', 0.90, 0.20, 3),
    node('e-e2', 'East Edge 2', 'edge', 0.92, 0.52, 3),
    node('e-e3', 'East Edge 3', 'edge', 0.60, 0.88, 3),
    // Bridging tier
    node('hub', 'Metro Hub', 'core', 0.50, 0.48, 1),
  ];

  const rng = mulberry32(20271013);
  const jit = (base: number) => Math.round(base * (0.9 + 0.2 * rng()));

  const edges: GridEdge[] = [];
  // West ring (closes the loop) + west spurs
  const westRing = ['w-dc1', 'w-dc2', 'w-c3', 'w-c1', 'w-c2', 'w-e1', 'w-dc1'];
  for (let i = 0; i < westRing.length - 1; i++) {
    edges.push(edge(`wr${i + 1}`, westRing[i], westRing[i + 1], jit(12), 900));
  }
  edges.push(edge('wi1', 'w-c1', 'w-e2', jit(10), 800));
  edges.push(edge('wi2', 'w-c2', 'w-c3', jit(10), 800));
  edges.push(edge('wi3', 'w-c3', 'w-e3', jit(12), 700));
  // East ring path + east spurs  (NOTE: east "ring" is open — e-dc2 hangs off e-e3)
  const eastRing = ['e-dc1', 'e-e1', 'e-c2', 'e-c1', 'e-c3', 'e-e3', 'e-dc2'];
  for (let i = 0; i < eastRing.length - 1; i++) {
    edges.push(edge(`er${i + 1}`, eastRing[i], eastRing[i + 1], jit(12), 900));
  }
  edges.push(edge('ei1', 'e-c1', 'e-e2', jit(10), 800));
  edges.push(edge('ei2', 'e-c2', 'e-e2', jit(10), 800));
  // Trunks: west ↔ hub (t1, t2), hub ↔ east (t4 ONLY → genuine bridge)
  edges.push(edge('t1', 'w-c1', 'hub', 18, 1000));
  edges.push(edge('t2', 'w-c2', 'hub', 22, 800));
  edges.push(edge('t4', 'hub', 'e-c1', 21, 900));
  // Approved spare corridors (decommissioned; planner may open them)
  edges.push({ ...edge('x1', 'w-c2', 'e-c2', jit(55), 500, 'candidate'), state: 'down', openable: true });
  edges.push({ ...edge('x2', 'w-c3', 'e-c3', jit(60), 500, 'candidate'), state: 'down', openable: true });

  const demands: Demand[] = [
    { id: 'd1-wdc2edc', from: 'w-dc1', to: 'e-dc1', mbps: 300, priority: 3 },
    { id: 'd2-wc2ec2', from: 'w-c2', to: 'e-c2', mbps: 200, priority: 2 },
    { id: 'd3-we1ee1', from: 'w-e1', to: 'e-e1', mbps: 150, priority: 1 },
    { id: 'd4-west-internal', from: 'w-dc2', to: 'w-dc1', mbps: 100, priority: 1 },
    { id: 'd5-east-internal', from: 'e-dc2', to: 'e-dc1', mbps: 80, priority: 1 },
  ];
  return { nodes, edges, demands };
}

export function bridgeFailureScenario(): NetworkScenario {
  return {
    id: 'bridge-failure',
    name: 'Bridge Failure',
    description:
      'A metro-region twin in which trunk t4 is the bridge between the East region and Metro Hub. ' +
      'Failing t4 splits the network; the workflow measures the λ2 collapse, diagnoses the cut edge, ' +
      'and restores it (the cheapest feasible repair, verified independently).',
    seed: 20271013,
    ...buildMetro(),
  };
}

export function cascadingDegradationScenario(): NetworkScenario {
  return {
    id: 'cascading-degradation',
    name: 'Cascading Degradation',
    description:
      'Multiple simultaneous failures: trunk satellites t1, t2, t4 all fail AND east core node e-c1 goes down. ' +
      'Three components appear and the hub is isolated. Reconnecting requires restoring the node first — ' +
      'restoring t4 while e-c1 is down is a no-op that the optimizer must discover.',
    seed: 20271013,
    ...buildMetro(),
  };
}

export function capacityConstrainedScenario(): NetworkScenario {
  return {
    id: 'capacity-constrained',
    name: 'Capacity-Constrained Recovery',
    description:
      'Trunk t4 fails while t1/t2 run at 25% capacity. Restoring t4 reconnects the graph but the surviving ' +
      'west↔hub capacity (500 Mbps) cannot carry the 650 Mbps cross-region demand: the verifier rejects ' +
      'reconnection-alone. The optimizer must also open approved spare corridor x1.',
    seed: 20271013,
    ...buildMetro(),
  };
}

export const ALL_SCENARIOS: NetworkScenario[] = [
  bridgeFailureScenario(),
  cascadingDegradationScenario(),
  capacityConstrainedScenario(),
];

export function scenarioById(id: string): NetworkScenario | undefined {
  return ALL_SCENARIOS.find((s) => s.id === id);
}
