# Architecture & Engineering Case Study

Weekend Road Trip is a dependency-free, single-file HTML5 Canvas game — but the
reason it's in my portfolio isn't the game. It's how it was built and how its
correctness is *proven*: a headless simulation gates every change, and the
hardest feature (a 3-lane dodging system) ships with a **mathematical fairness
invariant** that a machine re-checks on every commit and in CI.

This document is the honest engineering story behind that.

---

## 1. What it is

- **Zero dependencies, no build step.** `index.html` + `styles.css` + `game.js`
  (~3.5k lines, one IIFE). Open the file, it runs. All art is procedural (vector
  + Canvas), all audio is synthesized (Web Audio) — no asset pipeline.
- **Runs everywhere.** Keyboard, gamepad, and touch input parity; DPR-aware
  rendering for crisp output at any zoom/Retina scale; an accessibility pass
  (reduce-motion default, colorblind palette, ARIA, focus management).
- **Provably fair.** Difficulty is data-driven (one `DIFFICULTY` table), and a
  headless physics/balance simulation proves no layout is ever unavoidable.

```
index.html      markup + DOM HUD/menus (screen-space over the canvas)
styles.css      HUD, menus, touch controls, responsive + a11y rules
game.js         the engine: state machine, physics, spawn, collision,
                rendering (5 parallax layers), audio, persistence, ghost race
sim/balance-sim.js   headless Node model of the physics + spawn + economy
qa/run-selftests.js  headless Node persistence/settings/a11y self-tests
.github/workflows/ci.yml  runs both checks on every push / PR
```

---

## 2. The engine, briefly

`game.js` is one closure with clearly sectioned systems:

| System | Responsibility |
|---|---|
| State machine | 11 screens (title/playing/paused/win/gameover/menus) |
| Physics | frame-rate-independent jump integrator; lane tween; auto-throttle |
| Spawn | data-driven, per-lane, pattern-based, with a solvability guarantee |
| Collision | lane-gated AABB with a mid-hop straddle window |
| Rendering | 5 parallax layers, 3-lane road, entities, juice (shake/particles/flash) |
| Audio | procedural engine drone (pitch tracks speed) + one-shot SFX |
| Persistence | localStorage: scores, settings, achievements, ghost replays |
| Ghost race | records per-frame telemetry; export/import JSON for async head-to-head |

Two design choices that carry the rest:

1. **Everything tunable lives in one `DIFFICULTY` table** (per-leg density, gap,
   fuel, speed scale, lane-pattern weights). Balance is *data*, not code paths.
2. **The car is pinned in X; the world scrolls.** Vertical position is
   `laneBaseY − jumpOff`, where the jump integrates in an independent `jumpOff`
   space. This is what lets you change lanes *mid-air* without the jump and the
   lane fighting each other.

---

## 3. The standout: a fairness invariant the machine proves

An endless dodger is only fun if it's *fair* — every obstacle layout must be
survivable with perfect play. With a single lane that's easy. With three lanes
plus jump and duck, "is this layout always solvable?" becomes a real question.

The invariant, enforced constructively in the spawner:

- **R1 — open lane.** A non-layered pattern never blocks all three lanes
  (`maxLaneSpan ≤ 2`), so at least one lane is always clear. The lone exception
  is a *layered* wall — the same single verb in all three lanes (all-jump or
  all-duck) — which is solvable vertically with no lateral escape needed.
- **R2 — per-lane gap.** Within any lane, two blockers are never closer than a
  speed-aware gap `max(table, MIN_GAP_TIME × effSpeed)`. This exceeds the jump
  arc at *every* leg's escalated speed.
- **R3 — lateral reach.** A freshly spawned pattern's lead time exceeds the time
  to cross to the open lane (worst case two 0.16s hops + reaction budget).

`sim/balance-sim.js` is the proof engine. It mirrors the exact physics constants
and runs an *optimal controller* against the densest legal obstacle streams,
asserting **zero collisions** on every leg — plus jump-arc symmetry, a climaxing
difficulty curve, and fuel-economy bands across 500 seeded runs. Ten acceptance
criteria; it exits non-zero if any fails:

