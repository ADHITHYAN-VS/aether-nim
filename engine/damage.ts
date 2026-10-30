import type { NetworkWorld } from './graph.js';

export type DamageStep =
  | { kind: 'failEdge'; id: string }
  | { kind: 'failNode'; id: string }
  | { kind: 'degradeEdge'; id: string; latencyFactor: number }
  | { kind: 'shrinkCapacity'; id: string; capacityFactor: number };

/** Named damage presets — the three flagship demo stories, applied by the app and benchmarks. */
export const DAMAGE_PRESETS: Record<string, DamageStep[]> = {
  'bridge-failure': [
    { kind: 'failEdge', id: 't4' },
  ],
  'cascading-degradation': [
    { kind: 'failEdge', id: 't1' },
    { kind: 'failEdge', id: 't2' },
    { kind: 'failEdge', id: 't4' },
    { kind: 'failNode', id: 'e-c1' },
  ],
  'capacity-constrained': [
    { kind: 'failEdge', id: 't4' },
    { kind: 'shrinkCapacity', id: 't1', capacityFactor: 0.25 },
    { kind: 'shrinkCapacity', id: 't2', capacityFactor: 0.25 },
  ],
};

/** Deterministically apply a preset; returns the list of steps that took effect. */
export function applyDamage(world: NetworkWorld, steps: DamageStep[]): string[] {
  const done: string[] = [];
  for (const s of steps) {
    switch (s.kind) {
      case 'failEdge': if (world.failEdge(s.id)) done.push(`failEdge:${s.id}`); break;
      case 'failNode': if (world.failNode(s.id)) done.push(`failNode:${s.id}`); break;
      case 'degradeEdge': if (world.degradeEdge(s.id, s.latencyFactor)) done.push(`degradeEdge:${s.id}:x${s.latencyFactor}`); break;
      case 'shrinkCapacity': if (world.shrinkCapacity(s.id, s.capacityFactor)) done.push(`shrinkCap:${s.id}:x${s.capacityFactor}`); break;
    }
  }
  return done;
}
