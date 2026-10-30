/* Deterministic, dependency-free graph algorithms used by AETHER-NIM. */

export function unionFind(n: number): { find: (x: number) => number; union: (a: number, b: number) => void; comps: () => number[] } {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const find = (x: number): number => {
    while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) p[rb] = ra;
  };
  return { find, union, comps: () => [...new Set(Array.from({ length: n }, (_, i) => find(i)))] };
}

/** Hop-based Brandes betweenness for an unweighted adjacency list. */
export function betweenness(n: number, adj: number[][]): number[] {
  const bc = new Float64Array(n);
  const stack = new Int32Array(n);
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    const sigma = new Float64Array(n); sigma[s] = 1;
    const d = new Int32Array(n).fill(-1); d[s] = 0;
    const delta = new Float64Array(n);
    const preds: number[][] = Array.from({ length: n }, () => []);
    let qh = 0, qt = 0; queue[qt++] = s;
    let st = 0;
    while (qh < qt) {
      const v = queue[qh++];
      stack[st++] = v;
      for (const w of adj[v]) {
        if (d[w] < 0) { d[w] = d[v] + 1; queue[qt++] = w; }
        if (d[w] === d[v] + 1) { sigma[w] += sigma[v]; preds[w].push(v); }
      }
    }
    while (st > 0) {
      const w = stack[--st];
      for (const v of preds[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== s) bc[w] += delta[w];
    }
  }
  const norm = n > 2 ? 1 / ((n - 1) * (n - 2)) : 0;
  for (let i = 0; i < n; i++) bc[i] *= norm;
  return Array.from(bc);
}

/** Tarjan bridge detection on undirected disjoint adjacency. */
export function bridges(n: number, adjPair: { list: number[][]; edgeOf: number[][] }): number[] {
  const { list, edgeOf } = adjPair;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const isBridge = new Set<number>();
  let timer = 0;
  const dfs = (u: number, pe: number): void => {
    disc[u] = low[u] = timer++;
    for (let k = 0; k < list[u].length; k++) {
      const v = list[u][k], e = edgeOf[u][k];
      if (e === pe) continue;
      if (disc[v] < 0) { dfs(v, e); low[u] = Math.min(low[u], low[v]); if (low[v] > disc[u]) isBridge.add(e); }
      else low[u] = Math.min(low[u], disc[v]);
    }
  };
  for (let i = 0; i < n; i++) if (disc[i] < 0) dfs(i, -1);
  return [...isBridge];
}

/** Dijkstra returning distance (latency ms) to every node, or Infinity. */
export function dijkstra(n: number, adj: { to: number; ms: number; ei: number }[][], src: number): Float64Array {
  const dist = new Float64Array(n).fill(Infinity);
  dist[src] = 0;
  // small n — use a simple array-based priority scan (deterministic, no heap complexity)
  const done = new Uint8Array(n);
  for (let it = 0; it < n; it++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = 1;
    for (const { to, ms } of adj[u]) if (dist[u] + ms < dist[to]) dist[to] = dist[u] + ms;
  }
  return dist;
}

/**
 * Jacobi symmetric eigensolver.
 * Returns eigenvalues of a symmetric matrix in ascending order.
 * O(n^3) per sweep; n ≤ 32 in all our scenarios so this is fast, exact and deterministic.
 */
export function jacobiEigenvalues(matrix: number[][], tol = 1e-10, maxSweeps = 100): number[] {
  const n = matrix.length;
  const a = matrix.map((r) => r.slice());
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (Math.sqrt(2 * off) < tol) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < tol) { a[p][q] = a[q][p] = 0; continue; }
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const app = a[p][p], aqq = a[q][q], apq = a[p][q];
        a[p][p] = app - t * apq;
        a[q][q] = aqq + t * apq;
        a[p][q] = a[q][p] = 0;
        for (let k = 0; k < n; k++) {
          if (k === p || k === q) continue;
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = a[p][k] = c * akp - s * akq;
          a[k][q] = a[q][k] = s * akp + c * akq;
        }
      }
    }
  }
  return Array.from({ length: n }, (_, i) => a[i][i]).sort((x, y) => x - y);
}
