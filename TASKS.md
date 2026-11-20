# TASKS — MINI GTA — OPEN CITY

Status: ✅ done · 🔄 in progress · ⬜ todo · ⚠️ blocked

## Lead Director (Agent 0)
| ID | Task | Status |
|---|---|---|
| L1 | Workspace, toolchain, git repo | ✅ |
| L2 | Frozen contracts (`src/contracts.ts`) + shared layout (`src/world/layout.ts`) | ✅ |
| L3 | Engine / input / camera / audio core | ✅ |
| L4 | M1 foundation scene + browser verification | ✅ |
| L5 | Spawn 4 workers concurrently; recover their code after early termination | ✅ |
| L6 | `src/game/game.ts` integration: state machine, spawn, vehicle enter/exit, HUD wiring | ✅ |
| L7 | Sun/shadows/sky/fog + debug API on `window.__MINI_GTA` | ✅ |
| L8 | Integrate worker modules, fix interface drift | ✅ |
| L9 | QA review pass (Playwright suite, 11 defects fixed) | ✅ |
| L10 | Perf pass (Firefox 120 FPS; < 160 draw calls) | ✅ |
| L11 | Production build + ZIP (verified from clean extraction) | ✅ |
| L12 | Public HTTPS deploy | ⚠️ blocked on hosting credentials |

## Agent 1 — World & Environment
| ID | Task | Status |
|---|---|---|
| W1-1 | `cityLayout.ts`: grid constants, right-hand lane graph + turn arcs | ✅ (Lead took over after worker crash) |
| W1-2 | `world.ts`: roads, pavements, 21 buildings, park, props, boundary | ✅ |
| W1-3 | Collision spatial hash + query API | ✅ |
| W1-4 | POIs (spawn, missionStart, missionDrop, park, parking) + unit tests | ✅ |
| W1-5 | Instanced windows (`windows.ts`) | ✅ |

## Agent 2 — Character & Vehicles
| ID | Task | Status |
|---|---|---|
| W2-1 | `player.ts`: third-person controller, procedural animation, jump, collisions | ✅ (recovered code, repaired) |
| W2-2 | `vehicleModels.ts`: procedural sedan/sport/van | ✅ |
| W2-3 | `vehicles.ts`: specs, arcade physics, handbrake, visuals, kerb rule | ✅ |
| W2-4 | Vehicle-vehicle collision + exit side + unit tests | ✅ |

## Agent 3 — Gameplay & NPCs
| ID | Task | Status |
|---|---|---|
| W3-1 | `npcs.ts`: pedestrians on loops, traffic on lane graph, avoidance, jacking | ✅ (recovered code, repaired) |
| W3-2 | `mission.ts`: The Delivery Run | ✅ |
| W3-3 | `gameState.ts`: money/health helpers | ✅ |
| W3-4 | Unit tests for mission + NPC bounds | ✅ |

## Agent 4 — UI, Testing & Delivery
| ID | Task | Status |
|---|---|---|
| W4-1 | `styles.css` design system | ✅ (recovered) |
| W4-2 | `hud.ts`: money, health, mission panel, speedo, minimap, toasts, result | ✅ (recovered) |
| W4-3 | `menu.ts` + `dom.ts`: start / controls / pause screens | ✅ (Lead wrote menu.ts) |
| W4-4 | Playwright suite (18 tests), packaging script, docs | ✅ (Lead completed after worker crash) |

## Integration gates
| Gate | Pass condition | Status |
|---|---|---|
| G1 | `tsc --noEmit` clean | ✅ |
| G2 | `vite build` ok | ✅ |
| G3 | All modules integrated; browser console clean | ✅ |
| G4 | Vitest suite green (31/31) | ✅ |
| G5 | Playwright: boot, screens, play, movement, driving, enter/exit, pause, restart | ✅ |
| G6 | Playwright: mission completable end-to-end | ✅ |
| G7 | Playwright against `dist/` production build | ✅ |
| G8 | Live HTTPS URL loads & plays | ⚠️ blocked — needs hosting account |
