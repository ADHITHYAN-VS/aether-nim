# AETHER-NIM — Autonomous Spectral Network Resilience Twin

A network **digital twin** that detects infrastructure failures, diagnoses them
with **real NVIDIA Nemotron** inference (Nebius Token Factory), plans a recovery
with a **deterministic graph optimizer**, and **independently verifies** that
every plan actually restored service — rolling back any plan that fails the
verification gate.

Race-condition-free by construction: every candidate plan is scored on a clone;
the executor re-validates each action against the live world; the verifier is a
separate module whose thresholds are the contract, not the planner's word.

## Architecture

ASCII diagram of the closed loop:

```
 ┌─── digital twin (DigitalTwin: graph + state + timeline) ───┐
 │                                                            │
 ▼                                                            │
[measure] scheduler tick → computeMetrics()                    │
 ▼                                                            │
[detect]  detectIncident() — nonZero components/λ2 gap?        │
 ▼                                                            │
[diagnose] Nebius Nemotron (JSON in / JSON out)                │
 │            rough if key missing → deterministic fallback    │
 ▼                                                            │
[propose] validate each AI action against live world           │
 ▼                                                            │
[decide]  planRecovery(): J-objective + greedy lookahead       │
 ▼                                                            │
[execute] applyAction() ×N (re-validated)                      │
 ▼                                                            │
[verify]  verifyRecovery(): independent gates                  │
          │ pass → commit                                      │
          └ fail → rollback: apply inverse actions             │
```

Key invariants (enforced by tests):

- **Actions** are a closed vocabulary — `RestoreEdge / RestoreNode / OpenCandidate / Retune` and never exceed `minLatencyMs` or act on already-active components.
- **Candidates** are always feasible by construction (`generateCandidates` reads only the live graph).
- **Objective J** = 0.01·avgLatency + 400·unmetShare + 500·extraComponents + 50·Δλ2 (spectral deficit) + Σ repair costs. Cap-constrained demand is routed *before* scoring.
- **Verifier** has its own criteria — a plan ships only after `verifyRecovery()` confirms at least one hard gate cleared or J materially dropped.

## Quick start (local)

```bash
cp .env.example .env       # add your Nebius key (runs fine without one too)
npm install
npm run dev                # API on :8787 + Web on :5173
npm test                   # 20 vitest suites (unit + integration + resilience)
npm run bench              # 18-case benchmark vs scripted baselines
```

## Live demo

**Production:** https://aether-nim-vsadhithyan505-5634s-projects.vercel.app

Deployed as a static dashboard plus one stateless serverless function: the whole
twin (graph engine + API) ships in the page bundle, and the single `/api/ai`
proxy keeps the Nebius credential server-side. Each viewer gets an isolated
twin — click a damage preset, diagnose, recover, verify — the AI stage is
*real* Nemotron on Nebius, not a mock.

## Files

```
engine/     pure algorithms (graph, metrics, recovery, damage presets, AI adapter)
server/     Hono API (app.ts), local Node entry, Vercel serverless entry + bundled build
web/        React + Cytoscape canvas dashboard (rank overlay, plan/verify visualization)
            — embeds the engine, so the public demo needs zero server state
benchmarks/ scenarios + baselines runner → JSON results
scripts/    ai-integration-check.ts — end-to-end real-AI proof runner
worker/     optional edge-Workers entry with durable twin state (alternate host)
```
