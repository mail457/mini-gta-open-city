# RELEASE CHECKLIST — MINI GTA — OPEN CITY v1.0.0

Legend: ✅ verified · ❌ blocked · ⬜ not applicable / optional

## Game
- [x] ✅ A real 3D game is implemented (Three.js, procedural low-poly city, 21 buildings, park, roads)
- [x] ✅ Third-person player character is controllable (WASD, sprint, jump, collisions)
- [x] ✅ At least one vehicle can be driven (three types: sedan, sport, van)
- [x] ✅ Vehicles can be entered and exited (E, safely beside the car; traffic cars can be jacked)
- [x] ✅ The city is explorable (10 streets, 25 intersections, park, parking lot, boundaries)
- [x] ✅ Pedestrians (14) walk pavements; traffic (9) follows the lane graph
- [x] ✅ The gameplay mission "The Delivery Run" is completable end to end (automated test)
- [x] ✅ Mission rewards money; result screen with CONTINUE / RESTART
- [x] ✅ Interface: start screen, controls help, HUD (money, health, mission, compass, minimap, speedometer), pause, restart — verified by Playwright
- [x] ✅ Audio (synthesised) and mute

## Quality gates
- [x] ✅ `npm install` works from a clean clone
- [x] ✅ `npm run dev` starts (used throughout development)
- [x] ✅ `npm run build` succeeds (typecheck + Vite)
- [x] ✅ TypeScript strict check passes (0 errors)
- [x] ✅ Unit tests 31/31
- [x] ✅ Browser tests 18/18 in Chromium **and** WebKit (Safari engine)
- [x] ✅ Production build loads when served from `dist/` (also from an extracted ZIP)
- [x] ✅ No uncaught runtime exceptions in any tested flow (asserted in every spec)
- [x] ✅ WebGL rendering initialises (WebGL2 context verified)
- [x] ✅ Performance budget met (Firefox real GPU: 120 FPS, ~2 ms JS/frame, < 160 draw calls)

## Packaging & documentation
- [x] ✅ Distribution ZIP (`release/MINI-GTA-OPEN-CITY-v1.0.0.zip`) — playable without Node
- [x] ✅ README with setup, controls and structure
- [x] ✅ `docs/CONTROLS.md`, `docs/DEPLOYMENT.md`, `docs/QA_MANUAL_CHECKLIST.md`, `TEST_RESULTS.md`
- [x] ✅ Deployment configuration (GitHub Actions workflow for Pages, verified static build)
- [ ] ❌ **Live public HTTPS URL** — blocked on hosting account/credentials (see `BUILD_STATE.md`, `docs/DEPLOYMENT.md`)
- [ ] ⬜ Native Safari.app manual pass — checklist ready for the user (`docs/QA_MANUAL_CHECKLIST.md`)

## Sign-off
- Lead review of all modules: ✅
- Known release-blocking defects: **none** (all blocker/high defects found by QA are fixed; see `TEST_RESULTS.md`)
- Release status: **playable and distributable**; public hosting requires the owner's account action.
