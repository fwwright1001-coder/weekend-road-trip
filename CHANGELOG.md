# Changelog — Weekend Road Trip

All notable changes to the game. Dates are in 2026.

## 2026-05-28 — Integrated release (four parallel workstreams + art pass)

First fully-integrated build. Four independent feature branches (PRs #9–#12),
each built and reviewed in isolation, merged into `main` with conflicts resolved
and the whole system re-audited end to end.

### Rendering — crisp HiDPI canvas (PR #9)
- Canvas renders at native device resolution (sharp on Retina/HiDPI and large or
  maximized windows) instead of being CSS-upscaled.
- All gameplay/draw math stays in a fixed logical **960×540** space (`VIEW_W`/
  `VIEW_H`; `W`/`H` are aliases — zero gameplay change). `applyViewTransform()`
  maps logical→device every frame; device-pixel-ratio clamped to `[1, 3]`;
  re-sharpens on resize / orientation change / DPR change. No hitbox change.

### HUD & toasts — legibility + responsiveness (PR #11)
- Fixed the **COMBO** toast overlapping the TRIP card; combo/score/achievement
  toasts repositioned with dark backplates + halos and kept clear of the HUD
  card band, at the toast's full pop scale.
- HUD scales as one unit via a container query; cards stay a constant fraction
  of the canvas across window sizes. Toast colors are palette-aware.

### Gameplay, physics & balance (PR #12)
- **Ground contact:** wheels and shadow rest on an explicit contact line
  (`CAR_FOOT_OFFSET` / `ROAD_SURFACE_Y`); the bob wobbles the body only. Jump
  arc is symmetric and lands flush. Hitbox unchanged.
- **De-clustering:** enforces a per-leg minimum gap between blocking obstacles,
  so there are never unavoidable back-to-back blockers at top speed.
- **Data-driven difficulty:** one `DIFFICULTY[]` row per leg controls obstacle
  density, min blocker gap, and fuel spawn/refill — tightening CITY→COAST.
- **Balance decision (signed off):** pit stops give a **partial** refuel
  (`PITSTOP_REFILL = 40`) and `HIT_FUEL_PENALTY = 14`, so a careless run can
  still run dry. Full pit-stop refuel is a one-line revert but makes the lose
  condition unreachable. Verified by a 500-seed sweep in `sim/balance-sim.js`
  (skilled finish 100%, careless dry ~90%).
- Produces read-only `state.fuelLow` / `state.fuelLowJustEntered` for audio.

### Audio, accessibility & settings (PR #10)
- **Unified persistence:** every setting lives in one `localStorage` key
  `wrt.settings.v1` — screen shake, colorblind palette, ghost car, **mute,
  SFX on/off, master volume, reduce-motion**. Loaded on startup, applied
  instantly, bad payloads clamped; legacy `wrt.muted.v1` migrated as a
  read-only seed; `prefers-reduced-motion` seeds the default.
- **Settings UI:** master-volume slider + SFX / mute / reduce-motion rows.
- **Audio:** a single shared `AudioContext` created only on the first user
  gesture (no autoplay-policy errors); mute + master volume via a master-gain
  bus; the SFX toggle gates one-shots. New effects: duck, combo milestone, and
  a low-fuel warning that fires on Bot 3's `state.fuelLowJustEntered`.
- **Accessibility:** visible `:focus-visible` ring on every control; canvas
  `role="img"` with a live state `aria-label`; HUD fuel/trip bars exposed as
  ARIA progressbars; a polite screen-reader live region announces screen /
  leg / low-fuel / outcome; focus moves into each menu on screen change.
  `reduce-motion` disables screen shake, speed lines, and CSS motion.
- **QA harness:** `runSelfTests()` (console-callable, auto-runs under DEBUG)
  plus a headless `qa/run-selftests.js` that exercises the real `game.js`.

### Art
- Fuel cans redrawn as a stereotypical red **NATO jerry can** — embossed
  X-brace, pour spout + cap, and a carry handle — drawn procedurally in logical
  space (no asset, no hitbox/spawn change). The colorblind palette keeps the can
  **blue** (red is the hazard color), and the distinctive shape means fuel is
  identifiable without relying on color.

### Verification
- `node --check game.js` — clean.
- `node qa/run-selftests.js` — **12/12 pass**.
- `node sim/balance-sim.js` — **all criteria met**.
- Full adversarial multi-agent audit of the integrated build — no unresolved
  defects (one blocker found and fixed: an uncommitted test-harness shim).

Built as a four-bot parallel exercise for ENGR 5513 — Applied AI in Engineering,
Lipscomb MSAI (Summer 2026). — Forrest Wright
