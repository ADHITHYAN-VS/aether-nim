# TASKS ledger

Format: [ ] open | [x] done | [~] partial — update after each milestone.

## P0 compliance & skeleton
- [x] verify rules (research): Nebius runtime call + NVIDIA open model; video<3min; repo w/ license; equal-weight judging
- [x] environment inspected (Win, Node 22, no Python; Vercel deploy available)
- [ ] runnable skeleton (worker /health + minimal engine mounted)
- [ ] scenario data pack (three named scenarios, seeded)

## P1 mathematical engine
- [ ] graph state + failure injection
- [ ] connectivity metrics (union-find, LCC, isolated, components)
- [ ] algebraic connectivity λ2 via Jacobi eigensolver on weighted Laplacian
- [ ] shortest-path latency avg/diameter, degree + betweenness centrality (Brandes)
- [ ] bridges + failure impact, capacity-aware routing (SSP min-cost flow), served demand/throughput
- [ ] typed action vocabulary + validator + verifier + rollback
- [ ] greedy optimizer minimizing documented objective J
- [ ] vitest unit tests green

## P2 AI integration
- [ ] Nebius TF client w/ timeout+retries, no secret leakage
- [ ] model catalog probe `/v1/models` picks an NVIDIA Nemotron ID
- [ ] structured request/response + strict JSON schema validation vs graph
- [ ] honest fallback: `real` vs `fallback` in trace + UI
- [ ] bounded retry on malformed output (≤2)

## P3 frontend + demo
- [ ] React+Vite+Cytoscape dashboard (graph canvas, metrics, timeline, controls, before/after, explainability)
- [ ] primary demo (Bridge Failure) repeatable end-to-end
- [ ] all controls wired to real backend behavior, empty/error/loading states

## P4 validation & deploy
- [ ] vitest suite + API integration tests pass
- [ ] benchmark suite → benchmarks/results-*.json
- [ ] Vercel deploy + external check of live URL
- [ ] clean repo: README (16 required sections), LICENSE (MIT), .env.example, .gitignore

## P5 submission & video
- [ ] video recorded <3min, YouTube URL
- [ ] Devpost draft complete, submit when user authorizes

## Blockers
- Nebius API key required (P2 real-call proof). Ask user precisely when ready.
