/**
 * AI integration proof — makes a REAL call to Nebius Token Factory.
 * Run with: npx tsx scripts/ai-integration-check.ts
 * Requires NEBIUS_API_KEY in .env. Not part of the unit suite (gated).
 */
import { readFileSync, existsSync } from 'node:fs';
import { NebiusAdapter } from '../engine/ai.js';
import { bridgeFailureScenario } from '../engine/scenarios.js';
import { NetworkWorld } from '../engine/graph.js';
import { computeMetrics } from '../engine/metrics.js';
import { detectIncident, generateCandidates, buildAIPrompt } from '../engine/recovery.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const adapter = new NebiusAdapter({
  apiKey: process.env.NEBIUS_API_KEY,
  model: process.env.NEBIUS_MODEL,
  baseUrl: process.env.NEBIUS_BASE_URL,
});
console.log('configured model:', adapter.modelId(), '| enabled:', adapter.enabled());

const world = new NetworkWorld(bridgeFailureScenario());
world.failEdge('t4');
const baseline = computeMetrics(new NetworkWorld(bridgeFailureScenario()));
const damaged = computeMetrics(world);
const incident = detectIncident(world, baseline, damaged);
const candidates = generateCandidates(world);
const prompt = buildAIPrompt(world, incident, candidates);

console.log('incident:', incident.summary);
console.log('calling Token Factory...');
const res = await adapter.complete(prompt, world);
console.log('mode:', res.mode, '| model:', res.model, '| latencyMs:', res.latencyMs, '| tokens:', res.promptTokens, '/', res.completionTokens, '| attempts:', res.attempts);
if (res.error) console.log('error:', res.error);
if (res.parsed) {
  console.log('incident_summary:', res.parsed.incident_summary);
  console.log('root_causes:', res.parsed.root_cause_hypotheses);
  console.log('proposed:', res.parsed.proposed_actions.map((p) => JSON.stringify(p.action)));
  console.log('expected_outcome:', res.parsed.expected_outcome);
  console.log('confidence:', res.parsed.confidence);
} else if (res.raw) {
  console.log('RAW (first 800 chars):', res.raw.slice(0, 800));
  process.exitCode = 1;
} else {
  process.exitCode = 1;
}
