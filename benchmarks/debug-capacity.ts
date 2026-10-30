import { bridgeFailureScenario } from '../engine/scenarios.js';
import { NetworkWorld } from '../engine/graph.js';
import { computeMetrics } from '../engine/metrics.js';
import { runRecovery, buildPlan, objectiveJ } from '../engine/recovery.js';
import { applyDamage, DAMAGE_PRESETS } from '../engine/damage.js';

const scenario = bridgeFailureScenario();
const healthyWorld = new NetworkWorld(scenario);
const healthy = computeMetrics(healthyWorld);
console.log('healthy', {
  comps: healthy.components, routed: healthy.routedMbps, demanded: healthy.demandedMbps,
  lam2: healthy.algebraicConnectivity, avgLat: healthy.avgShortestPathLatencyMs, served: healthy.servedDemandPairs,
});

// capacity scenario damage
const w = healthyWorld.clone();
applyDamage(w, DAMAGE_PRESETS['capacity-constrained']);
const damaged = computeMetrics(w);
console.log('damaged', {
  comps: damaged.components, routed: damaged.routedMbps,
  lam2: damaged.algebraicConnectivity, avgLat: damaged.avgShortestPathLatencyMs, served: damaged.servedDemandPairs,
  J: objectiveJ(damaged, healthy).J, terms: objectiveJ(damaged, healthy).terms,
});

const { committed, log } = buildPlan(w, healthy, null);
console.log('plan', committed);
console.log('log', log.join('\n'));

const after = computeMetrics(w);
console.log('after', {
  comps: after.components, routed: after.routedMbps, served: after.servedDemandPairs,
  avgLat: after.avgShortestPathLatencyMs, lam2: after.algebraicConnectivity,
  J: objectiveJ(after, healthy).J, terms: objectiveJ(after, healthy).terms,
});

// Full run with verification
const w2 = healthyWorld.clone();
applyDamage(w2, DAMAGE_PRESETS['capacity-constrained']);
const damaged2 = computeMetrics(w2);
const out = runRecovery(w2, healthy, damaged2, null, Date.now());
console.log('verification', out.verification?.success, out.verification?.reasons, 'actions', out.plan.actions);
const m2 = computeMetrics(w2);
console.log('final metrics', { comps: m2.components, routed: m2.routedMbps, served: m2.servedDemandPairs });
