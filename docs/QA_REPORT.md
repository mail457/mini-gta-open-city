# QA REPORT — MINI GTA — OPEN CITY v1.0.0

Independent-quality-pass summary. Full command output and per-test timings are in
[TEST_RESULTS.md](../TEST_RESULTS.md); this report focuses on what was checked, what was found, and what remains open.

## Method

- **Static:** TypeScript strict (`npm run typecheck`), production build (`npm run build`).
- **Unit (Vitest):** deterministic simulation of player physics, vehicle physics, mission state machine, NPC bounds, game state.
- **Browser (Playwright):** the *production build* is served (`vite preview`) and driven in **Chromium**
  (SwiftShader software GL) and **WebKit** (Safari's engine). Every gameplay assertion polls the game's
  `window.__MINI_GTA` debug state; fixed sleeps are avoided because software rendering runs at 10–30 FPS.
- **Manual:** human-scale play-throughs in Firefox (real GPU) and WebKit were performed during development
  (walking, entering, driving, exiting, re-entering, mission completion, pause, restart) as well as in automated form.

## Coverage matrix

| Requirement | How verified | Status |
|---|---|---|
| Loads from production build | `production.spec.ts`, ZIP served in Chromium+WebKit | PASS |
| Player controllable | `controls.spec.ts`, unit tests | PASS |
| Camera follows / orbits | camera update on every frame; mouse-orbit + auto-follow (manual in Firefox) | PASS (auto-follow manual) |
| Enter / exit vehicles | `vehicle.spec.ts`, manual journey (enter → drive → exit → re-enter) | PASS |
| Driving physics | `vehicle.spec.ts`, unit tests (accel, top speed, brake, handbrake, no tunnelling, kerb stop) | PASS |
| City explorable | world unit tests + boot spec (21 buildings, bounds, colliders) | PASS |
| NPCs / traffic bounded | `npcs.test.ts` (600 steps, walkable ground, on-road) | PASS |
| Mission completable | `mission.spec.ts` (Chromium + WebKit) | PASS |
| HUD | `hud.spec.ts` (money, minimap pixels, speedo) | PASS |
| Pause / restart | `pause-restart.spec.ts`, `menu.spec.ts` | PASS |
| No exceptions in tested flows | error collectors in every spec | PASS |
| Safari | WebKit engine | PASS (engine) / native app: manual checklist |
| Live URL | — | **BLOCKED** (hosting credentials) |

## Defects found and fixed

See the "Bugs found and fixed during QA" table in [TEST_RESULTS.md](../TEST_RESULTS.md). Highlights: lost key taps (input edge queue),
teleport lock-up at the world edge, markers inside buildings, cars climbing kerbs, controls BACK doing nothing, money reset on restart,
traffic-car jack crash, mission time always 0:00, removed shadow type in three r187, catch-up-frame teleporting.

## Open risks

1. **Public hosting** — not verified because no public hosting credential is available to this session.
2. **Native Safari.app** — WebKit engine verified; the app itself untested (5-minute manual checklist provided).
3. **Very old GPUs** — adaptive resolution drops to 0.8×; not tested on Intel integrated graphics.
4. **Headless Chromium menu throttling** — a test-environment artefact (real browsers render the menu at full speed;
   Firefox measured at 120 FPS).

## Recommended next actions (priority order)

1. Publish `dist/` via one of the options in `docs/DEPLOYMENT.md` and send the URL.
2. Run `docs/QA_MANUAL_CHECKLIST.md` in Safari and Chrome on the target Mac.
3. If more time is available: add a second mission variant, gamepad support, police heat system.
