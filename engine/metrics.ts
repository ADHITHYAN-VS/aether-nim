import type { GraphMetrics } from './types.js';
import type { NetworkWorld } from './graph.js';
import { betweenness, bridges, dijkstra, jacobiEigenvalues, unionFind } from './algorithms.js';

/**
 * computeMetrics — the single measurement primitive.
 * Called by the detector, the optimizer and the independent verifier so the
 * closed loop is honest: every number on screen comes from this function.
 *
 * Connection strength (documented mapping, NOT raw latency as weight):
 *   w(e) = capacityMbps / (latencyMs + 1) — higher bandwidth and lower latency
 *   mean a stronger logical connection. λ2 is the second-smallest eigenvalue of
 *   the weighted Laplacian L = D - A over active nodes/edges.
 *
 * Capacity routing: demands are served greedily in priority order (deterministic
 * id tie-break) over minimum-latency live paths with residual capacity — a
 * transparent successive-shortest-paths router. Routing never overloads a link,
 * so capacityViolation is structurally zero; the verifier re-checks it.
 */
export function computeMetrics(world: NetworkWorld): GraphMetrics {
  const allNodes = world.nodes;
  const activeIds: string[] = [];
  const idxA = new Map<string, number>();
  allNodes.forEach((nd) => {
    if (nd.state === 'up') { idxA.set(nd.id, activeIds.length); activeIds.push(nd.id); }
  });
  const N = activeIds.length;

  const activeEdges = world.edges.filter((e) => {
    if (e.state !== 'up') return false;
    const ia = idxA.get(e.a), ib = idxA.get(e.b);
    return ia !== undefined && ib !== undefined;
  });

  if (N === 0) {
    return {
      nodeCount: allNodes.length, activeNodes: 0, activeEdges: 0,
      components: 0, largestComponentSize: 0, isolatedNodes: 0,
      algebraicConnectivity: null, spectralSum: 0,
      avgShortestPathLatencyMs: null, diameterMs: null,
      servedDemandPairs: 0, totalDemandPairs: world.demands.length,
      routedMbps: 0, demandedMbps: world.demands.reduce((s, d) => s + d.mbps, 0),
      capacityViolationMbps: 0, betweenness: {}, degree: {}, bridgeEdgeIds: [],
    };
  }

  const adjList: number[][] = Array.from({ length: N }, () => []);
  const edgeOf: number[][] = Array.from({ length: N }, () => []);
  const adjWeighted: { to: number; ms: number; ei: number }[][] = Array.from({ length: N }, () => []);
  activeEdges.forEach((e, ei) => {
    const ia = idxA.get(e.a)!, ib = idxA.get(e.b)!;
    adjList[ia].push(ib); adjList[ib].push(ia);
    edgeOf[ia].push(ei); edgeOf[ib].push(ei);
    adjWeighted[ia].push({ to: ib, ms: e.latencyMs, ei });
    adjWeighted[ib].push({ to: ia, ms: e.latencyMs, ei });
  });

  /* connectivity */
  const uf = unionFind(N);
  for (const e of activeEdges) uf.union(idxA.get(e.a)!, idxA.get(e.b)!);
  const roots = new Set<number>();
  const compSize = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    const r = uf.find(i);
    roots.add(r);
    compSize.set(r, (compSize.get(r) ?? 0) + 1);
  }
  const largestComponentSize = Math.max(0, ...compSize.values());
  const isolatedNodes = activeIds.filter((id) => adjList[idxA.get(id)!].length === 0).length;

  /* spectral: weighted Laplacian L = D - A */
  const L = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (const e of activeEdges) {
    const ia = idxA.get(e.a)!, ib = idxA.get(e.b)!;
    const w = e.capacityMbps / (e.latencyMs + 1);
    L[ia][ib] -= w; L[ib][ia] -= w;
    L[ia][ia] += w; L[ib][ib] += w;
  }
  const eig = jacobiEigenvalues(L);
  const lambda2 = N >= 2 ? Math.max(0, round6(eig[1])) : null;

  /* shortest-path latency over reachable ordered pairs (both directions counted once) */
  let pairSum = 0, pairCount = 0, diameter = 0;
  for (let s = 0; s < N; s++) {
    const dist = dijkstra(N, adjWeighted, s);
    for (let t = s + 1; t < N; t++) {
      if (dist[t] !== Infinity) {
        pairSum += dist[t]; pairCount++;
        if (dist[t] > diameter) diameter = dist[t];
      }
    }
  }

  /* demand routing: priority desc, id asc tiebreak.
   * Capacity-aware multi-path router (documented): each demand repeatedly takes
   * the current least-latency live path with residual capacity (≤ MAX_PATHS
   * continuations) until fully served or no feasible path remains. This models
   * traffic reallocation within hard capacity limits — the router never
   * overbooks an edge. */
  const residual = new Map<string, number>(activeEdges.map((e) => [e.id, e.capacityMbps]));
  const demands = [...world.demands].sort((x, y) => y.priority - x.priority || x.id.localeCompare(y.id));
  const demanded = demands.reduce((s, d) => s + d.mbps, 0);
  let routedMbps = 0, served = 0;
  const MAX_PATHS = 4;
  for (const d of demands) {
    const s = idxA.get(d.from), t = idxA.get(d.to);
    if (s === undefined || t === undefined) continue;
    let remaining = d.mbps;
    for (let attempt = 0; attempt < MAX_PATHS && remaining > 1e-9; attempt++) {
      const pathEi = leastLatencyPath(N, adjWeighted, s, t, (ei) => (residual.get(activeEdges[ei].id) ?? 0) > 0);
      if (!pathEi) break;
      const minRes = Math.min(...pathEi.map((ei) => residual.get(activeEdges[ei].id)!));
      if (minRes <= 0) break;
      const take = Math.min(remaining, minRes);
      for (const ei of pathEi) residual.set(activeEdges[ei].id, residual.get(activeEdges[ei].id)! - take);
      remaining -= take;
      routedMbps += take;
    }
    if (remaining <= 1e-9) served++;
  }

  const deg: Record<string, number> = {};
  const btw: Record<string, number> = {};
  const bcArr = betweenness(N, adjList);
  for (let i = 0; i < N; i++) {
    deg[activeIds[i]] = adjList[i].length;
    btw[activeIds[i]] = Math.round(bcArr[i] * 1e4) / 1e4;
  }
  const brIds = bridges(N, { list: adjList, edgeOf }).map((ei) => activeEdges[ei].id);

  return {
    nodeCount: allNodes.length,
    activeNodes: N,
    activeEdges: activeEdges.length,
    components: roots.size,
    largestComponentSize,
    isolatedNodes,
    algebraicConnectivity: lambda2,
    spectralSum: round6(eig.slice(1).reduce((s, v) => s + Math.max(0, v), 0)),
    avgShortestPathLatencyMs: pairCount ? round3(pairSum / pairCount) : null,
    diameterMs: pairCount ? round3(diameter) : null,
    servedDemandPairs: served,
    totalDemandPairs: demands.length,
    routedMbps: round3(routedMbps),
    demandedMbps: demanded,
    // routing is capacity-aware by construction; keep zero unless a future path
    // type allows overbooking — the verifier treats >0 as automatic failure.
    capacityViolationMbps: 0,
    degree: deg,
    betweenness: btw,
    bridgeEdgeIds: brIds,
  };
}

/** Deterministic Dijkstra with a residual predicate; returns edge indices on the path or null. */
function leastLatencyPath(
  N: number,
  adj: { to: number; ms: number; ei: number }[][],
  s: number, t: number,
  usable: (ei: number) => boolean,
): number[] | null {
  const dist = new Float64Array(N).fill(Infinity);
  const prevEi = new Int32Array(N).fill(-1);
  const prev = new Int32Array(N).fill(-1);
  dist[s] = 0;
  const done = new Uint8Array(N);
  for (let it = 0; it < N; it++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0 || u === t) break;
    done[u] = 1;
    for (const { to, ms, ei } of adj[u]) {
      if (!usable(ei)) continue;
      if (dist[u] + ms < dist[to]) { dist[to] = dist[u] + ms; prev[to] = u; prevEi[to] = ei; }
    }
  }
  if (dist[t] === Infinity) return null;
  const path: number[] = [];
  let w = t;
  while (w !== s) {
    if (prev[w] < 0) return null;
    path.push(prevEi[w]);
    w = prev[w];
  }
  return path.reverse();
}

function round6(v: number): number { return Math.round(v * 1e6) / 1e6; }
function round3(v: number): number { return Math.round(v * 1e3) / 1e3; }
