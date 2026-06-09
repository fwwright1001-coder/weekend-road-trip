# Balance & Physics Rationale

Scope: gameplay tuning, physics, and difficulty balance in `game.js`. No changes to
canvas resolution, HUD/CSS, or audio/menus.

All numbers below are produced by `node sim/balance-sim.js`, a deterministic headless
harness that **mirrors the exact constants and core update math in `game.js`**. It is
the reviewable stand-in for "a recorded clean-finish run + a fail run".

---

## 1. Car ground-contact fix (the "float")

**Symptom:** the car sometimes appeared to hover above the road during normal driving.

**Root cause:** `drawPlayer()` added a sinusoidal `bob` (scaled by speed) to the *whole
car including the wheels*, while the shadow was pinned at a fixed `GROUND_Y + 18`. So
the wheels rose off their own shadow up to ~1px (more at speed) on every bob cycle —
an intermittent, speed-dependent hover. There was also a static ~2px gap (wheel bottom
448 vs shadow 450).

**Fix:** made the contact geometry explicit and planted the wheels.

| Constant | Value | Meaning |
|---|---|---|
| `GROUND_Y` | 432 | physics anchor (resting `player.y`) + scenery datum — unchanged |
| `CAR_FOOT_OFFSET` | 18 | px from `player.y` down to the wheel-contact line |
| `ROAD_SURFACE_Y` | 450 | where tyres **and** shadow rest on the asphalt |

In `drawPlayer()` the wheels are now locked to `ROAD_SURFACE_Y - lift` (where
`lift = GROUND_Y - player.y`), the shadow is pinned to `ROAD_SURFACE_Y`, and **only the
body carries `bob`** — i.e. the body wobbles on its suspension while the tyres stay
glued to the road. The hitbox (`playerBox`) is untouched, so collision/difficulty are
unchanged.

**Jump arc** (exact integrator, from the sim):

```
air time : 0.683 s   rise 0.333 s / fall 0.350 s  (symmetric within one 60fps step)
apex     : 156 px     starts & ends flush at player.y=432 -> contact line 450
```

The arc was already anchored at `GROUND_Y` on both ends; the fix makes the *visual*
contact line match it exactly.

---

## 2. Difficulty curve — one data-driven config

All per-leg balance now lives in a single reviewable `DIFFICULTY[]` array (index-aligned
with `BIOMES`). The old per-biome `spawnMul` was removed.

| Leg | obstacleDensity | minBlockingGap | fuelSpawnRate | fuelPerCan |
|---|---|---|---|---|
| DOWNTOWN | 1.00 | 660 px | 1.00 | 22 |
| MUSIC ROW | 1.20 | 640 px | 1.00 | 22 |
| CUMBERLAND | 1.40 | 640 px | 1.05 | 24 |
| BROADWAY | 1.65 | 620 px | 1.25 | 28 |

- **obstacleDensity** scales spawn cadence (`interval = base / density`, floored at
  `SPAWN_MIN_INTERVAL = 0.32s`). Later legs feel busier.
- **minBlockingGap** is the headline fix (see §3).
- **fuelSpawnRate / fuelPerCan** make BROADWAY a payoff, not a wall (see §4).

---

## 3. No unavoidable back-to-back blockers (the Broadway cliff)

**Root cause of the cliff:** the old final-leg `spawnMul = 0.55` produced spawn intervals as
low as 0.32s. At the then-current `MAX_SPEED` (570 px/s) that is ~182 px between obstacles — far less
than a single jump needs — so two blocking obstacles (e.g. STOP-sign behind a pothole)
could be physically impossible to clear. Forced hits then drained fuel right at the
finish ("dry at ~96%").

**Fix:** `tryPlaceObstacle()` enforces a minimum on-screen gap between consecutive
*blocking* obstacles (pothole/cone/sign). If a new blocker would land closer than
`minBlockingGap` to the rightmost existing one, it is **skipped** — which both
guarantees a clearable gap and naturally thins dense legs instead of queuing an
unreachable wall. Collectibles are exempt, so the lane still feels full.

