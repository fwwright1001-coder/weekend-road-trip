# Balance & Physics Rationale — Bot 3

Scope: gameplay tuning, physics, and difficulty balance in `game.js`. No changes to
canvas resolution (Bot 1), HUD/CSS (Bot 2), or audio/menus (Bot 4).

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
| CITY   | 1.00 | 600 px | 1.0 | 22 |
| FOREST | 1.15 | 540 px | 1.0 | 22 |
| DESERT | 1.30 | 500 px | 1.1 | 24 |
| COAST  | 1.45 | 460 px | 1.6 | 28 |

- **obstacleDensity** scales spawn cadence (`interval = base / density`, floored at
  `SPAWN_MIN_INTERVAL = 0.32s`). Later legs feel busier.
- **minBlockingGap** is the headline fix (see §3).
- **fuelSpawnRate / fuelPerCan** make the COAST a payoff, not a wall (see §4).

---

## 3. No unavoidable back-to-back blockers (the COAST cliff)

**Root cause of the cliff:** the old COAST `spawnMul = 0.55` produced spawn intervals as
low as 0.32s. At `MAX_SPEED` (570 px/s) that is ~182 px between obstacles — far less
than a single jump needs — so two blocking obstacles (e.g. STOP-sign behind a pothole)
could be physically impossible to clear. Forced hits then drained fuel right at the
finish ("dry at ~96%").

**Fix:** `tryPlaceObstacle()` enforces a minimum on-screen gap between consecutive
*blocking* obstacles (pothole/cone/sign). If a new blocker would land closer than
`minBlockingGap` to the rightmost existing one, it is **skipped** — which both
guarantees a clearable gap and naturally thins dense legs instead of queuing an
unreachable wall. Collectibles are exempt, so the lane still feels full.

**Why these numbers are safe:** a full jump spans **390 px at MAX_SPEED**. Every leg's
`minBlockingGap` exceeds that, so the player can always complete a jump and be grounded
before the next blocker — even in the worst jump→duck transition.

The sim proves this **constructively** with real pixel-collision detection: it builds the
tightest *legal* blocker wall per leg (blockers exactly `minBlockingGap` apart,
alternating pothole↔sign↔cone to force the hardest transitions), drives at `MAX_SPEED`,
and runs an optimal-but-human controller:

```
CITY   minGap 600 px (=1.053s @max, vs 0.683s air)  collisions: 0  CLEAR
FOREST minGap 540 px (=0.947s @max, vs 0.683s air)  collisions: 0  CLEAR
DESERT minGap 500 px (=0.877s @max, vs 0.683s air)  collisions: 0  CLEAR
COAST  minGap 460 px (=0.807s @max, vs 0.683s air)  collisions: 0  CLEAR
=> PROVEN: no unavoidable back-to-back blockers on any leg.
```

---

## 4. Fuel economy — clean run finishes, careless run dries

Fuel drain is time-based (`1.4/s`), so the real killer was *forced* hits from clustering,
not raw economy. De-clustering (§3) is the root fix. But fixing the forced hits exposed a
second problem that an honest simulation surfaced (see §8): **pit stops auto-refuel and
are collected just by driving**, so once the unfair wall was gone, *nobody* could run dry
— a careless dawdler got ~4–5 free full tanks and cruised home. That makes "a careless run
runs dry" impossible to satisfy.

Two deliberate balance changes restore a real, skill-based fuel pressure:

| Lever | Was | Now | Why |
|---|---|---|---|
| `HIT_FUEL_PENALTY` | 12 | **14** | Hits are now always avoidable (§3), so the penalty is a pure skill signal. |
| Pit-stop refuel | **FULL** (100) | **+40** (`PITSTOP_REFILL`) | A full reset made running dry unreachable. +40 is still the biggest single fuel pickup + 500 pts — a strong rescue, not an auto-win. |

The COAST fuel bump (`fuelSpawnRate 1.6`, `fuelPerCan 28`) is kept: it rewards players who
*collect*, giving the finale a payoff feel, without rescuing a careless player (who grabs
few cans).

Illustrative single-seed runs (pit stops modelled):

| Run | Outcome | Fuel left | Min fuel | Blockers hit | Cans |
|---|---|---|---|---|---|
| **Skilled** (~92% speed, 0 hits, 85% cans) | **FINISH** | 94.4 | 91.7 | 0 / 22 | 6 / 8 |
| **Moderate** (~80% speed, ~15% hit, 60% cans) | **FINISH** | 98.2 | 71.2 | 3 / 24 | 5 / 8 |
| **Careless** (~70% hit, 25% cans) | **DRY @ 46%** | 0.0 | 0 | 12 / 14 | 1 / 3 |

Because one seed proves nothing, the sim sweeps **500 seeds** per policy and asserts on
aggregate rates (not a single lucky run):

| Policy | Finish | Dry | Avg fuel left | Avg min fuel |
|---|---|---|---|---|
| Skilled | **100%** | 0% | 96.3 | 88.1 |
| Moderate | **100%** | 0% | 89.2 | 66.1 |
| Careless | 9.8% | **90.2%** | 38.4 | −2.7 |

And the dry-rate scales smoothly with how careless you are — fuel pressure is proportional
to mistakes, not a cliff (grab fixed at 25%):

| Careless hit-rate | 40% | 50% | 60% | 70% | 80% |
|---|---|---|---|---|---|
| Runs dry | 19% | 45% | 71% | **90%** | 98% |

The careless-dry result is honestly a **two-lever** property — it needs frequent hits *and*
low fuel-collection. Holding hits at 70% and varying how many cans the player grabs:

| Careless fuel-grab | 10% | 25% | 40% | 60% |
|---|---|---|---|---|
| Runs dry | 97% | **90%** | 78% | 62% |

Assuming a careless player grabs few cans (≈25%) is realistic, not cherry-picked: a careless
run dies ~46% of the way in and never reaches the fuel-rich COAST, so it can't self-rescue.
So a clean run finishes with margin, a coin-flip player (≈50% hits) dies about half the
time, and a genuinely careless player reliably runs dry. Pit stops remain a deliberate
safety net, so an unusually lucky careless run can still scrape through (~10%) — flagged
honestly rather than hidden behind a cherry-picked seed or single policy.

---

## 5. Fuel-low feedback hook (Bot 3 → Bot 4 contract)

`state.fuelLow` (boolean) is `true` while fuel is below `FUEL_LOW_FRAC` (15%) and not yet
empty. `state.fuelLowJustEntered` is a single-frame rising edge for one-shot warnings.
Both are **produced** here (in `updateGame`) and are **read-only** for consumers — no
audio/UI is implemented on this side (Bot 4/Bot 2 own that).

---

## 6. Combo math (verified, unchanged)

- Multiplier resets to 0 on collision (hit branch) and on the 4s window expiry — both
  confirmed.
- `COMBO_WINDOW = 4.0s`, `COMBO_MAX = 5`. Collectibles arrive often enough that a clean
  5-pickup chain is achievable, but a single hit breaks it — achievable, not trivial. No
  change needed.

---

## 7. Hidden debug overlay

`DEBUG` constant (default **false**). When `true`, the backtick key toggles an on-canvas
overlay drawing the real collision hitboxes (player/obstacles/collectibles), the
`ROAD_SURFACE_Y` contact line, and a live per-leg difficulty readout. Drawn purely in the
logical 960×540 space so it survives Bot 1's render transform. Inert in shipped builds.

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
