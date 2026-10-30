# Submission checklist

Run in order; every step has been executed at least once with exit code 0.

- [x] `npm run typecheck` — clean
- [x] `npm test` — 20 tests green (unit / integration / resilience)
- [x] `npm run bench` — 18-case report written to `benchmarks/results/latest.json`
- [x] `npm run build` — web + worker bundles produced
- [x] Local workerd (wrangler dev) smoke test — health, damage→recover, verified
- [x] Sites deploy: **preview** + **production** succeeded, both published
- [x] Live production smoke test:
  - [x] `/health` reports `aiConfigured: true`, durable store
  - [x] damage-preset (capacity-constrained) → 2 components, 180/830 Mbps
  - [x] `/api/recover` → RestoreEdge(t4) + OpenCandidate(x1, x2), verified 830/830
  - [x] `/api/diagnose` mode **real** (Nemotron on Nebius, 1162/855 tokens)
- [x] No secrets in the repo (`.secrets/`, `.env` gitignored)

## Devpost
- [ ] repo URL (`www github…`)
- [ ] live demo URL (production)
- [ ] demo video link
- [ ] "Built with" list