**Why these numbers are safe:** a full jump spans **369 px at MAX_SPEED** (9.0 —
540 px/s; trimmed from 11.0 in the 2026-06-09 feel rework because the world read
as jarringly fast). Every leg's *effective* gap `max(minBlockingGap,
MIN_GAP_TIME × effSpeed)` exceeds the per-leg jump span, so the player can always
complete a jump and be grounded before the next blocker — even in the worst
jump→duck transition.

The sim proves this **constructively** with real pixel-collision detection: it builds the
tightest *legal* blocker wall per leg (blockers exactly `minBlockingGap` apart,
alternating pothole↔sign↔cone to force the hardest transitions), drives at `MAX_SPEED`,
and runs an optimal-but-human controller:

```
DOWNTOWN   minGap 660 px (=1.222s @max, vs 0.683s air)  collisions: 0  CLEAR
MUSIC ROW  minGap 640 px (=1.058s @max, vs 0.683s air)  collisions: 0  CLEAR
CUMBERLAND minGap 640 px (=0.926s @max, vs 0.683s air)  collisions: 0  CLEAR
BROADWAY   minGap 620 px (=0.792s @max, vs 0.683s air)  collisions: 0  CLEAR
=> PROVEN: no unavoidable back-to-back blockers on any leg.
```

---

## 4. Fuel economy — clean run finishes, careless run dries

Fuel drain is time-based (`1.15/s` — trimmed from 1.4 with the 2026-06-09 speed cut so the
~22% longer trip time keeps total time-drain roughly constant), so the real killer was *forced* hits from clustering,
not raw economy. De-clustering (§3) is the root fix. But fixing the forced hits exposed a
second problem that an honest simulation surfaced (see §8): **pit stops auto-refuel and
are collected just by driving**, so once the unfair wall was gone, *nobody* could run dry
— a careless dawdler got ~4–5 free full tanks and cruised home. That makes "a careless run
runs dry" impossible to satisfy.

Two deliberate balance changes restore a real, skill-based fuel pressure:

| Lever | Was | Now | Why |
|---|---|---|---|
| `HIT_FUEL_PENALTY` | 12 | **20** (12→14→20) | Hits are always avoidable (§3), so the penalty is a pure skill signal. The auto-throttle retune made trips faster (less time-drain), so hits must carry the stakes. |
| Pit-stop refuel | **FULL** (100) | **+28** (`PITSTOP_REFILL`, 40→28 with the retune) | A full reset made running dry unreachable. +28 is still the biggest single fuel pickup + 500 pts — a strong rescue, not an auto-win. |

The BROADWAY fuel bump (`fuelSpawnRate 1.25`, `fuelPerCan 28`) is kept: it rewards players who
*collect*, giving the finale a payoff feel, without rescuing a careless player (who grabs
few cans).

Illustrative single-seed runs (pit stops modelled):

| Run | Outcome | Fuel left | Min fuel | Blockers hit | Cans |
|---|---|---|---|---|---|
| **Skilled** (~92% speed, 0 hits, 85% cans) | **FINISH** | 99.3 | 88.8 | 0 / 34 | 6 / 6 |
| **Moderate** (~80% speed, ~15% hit, 60% cans) | **FINISH** | 79.3 | 68.8 | 5 / 34 | 4 / 6 |
| **Careless** (~70% hit, 25% cans) | **DRY @ 50%** | 0.0 | −4.6 | 7 / 14 | 1 / 2 |

Because one seed proves nothing, the sim sweeps **500 seeds** per policy and asserts on
aggregate rates (not a single lucky run):

| Policy | Finish | Dry | Avg fuel left | Avg min fuel |
|---|---|---|---|---|
| Skilled | **100%** | 0% | 97.6 | 91.6 |
| Moderate | **100%** | 0% | 88.3 | 62.7 |
| Careless | 1.2% | **98.8%** | 35.7 | −5.0 |

And the dry-rate scales smoothly with how careless you are — fuel pressure is proportional
to mistakes, not a cliff (grab fixed at 25%):

| Careless hit-rate | 40% | 50% | 60% | 70% | 80% |
|---|---|---|---|---|---|
| Runs dry | 49% | 75% | 92% | **98.8%** | 100% |

The careless-dry result is honestly a **two-lever** property — it needs frequent hits *and*
low fuel-collection. Holding hits at 70% and varying how many cans the player grabs:

| Careless fuel-grab | 10% | 25% | 40% | 60% |
|---|---|---|---|---|
| Runs dry | 99.6% | **98%** | 94.6% | 89.2% |

Assuming a careless player grabs few cans (≈25%) is realistic, not cherry-picked: a careless
run dies early and never reaches the fuel-rich BROADWAY leg, so it can't self-rescue.
So a clean run finishes with margin, a coin-flip player (≈50% hits) dies more often than
not, and a genuinely careless player reliably runs dry. Pit stops remain a deliberate
safety net, so an unusually lucky careless run can still scrape through (~2%) — flagged
honestly rather than hidden behind a cherry-picked seed or single policy.

---

## 5. Fuel-low feedback hook (physics → audio/UI contract)

`state.fuelLow` (boolean) is `true` while fuel is below `FUEL_LOW_FRAC` (15%) and not yet
empty. `state.fuelLowJustEntered` is a single-frame rising edge for one-shot warnings.
Both are **produced** here (in `updateGame`) and are **read-only** for consumers — no
audio/UI is implemented on this side (the audio/HUD layers own that).

---

## 6. Combo math (uncapped — the score engine)

- The combo count and multiplier are **uncapped**: `mult = 1 + (chain − 1) × 0.6`
  (x1, x1.6, x2.2 … x15.4 at 25, and climbing). `COMBO_CEILING = 25` clamps only
  the SFX pitch ramp, which has no scoring effect; the sim mirrors the uncapped
  math.
- The decay window shrinks as the chain grows — `max(1.5, 4.0 − chain × 0.12)` —
  so a long chain demands near-continuous skill; that window is the practical
  limit, not a numeric cap.
- The chain resets to 0 on collision (hit branch) and on window expiry — both
  confirmed by sim + self-test ("combo multiplier keeps climbing past the old
  25 ceiling").

---

## 7. Hidden debug overlay

`DEBUG` constant (default **false**). When `true`, the backtick key toggles an on-canvas
overlay drawing the real collision hitboxes (player/obstacles/collectibles), the
`ROAD_SURFACE_Y` contact line, and a live per-leg difficulty readout. Drawn purely in the
logical 960×540 space so it survives the render transform. Inert in shipped builds.

---

## 8. Verification (adversarial review)

This change was run through a multi-agent adversarial review (4 review dimensions →
per-finding refute-by-default verification). 6 of 15 findings survived. The two material
ones reshaped the balance work:

1. **The economy sim originally omitted pit stops** — a full-refuel mechanic that is the
   single biggest fuel lever. Without it the "careless runs dry" claim was a false pass.
   Fixed by modelling pit stops *and* rebalancing them to a partial refuel (§4).
2. **The proof rested on one hardcoded seed.** Replaced with a 500-seed sweep + aggregate
   thresholds + the careless gradient table (§4).

The other confirmed items (min-gap/`obstacleDensity` interaction at speed, a dead sim
variable, and stale `spawnMul` docs) are addressed in this PR. The 9 dismissed findings
were self-confirming "no-action" notes or misreads.

## Running the proof

```
node sim/balance-sim.js     # exits 0 only if all acceptance criteria pass across 500 seeds
```
