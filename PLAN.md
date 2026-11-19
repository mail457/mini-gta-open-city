# PLAN — MINI GTA — OPEN CITY

Objective: a tested, playable, distributable third-person open-city game, shareable via HTTPS URL.

## Milestones

| # | Milestone | Gate |
|---|---|---|
| M0 | Workspace + toolchain + contracts | `tsc` clean, Vite dev server serves page |
| M1 | **Minimal playable foundation** | 3D scene renders, player moves, camera orbits, no console errors |
| M2 | Parallel development (4 workers) | each module passes its own acceptance criteria + typecheck |
| M3 | Integration | all systems in one loop; console clean |
| M4 | Mission completable end-to-end | automated Playwright proof |
| M5 | QA & repair | independent reviewer sign-off, zero blocker defects |
| M6 | Performance | 60 FPS desktop target, measured |
| M7 | Delivery | `dist/`, ZIP, README, deploy config, HTTPS URL |

## Scope decisions (Lead)
- 5×5 city grid → 6 N-S + 6 E-W streets with 3-lane arterials, 36 intersections.
- 3 vehicle types: sedan, sport (fast/loose), van (slow/stable).
- 1 mission ("The Delivery Run"): on-foot meet → enter vehicle → drive to drop-off → reward. Timer + minimap + waypoints.
- Free roam always available; missions replayable from the pause menu and marker.
- No backend, no accounts, no analytics.

## Risk register
| Risk | Mitigation |
|---|---|
| WebGL unavailable | Graceful error screen with instructions |
| Pointer lock blocked (Safari) | Game fully playable without lock; click canvas to lock |
| Low-end GPU | Adaptive pixel ratio, merged geometry, static shadows |
| Merge conflicts | Disjoint file ownership per agent |
