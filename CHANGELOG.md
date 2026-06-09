# Changelog — Weekend Road Trip

All notable changes to the game. Dates are in 2026.

## 2026-06-09 - Feel rework: stable backgrounds, calmer speed, clean composition

A root-cause diagnosis pass (every claim code-verified) behind the player
feedback "the background bobs, everything moves too fast, assets are
translucent/overlapping":

- **Fixed the background "bob"** — three real bugs, not a camera issue: the far
  skyline re-randomized every building's height EVERY FRAME (continuous noise
  seed fully decorrelated per frame; now seeded by stable world-chunk ids), the
  rolling hills snapped to a new silhouette at every parallax wrap (now
  world-anchored so hills keep their shape while scrolling), and screen shake
  translated the whole scene including the sky with fresh white noise each
  frame (now a coherent damped oscillation applied only to the road/gameplay
  layers; nitro pickups no longer shake at all).
- **Calmer speed**: MAX_SPEED 11.0 → 9.0 and all five parallax factors ×0.7;
  fuel drain 1.15/s and the spawn-cadence speed term retuned in lockstep, with
  the sim re-proving all 10 acceptance criteria (skill dominance actually rose
  to 12.6x; moderate finish 100%, careless dry 98.8%).
- **Ghost car is now opt-in**: off by default with a one-time migration for
  saved profiles (re-enabling in Settings sticks); ghost format bumped to v2 so
  replays recorded at the old speeds can't unfairly outrace post-retune runs.