```
[2]  no unavoidable blockers ........... PASS
[5]  jump span < min gap (all legs) .... PASS   ← caught a real bug (see below)
     finale is the climax .............. PASS
[6]  lanes solvable (open lane clears).. PASS   BROADWAY lead 0.888s > 0.57s reach
     open lane reachable in time ....... PASS
[7]  skill dominates distance (>=2.5x).. PASS   weaver 7.82x a grinder
     skilled / moderate finish ......... 100% / 99.8%
     careless runs dry ................. 97.6%
```

**The bug the sim caught.** When the lane system raised top speed, the naive
fixed pixel gap (460px) became *smaller than the jump arc* at the escalated
speed (654px) — a layout that would have been physically unsolvable. The
`jumpSpanSafe` assertion failed in design, before any of it shipped. That's the
whole point of the harness: a balance regression is a red build, not a bug
report from a player.

---

## 4. How it was actually built: AI-orchestrated, gate-verified

This is an applied-AI portfolio piece, so the honest headline is the *method*:
the game was extended by orchestrating fleets of AI agents under a human-defined
process, with deterministic gates the agents could not talk their way past.

**Parallel, isolated builds.** Early feature work ran as multiple agents in
separate `git worktree` checkouts, each owning a lane of the codebase (render,
HUD, physics/balance, audio/a11y) against written cross-component contracts
(e.g. the fuel-low rising-edge hook in [BALANCE.md](BALANCE.md) §5 — one side
produces a one-frame flag, the others consume it). Worktree isolation let them
edit in parallel without clobbering each other; the merge order was fixed.

**The lane beta — a worked example of the pipeline:**

1. **Audit (fan-out).** Seven agents independently graded the game across
   dimensions (feel, depth, code, performance, a11y, visuals, portfolio
   readiness), then three design panels proposed roadmaps from different lenses,
   then a synthesis pass merged them into one ranked backlog. The verdict was
   blunt and useful: one repeated decision, a difficulty curve that *relaxed* at
   the finale, an x5 combo that capped in 90 seconds.
2. **Design (judge panel).** Three independent agents each designed the full
   lane system from a different philosophy (arcade purity / engineering rigor /
   systemic depth); a judge synthesized the winner and grafted the best of the
   rest — including the reachable-set fairness formalism. The spec is checked in
   at [`qc/beta-lane-spec.json`](qc/beta-lane-spec.json).
3. **Build (gated pipeline).** Eight commits in a deliberate order — tune-first,
   then a *behavior-preserving* refactor (proven frame-identical), then input,
   then patterns+fairness-sim, then scoring, then render, then docs. Every
   single commit had to leave `sim/balance-sim.js` exit-0 and the self-tests
   green. Refactors and rebalances were never mixed in one commit.
4. **Verify (adversarial).** A 3-lens code review fanned out over the diff and
   *independently re-verified* each finding before it counted; a separate
   headless playtest drove the real game in a browser. Three confirmed bugs
   (a held-key edge-trigger leak, a buffer window shorter than the action it
   buffered, a sim hit over-count) were fixed and re-gated. See
   [`qc/playtest-2026-06-02_lane-beta.md`](qc/playtest-2026-06-02_lane-beta.md).

The throughline: **agents propose; deterministic checks dispose.** Design and
review were parallel and model-driven; correctness was non-negotiable and
machine-verified. No balance claim in this repo rests on vibes — it rests on a
simulation you can run in two seconds.

---

## 5. Testing & CI

```bash
node sim/balance-sim.js     # 10 balance/physics acceptance criteria (exit 0 = pass)
node qa/run-selftests.js    # persistence / settings / a11y self-tests (12 checks)
```

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs both on every push and
PR — the same gate enforced locally on every commit. The QC reports in
[`qc/`](qc/) are the audit trail: each is a real headless play-test with the
method, evidence, and verdict recorded.

---

## 6. If I had more time

- Record a learned ghost (behavioral cloning on the existing per-frame telemetry)
  as an AI rival, with the balance-sim repurposed as the offline eval harness.
- Decompose the single-file engine into ES modules (import maps, still no build).
- An adaptive music bed that intensifies with speed and combo.

These are deliberately *not* claimed as done — the repo only advertises what it
can prove.
