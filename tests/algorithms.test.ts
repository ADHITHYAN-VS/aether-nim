import { describe, it, expect } from 'vitest';
import { jacobiEigenvalues, betweenness, bridges, unionFind } from '../engine/algorithms.js';

describe('jacobiEigenvalues', () => {
  it('matches the known Laplacian spectrum of a path graph P4', () => {
    // L for path 1-2-3-4: eigenvalues 0, 2-2cos(pi/4)... ascending: [0, 0.5858, 2, 3.4142]
    const L = [
      [1, -1, 0, 0],
      [-1, 2, -1, 0],
      [0, -1, 2, -1],
      [0, 0, -1, 1],
    ];
    const eig = jacobiEigenvalues(L);
    expect(eig[0]).toBeCloseTo(0, 9);
    expect(eig[1]).toBeCloseTo(2 - Math.SQRT2, 6); // ≈ 0.5858
    expect(eig[2]).toBeCloseTo(2, 6);
    expect(eig[3]).toBeCloseTo(2 + Math.SQRT2, 6);
  });

  it('returns two zero eigenvalues for two disconnected components', () => {
    // two separate edges: 1-2, 3-4
    const L = [
      [1, -1, 0, 0],
      [-1, 1, 0, 0],
      [0, 0, 1, -1],
      [0, 0, -1, 1],
    ];
    const eig = jacobiEigenvalues(L);
    expect(eig[0]).toBeCloseTo(0, 9);
    expect(eig[1]).toBeCloseTo(0, 6); // λ2 = 0 → disconnected
    expect(eig[2]).toBeCloseTo(2, 6);
  });
});

describe('unionFind + bridges', () => {
  it('bridge detection flags the middle edge of a bowtie graph', () => {
    // a-b-c-d plus e-f, bridge = edge index 1 (b-c)
    const n = 5;
    const list = [[1], [0, 2], [1, 3], [2, 4], [3]];
    const edgeOf = [[0], [0, 1], [1, 2], [2, 3], [3]];
    expect(bridges(n, { list, edgeOf }).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    const u = unionFind(2);
    u.union(0, 1);
    expect(u.comps().length).toBe(1);
  });
});

describe('betweenness', () => {
  it('gives the cut vertex full normalized centrality in a bowtie', () => {
    // star-of-two-cliques: b is the broker
    const n = 3;
    const list = [[1], [0, 2], [1]];
    const bc = betweenness(n, list);
    expect(bc[1]).toBeCloseTo(1, 9); // b lies on the single a-c path
    expect(bc[0]).toBeCloseTo(0, 9);
  });
});