- **Composition cleanup**: roadside props (streetlights, signs, mailboxes,
  rails, neon marquees) moved from mid-road — they anchored to the pre-lane-era
  baseline — onto the far shoulder on a collision-free slot grid; sign boards
  and neon boxes get chevron/dash content instead of rendering as empty
  placeholder panels; Bridgestone Arena is opaque and fits inside its scenery
  period (it ghosted over the next chunk's neon at 0.88 alpha); the Cumberland
  bridge deck no longer has an 80px scrolling hole; Downtown landmarks are
  drawn back-to-front with the Country-Hall wedge in its own slot (no more
  roof slicing through tower windows); biome cross-fade shortened 220 → 80
  units; speed lines and nitro streaks are horizontal and sweep with the world
  (the streaks used to scroll vertically at 1400px/s); semis draw in correct
  depth order between the far and center lanes; dead always-occluded draws
  (crowds, street-level podium) removed.

## 2026-06-09 - Spec-audit closure: calm mode, input parity, ghost hardening

A 13-dimension audit of the full project spec (every claimed gap adversarially
re-verified) found no missing features and eleven partial deviations; this pass
closes the code-level ones and documents the deliberate ones.

- Reduce-motion now gates EVERY canvas motion effect at the source: particle
  spawns (sparks, pickup bursts, dust, exhaust, tire smoke), score-popup drift,
  the combo pill pop-scale, suspension bob, collectible hover, and the nitro
  pickup pulse. The damage flash becomes a steady edge border so hit feedback
  survives calm mode. Locked by a new self-test.
- Title screen attract motion: the live world behind the menu now visibly moves
  (cloud drift + bird flocks) without touching any gameplay state; stays still
  under reduce-motion.
- Gamepad/touch parity: Y toggles the camera and X mutes on gamepad, a CAM
  touch button joins the pause cluster, the d-pad/stick now navigates every
  menu (including Settings and the volume slider), and the initials screen is
  fully playable on pad.
- Combo is now truly uncapped: the count and score multiplier keep climbing
  past 25 (only the SFX pitch ramp clamps); the balance sim mirrors the change
  and skill-vs-distance dominance rose from 7.82x to 10.25x. New self-test.
- Ghost hardening: imported ghosts are rejected above a 20,000-frame cap,
  non-finite fields coerce to safe defaults (Infinity no longer slips through),
  and the FIRST finished run always saves a ghost regardless of distance.
  Locked by two new self-tests.
- Side-view racing stripe honors the run's livery (the chase view already did).
- Docs truthfulness: ARCHITECTURE.md and BALANCE.md regenerated against the
  current code and sim output (7 gates, 19 self-tests, current fuel/combo
  constants); semis-as-ambience and edge-triggered lane hops documented as
  deliberate design choices.

## 2026-06-07 - Visual QA road/parallax cleanup

- Unified every asphalt-painted detail behind `ROAD_SCROLL = 1.0`, so road
  grain, cracks, reflections, light pools, seams, and lane dashes move as one
  coherent road sheet.
- Rebuilt background depth as a clean far-to-near parallax ramp with independent
  cloud, mountain, skyline, mid-scenery, and geo-sign constants.
- Turned off map-like coordinate placards and non-gameplay wayfinding text by
  default while preserving landmark shapes and functional gameplay signs.
- Added a self-test that locks the road/parallax/label constants.

## 2026-06-07 - Seamless chase camera prototype

- Added a `T` camera toggle between the original side view and a behind-the-car
  chase view.
- Built the chase view as a renderer-only projection of the same live obstacles,
  collectibles, pit stops, semis, ghost position, lane state, and collision
  model so gameplay remains one shared level.
- Added a self-test that verifies the camera toggle is reversible and does not
  replace the live physics-owned obstacle/collectible arrays.

## 2026-06-07 - Nashville geo art polish + stability audit

- Added approximate route anchors and on-screen geo plates for Nashville
  landmarks: Ryman/5th, AT&T/333 Commerce, Country Music Hall of Fame/SoBro,
  Music Row studios, Seigenthaler bridge, Nissan Stadium, Bridgestone Arena,
  Lower Broadway, and Riverfront.
- Upgraded the Downtown, Music Row, Cumberland, and Lower Broadway procedural
  art with denser landmark silhouettes, street-grid cues, riverbank details,
  Broadway reflections, and streetlight pools.
- Hardened runtime behavior with bounded VFX arrays, frame-rate-independent
  VFX motion, broader input cleanup on blur/visibility changes, touch pointer
  capture, and a local high-score fallback when cloud save fails.
- Added a high-score client contract that verifies failed cloud saves do not
  leave the player stuck on a saving screen.

## 2026-06-06 - Nashville browser-world art pass

- Rethemed the route from a generic cross-country trip into a Nashville,
  Tennessee cruise: Downtown, Music Row, Cumberland riverfront, and Lower
  Broadway.
- Added code-drawn Nashville scenery: skyline silhouette, twin-spire downtown
  tower, studio bungalows, guitar signage, Cumberland river/bridge layer, and
  Broadway neon storefronts.
- Updated title/win copy, achievement labels/migration, README, submission
  draft, demo guide, rotate prompt, and balance-sim labels so the browser-game
  story stays focused on Music City.

## 2026-06-06 - Final Boss Vercel/Neon hardening

- Removed the retired 3D prototype from the current submission
  branch and replaced the completion flow with score-saving + Ghost Race sharing.
- Added Neon-backed cloud high scores via `api/highscores.js`, with local score
  fallback preserved for GitHub Pages and offline play.
- Added `qa/highscores-contract.js` and `qa/highscores-client-contract.js` so the
  database-backed score API and browser sync path are tested without live Vercel
  credentials.
- Updated final-assignment documentation and proof steps for Vercel production /
  preview screenshots, Road Crew signup storage, and game high-score storage.

## 2026-06-02 — Three-lane system + depth retune (beta) & portfolio wrapper

- **Second decision axis: three lanes.** A/D + ←/→ hop between three lanes with
  a snappy 0.16s tween and a buffered chain window; you can change lanes mid-jump.
  Manual throttle retired — speed auto-escalates per leg.
- **Cross-lane obstacle patterns** (single / wall-with-one-gap / full-width
  layered wall / chicane) with a per-lane solvability invariant: a non-layered
  pattern never blocks all three lanes, and the headless sim *proves* an open
  lane is always reachable in time on every leg.
- **Climaxing difficulty:** per-leg speed escalation + rising pattern complexity
  so Broadway is the fastest, hardest leg.
- **Skill-dominant scoring:** uncapped combo multiplier, near-miss bonuses for
  skimming adjacent-lane hazards, lane-risk bonuses; passive distance trimmed.
- **Engineering rigor surfaced:** balance-sim now asserts 10 criteria incl. lane
  solvability/reachability and skill-dominance; GitHub Actions CI runs the sim +
  self-tests; MIT LICENSE; [ARCHITECTURE.md](ARCHITECTURE.md) case study.
- Built in 8 sim-gated commits via multi-agent orchestration (audit → design
  panel → gated build → adversarial review); 3 review findings fixed.

## 2026-05-29 — Obstacle detail, smoother transitions, dynamic pit stops

- **Obstacles redrawn** (visual only — hitboxes unchanged): potholes get a
  crumbled rim, depth gradient, and radiating cracks; cones get a weighted base,
  lit/shaded gradient body, and reflective bands; the overhead STOP sign gets a
  gantry bar + brackets, a hazard-striped post, a beveled panel, corner bolts,
  and shadowed text.
- **Smoother leg transitions:** the mid-scenery now cross-fades between biomes
  through the transition zone (instead of popping), and the mountain / ground /
  grass / road / dash colours blend toward the next biome too.
- **Dynamic pit stops:** pulsing welcome glow, a chase-blink marquee, a
  flickering price display, a fuel hose, and a little attendant who bobs and
  waves you in. All motion eases off under reduce-motion.
- *Review tuning:* boosted pothole contrast (dark outline + brighter/wider rim +
  stronger cracks) so it reads instantly; eased the peak dusk colour grade ~15%
  so low hazards stay visible; scaled the pit stop ~1.3× for more presence.

## 2026-05-29 — GT hero car + pass-2 polish

- **New player car:** the boxy convertible is replaced by a low GT / Le Mans
  racer body (metallic gradient, carbon splitter/diffuser, raked cockpit, rear
  wing, machined alloy wheels + brake discs, door roundel). It's now the only
  car. Wheels stay planted on the ROAD_SURFACE_Y contact line (no float; body-
  only bob), the body uses the per-run random livery, and the door number is
  randomised each run. Footprint + collision hitbox unchanged.
- **Sunset godrays:** a soft static crepuscular sunburst at sunset/afternoon.
- **Tyre smoke** kicks up from the rear wheel under hard braking at speed.
- **Win celebration:** falling confetti + a score/stat-card reveal on the win
  screen (pure CSS, reduce-motion-safe).
- Story copy updated to match the new body (README/SUBMISSION "red convertible"
  → "red GT"; in-game "convertible" → "car").

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
  density, min blocker gap, and fuel spawn/refill across the four-leg route.
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
  a low-fuel warning that fires on the physics layer's `state.fuelLowJustEntered`.
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
