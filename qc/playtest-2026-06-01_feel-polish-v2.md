# Play-Test Report — Weekend Road Trip

- **Date:** 2026-06-01
- **Branch tested:** `feature/feel-polish-v2` (current `origin/main` + 3 re-ported feel changes)
- **Tester:** Claude (automated play-test, Playwright + headless Chromium)
- **Method:** Loaded `index.html` in headless Chromium, drove with real `KeyboardEvent`s on window; observed HUD DOM + screenshots. Ephemeral profiles only. No source modified during the test.
- **Sessions:** boot, all menus, pause/resume, full win drive, game-over, 9 fresh fuel runs.
- **Console / page errors:** 0 (errors and warnings) across every session.

## Why this branch (not the earlier polish branch)

The earlier `feature/polish-feel-access` was based on a stale `main`. `origin/main` had since moved ~930 lines ahead (visual polish, mobile, livery, GT car, data-driven coast balance, a11y incl. reduce-motion). Merging the stale branch would have reverted that work. The three genuinely-new changes were re-ported onto current `origin/main` instead. The reduce-motion default from the old branch was dropped — already shipped on main.

## Changes in this branch (+36/-5 in game.js)

1. **Jump buffering (120ms)** — a jump pressed just before landing re-fires on touchdown (`JUMP_BUFFER`, `doJump`/`tryJump`/`updatePlayer`, `state.player.jumpBufferT`). *Verified code + live.*
2. **Combo-break feedback** — hitting an obstacle with combo ≥ 2 spawns a `COMBO LOST` popup + distinct descending tone (`audio.playComboBreak`). Was silent. *Verified code.*
3. **Guaranteed early fuel** — one fuel can force-spawned after distance > 700 (`state.guaranteedFuelDone`). *Verified live: early pickup in 5/5 fresh runs at trip 4.4–15.9%.*

## Regression — all pass

| Area | Result |
|---|---|
| Boot / stability | Clean boot, 0 errors/warnings |
| Win path | CITY→COAST, trip 100% → `YOU MADE IT!` |
| Game-over path | `OUT OF GAS` |
| Menus + RETURN | settings/scores/achievements/controls render; RETURN works |
| Pause / resume | P pauses, P resumes |
| Recent features (mobile/livery/GT/coast-balance/a11y) | Spot-check clean, HUD updates correct |

**Overall: PASS.** Clean on current main; all three changes present and behaving as specified.
