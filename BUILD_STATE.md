# BUILD STATE — read this first if resuming the session

## Where things stand (v1.0.0 release candidate)

- **Game:** complete and playable. All original requirements implemented and verified.
- **Tests:** `npm run typecheck` ✅ · `npm test` 31/31 ✅ · `npx playwright test` 18/18 (Chromium + WebKit) ✅
- **Artifacts:** `dist/` (production build), `release/MINI-GTA-OPEN-CITY-v1.0.0.zip` (336 KB, self-contained).
- **LIVE URL:** https://mini-gta-open-city.onrender.com (Render static site, verified playing + full mission in
  Chromium and WebKit). Source: https://github.com/mail457/mini-gta-open-city.
- **Graphics (v1.1 pass):** shader sky with sun disk, procedural sky environment lighting, MSAA + bloom + colour
  grade post-processing, richer skyline; `G` toggles high/low. Firefox on M1: 120 FPS.
- **Blocked / needs the user:**
  1. **Public HTTPS URL.** `gh` has only `repo` scope → only *private* repos can be created, and a private repo's
     Pages site is private. Anonymous Netlify drops are password-protected until claimed. →
     The user should either (a) claim the Netlify drop, (b) drag `dist/` onto <https://app.netlify.com/drop>,
     or (c) run `gh auth refresh -h github.com -s public_repo` and choose GitHub Pages
     (`.github/workflows/deploy.yml` is ready). Full instructions: `docs/DEPLOYMENT.md`.
  2. **Native Safari.app manual pass** — WebKit (Safari's engine) is fully tested; the checklist in
     `docs/QA_MANUAL_CHECKLIST.md` takes ~5 minutes in the real app.

## Quick commands

```bash
cd /Users/axel/code/mini-gta
npm install            # restore dependencies (node_modules is git-ignored)
npm run dev            # http://127.0.0.1:5173
npm run build          # typecheck + production build -> dist/
npm run preview        # serve dist/ on http://127.0.0.1:4173
npm test               # unit tests
npx playwright test    # browser tests (Chromium + WebKit; starts preview automatically)
npm run package        # rebuild + release/MINI-GTA-OPEN-CITY-v1.0.0.zip
```

## History / timeline
- M0–M1 (22:04–22:15): toolchain, frozen contracts, engine/camera/input/audio, foundation scene verified in Chromium.
- M2 (22:15–22:30): four worker agents spawned. All four processes terminated early, but their code was recovered
  from staging folders (player/vehicles, NPCs/mission/gameState, HUD/dom/styles). The World layer was then written
  by the Lead. Files integrated and reconciled against the contracts.
- M3 integration (22:30–23:20): fixed interface drift, input edge queue, teleport/unjam, walkable plazas, POIs.
- M4 (23:20–23:45): mission completable end-to-end in Chromium + WebKit; result screen, money, restart.
- M5 QA (23:45–00:30): Playwright suite written (Chromium + WebKit), 11 real defects found and fixed.
- M6 perf (00:00–00:20): NPC 30 Hz AI, instanced windows, vehicle shadows, adaptive DPR; Firefox 120 FPS.
- M7 delivery (00:20–now): docs, packaging, ZIP verified from a clean extraction, anonymous deploy attempted.

## Interrupted work — candidates
- Native Safari.app automation (needs `safaridriver --enable` + `osascript` UI automation; approval was switched off
  and AppleEvents may be blocked — do not enable it without the user).
- More missions / police / shops (scope beyond the brief).
- Live deployment once credentials exist.
