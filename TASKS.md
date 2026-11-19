# TASKS — MINI GTA — OPEN CITY

Status: ✅ done · 🔄 in progress · ⬜ todo · ⚠️ blocked

## Lead Director (Agent 0)
| ID | Task | Status |
|---|---|---|
| L1 | Workspace, toolchain, git repo | ✅ |
| L2 | Frozen contracts (`src/contracts.ts`) + shared layout (`src/world/layout.ts`) | ✅ |
| L3 | Engine / input / camera / audio core | ✅ |
| L4 | M1 foundation scene + browser smoke verification | ✅ |
| L5 | Spawn 4 workers concurrently (world, chars, gameplay, ui) | ✅ |
| L6 | `src/game/game.ts` integration: state machine, spawn, vehicle enter/exit, HUD wiring | 🔄 |
| L7 | Sun/shadows/sky/fog + debug API on `window.__MINI_GTA` | 🔄 |
| L8 | Integrate worker modules, fix interface drift | ⬜ |
| L9 | Independent QA review pass | ⬜ |
| L10 | Perf pass + measured FPS | ⬜ |
| L11 | Production build, ZIP, GitHub Pages deploy + live URL check | ⬜ |

## Agent 1 — World & Environment
| ID | Task | Status |
|---|---|---|
| W1-1 | `cityLayout.ts`: grid constants, road graph, right-hand lanes + arcs | 🔄 |
| W1-2 | `world.ts`: CityWorld, roads, sidewalks, buildings, park, props, lighting fill | 🔄 |
| W1-3 | Collision spatial hash + query API | 🔄 |
| W1-4 | POIs (spawn, missionStart, missionDrop, park, parking) + unit tests | 🔄 |

## Agent 2 — Character & Vehicles
| ID | Task | Status |
|---|---|---|
| W2-1 | `player.ts`: third-person controller, procedural animation, jump, collisions | 🔄 |
| W2-2 | `vehicleModels.ts`: procedural sedan/sport/van | 🔄 |
| W2-3 | `vehicles.ts`: specs, arcade physics (no tunnelling), handbrake, visuals | 🔄 |
| W2-4 | Vehicle-vehicle collision + exit side + unit tests | 🔄 |

## Agent 3 — Gameplay & NPCs
| ID | Task | Status |
|---|---|---|
| W3-1 | `npcs.ts`: pedestrians on loops, traffic on lane graph, avoidance | 🔄 |
| W3-2 | `mission.ts`: The Delivery Run (meet → getVehicle → deliver → complete) | 🔄 |
| W3-3 | `gameState.ts`: money/health helpers | 🔄 |
| W3-4 | Unit tests for mission + NPC bounds | 🔄 |

## Agent 4 — UI, Testing & Delivery
| ID | Task | Status |
|---|---|---|
| W4-1 | `styles.css` design system | 🔄 |
| W4-2 | `hud.ts`: money, health, mission panel, speedo, minimap canvas, toasts, result | 🔄 |
| W4-3 | `menu.ts`: start / controls / pause screens | 🔄 |
| W4-4 | Playwright config + e2e specs, packaging script, docs | 🔄 |

## Integration gates
| Gate | Pass condition | Status |
|---|---|---|
| G1 | `tsc --noEmit` clean | ✅ (foundation) |
| G2 | `vite build` ok | ✅ (foundation) |
| G3 | All 4 modules integrated; browser console clean | ⬜ |
| G4 | Vitest suite green (all units) | ⬜ |
| G5 | Playwright: boot, screens, play, movement, driving, enter/exit, pause, restart | ⬜ |
| G6 | Playwright: mission completable end-to-end | ⬜ |
| G7 | Playwright against `dist/` production build | ⬜ |
| G8 | Live HTTPS URL loads & plays | ⬜ |
