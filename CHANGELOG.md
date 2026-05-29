# Changelog — Weekend Road Trip

All notable changes to the game. Dates are in 2026.

## 2026-05-29 — GT hero car + pass-2 polish

- **New player car:** the boxy convertible is replaced by a low GT / Le Mans
  racer body (metallic gradient, carbon splitter/diffuser, raked cockpit, rear
  wing, machined alloy wheels + brake discs, door roundel). It's now the only
  car. Wheels stay planted on the ROAD_SURFACE_Y contact line (no float; body-
  only bob), the body uses the per-run random livery, and the door number is
  randomised each run. Footprint + collision hitbox unchanged.
- **Sunset godrays:** a soft static crepuscular sunburst at sunset/afternoon.
- Story copy updated ("convertible" → "car") to match the new body.

## 2026-05-29 — Mobile, random livery & visual polish

- **Mobile-friendly:** on-screen touch controls (gas/brake, duck/jump, pause)
  that feed the existing input path; shown only on touch devices during play.
  Larger tap targets, scroll/zoom guards, and a portrait→landscape nudge.
- **Random car livery:** each run paints the car a random colour from a curated
  9-livery pool (red stays in the pool); stored in `state.carStyle`.
- **Visual-polish pass 1** (2D Canvas; no physics/hitbox change):
  - Hero car: metallic body gradient, forward headlight glow, machined 5-spoke
    alloy wheels with a gold centre-lock.
  - Atmospheric distance haze toward the horizon for depth.
  - Cinematic vignette + a subtle per-biome warm/cool grade (eased off under the
    colorblind palette).
  - Juice: poppier pickups with sparkle accents; a pulsing red screen-edge glow
    while fuel is critical (reduce-motion gated).
  - Menu fade/slide entrance, button press feedback, gentle title glow.

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
