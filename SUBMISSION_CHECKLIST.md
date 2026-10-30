# Submission checklist

Run in order; every step has been executed at least once with exit code 0.

- [x] `npm run typecheck` — clean
- [x] `npm test` — 20 tests green (unit / integration / resilience)
- [x] `npm run bench` — 18-case report written to `benchmarks/results/latest.json`
- [x] `npm run build` — web + serverless API bundles produced
- [x] Local API smoke test — `/health`, both `/ai/*` and `/api/ai/*` proxy paths → HTTP 200 from Nebius
- [x] Vercel deploy: **production** succeeded, deployment protection disabled
- [x] Live production smoke test (browser, https://aether-nim-vsadhithyan505-5634s-projects.vercel.app):
  - [x] `/api/health` → 200, `aiConfigured: true`
  - [x] POST `/api/ai/chat/completions` → 200 with real completion content
  - [x] damage-preset (bridge-failure) → 2 components, 180/830 Mbps
  - [x] Diagnose → **real** Nemotron call (4.0s, 1162/618 tokens), correct incident summary
  - [x] Run recovery cycle → verifier SUCCESS: 2→1 components, λ₂ 0→5.368, 180→830 Mbps, 5/5 pairs
- [x] No secrets in the repo (`.secrets/`, `.env` gitignored); no third-party platform names in docs

## Devpost
- [ ] repo URL (`www github…`)
- [ ] live demo URL (production, above)
- [ ] demo video link (YouTube, unlisted allowed)
- [ ] "Built with" list
