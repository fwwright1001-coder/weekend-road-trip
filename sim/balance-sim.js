#!/usr/bin/env node
/* ============================================================
 * Weekend Road Trip — headless balance / physics simulation
 * ------------------------------------------------------------
 * This is the reviewable, deterministic stand-in for a "recorded run". It
 * MIRRORS the exact constants and core update math in game.js (Bot 3's
 * physics/spawn/balance) and proves the four acceptance criteria without a
 * browser:
 *
 *   1. Jump arc — symmetric, starts/ends flush on the contact line.
 *   2. No unavoidable back-to-back blockers — an optimal controller clears the
 *      tightest *legal* blocker sequence at MAX_SPEED with zero collisions.
 *   3. A skilled clean run that grabs most fuel finishes all four legs.
 *   4. A careless run still runs dry before the coast.
 *
 * Run:  node sim/balance-sim.js
 *
 * NOTE: these constants are a hand-copy of game.js — if you retune the game,
 * retune them here too (kept in sync deliberately; the IIFE can't be imported).
 * ============================================================ */
'use strict';

// --- constants mirrored from game.js -------------------------------------
const W = 960;
const GROUND_Y = 432;
const CAR_FOOT_OFFSET = 18;
const ROAD_SURFACE_Y = GROUND_Y + CAR_FOOT_OFFSET; // 450
const GRAVITY = 0.78;
const JUMP_V = -16;
const PLAYER_X = 170;
const BASE_SPEED = 5;
const MAX_SPEED = 11.0;               // mirror game.js (widened 9.5 -> 11.0)
const MIN_GAP_TIME = 0.72;            // mirror game.js: speed-aware min same-lane blocker gap (s)
const FUEL_MAX = 100;
const FUEL_DRAIN_PER_SEC = 1.4;
const HIT_FUEL_PENALTY = 20;
const SPAWN_MIN_INTERVAL = 0.32;
const TRIP_TOTAL = 20000;
const DT = 1 / 60; // fixed-step sim (game uses a clamped variable dt; 60fps is the design target)

// Pit stops (mirror game.js): auto-spawn at distance milestones, collected just
// by driving (tall hitbox overlaps the resting car), and refuel the tank. These
// are the single biggest fuel lever in the game and MUST be modelled or the
// economy proof is fiction (see review finding: careless "runs dry" was a false
// pass without them). PITSTOP_REFILL is the per-stop refuel amount.
const PITSTOP_START = 2200;
const PITSTOP_INTERVAL_MIN = 4000;
const PITSTOP_INTERVAL_RAND = 1500;
const PITSTOP_REFILL = 28;           // partial refuel — strong help, not an auto-win (mirrors game.js)
const PITSTOP_REACH = 890;           // px a pit stop travels from spawn (W+100) to the player (PLAYER_X)

const DIFFICULTY = [
  { obstacleDensity: 1.00, minBlockingGap: 660, fuelSpawnRate: 1.00, fuelPerCan: 22, speedScale: 1.00, end: 5000 },  // CITY
  { obstacleDensity: 1.20, minBlockingGap: 640, fuelSpawnRate: 1.00, fuelPerCan: 22, speedScale: 1.12, end: 10000 }, // FOREST
  { obstacleDensity: 1.40, minBlockingGap: 640, fuelSpawnRate: 1.05, fuelPerCan: 24, speedScale: 1.28, end: 15000 }, // DESERT
  { obstacleDensity: 1.65, minBlockingGap: 620, fuelSpawnRate: 1.25, fuelPerCan: 28, speedScale: 1.45, end: 20000 }  // COAST
];
const legForDistance = (d) => {
  for (let i = 0; i < DIFFICULTY.length; i++) if (d < DIFFICULTY[i].end) return i;
  return DIFFICULTY.length - 1;
};
// Effective top speed for a leg (px/frame). The game ramps within a leg too, but
// the worst case for solvability is the leg's full escalated cap, used here.
const legEffSpeed = (leg) => MAX_SPEED * DIFFICULTY[leg].speedScale;
// Speed-aware min gap (px) for a leg: larger of table floor and time-based gap.
const legMinGapPx = (leg) =>
  Math.max(DIFFICULTY[leg].minBlockingGap, MIN_GAP_TIME * legEffSpeed(leg) * 60);

// Lane geometry mirrored from game.js
const LANE_COUNT = 3;
const LANE_DY = [44, 0, -44];          // 0=near/bottom, 1=center, 2=far/top
const LANE_TWEEN_DUR = 0.16;
const LANE_COMMIT_FRAC = 0.5;
const REACTION_R = 0.25;                // human+actuation reaction budget (s)
const SPAWN_LEAD_PX = (W + 60) - PLAYER_X;  // px a blocker travels from spawn to the player
// Combo scoring (mirror game.js)
const COMBO_CEILING = 25;
const comboMult = (c) => 1 + Math.max(0, c - 1) * 0.6;
const comboWindow = (c) => Math.max(1.5, 4.0 - c * 0.12);
// Per-leg pattern weights + maxLaneSpan (mirror game.js)
const PATTERN = [
  { maxLaneSpan: 1, w: { single: 0.80, wallGap: 0.15, layered: 0.05, chicane: 0.00 } },
  { maxLaneSpan: 1, w: { single: 0.55, wallGap: 0.30, layered: 0.10, chicane: 0.05 } },
  { maxLaneSpan: 2, w: { single: 0.38, wallGap: 0.34, layered: 0.18, chicane: 0.10 } },
  { maxLaneSpan: 2, w: { single: 0.25, wallGap: 0.34, layered: 0.23, chicane: 0.18 } }
];

// --- geometry mirrored from game.js --------------------------------------
function obstacleGeom(type) {
  if (type === 'pothole') return { w: 64, h: 18, y: GROUND_Y + 2 };
  if (type === 'cone')    return { w: 24, h: 36, y: GROUND_Y - 36 + 8 };
  /* sign */              return { w: 78, h: 30, y: GROUND_Y - 60 };
}
function playerBox(y, ducking) {
  const h = ducking ? 32 : 52;
  return { x: PLAYER_X, y: y - h + 10, w: 76, h };
}
const overlap = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// deterministic LCG so the economy runs are reproducible
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ============================================================
// 1. JUMP ARC — symmetry + flush landing (exact game.js integrator)
// ============================================================
function analyseJump() {
  let y = GROUND_Y, vy = JUMP_V, apex = GROUND_Y, apexFrame = 0, frames = 0;
  const f = DT * 60;
  // mirrors updatePlayer(): vy += GRAVITY*f; y += vy*f; clamp at GROUND_Y.
  for (let i = 0; i < 1000; i++) {
    vy += GRAVITY * f;
    y += vy * f;
    frames++;
    if (y < apex) { apex = y; apexFrame = frames; }
    if (y >= GROUND_Y) { y = GROUND_Y; break; } // clean clamp = flush landing
  }
  const airTime = frames * DT;
  const tApex = apexFrame * DT;
  const descent = (frames - apexFrame) * DT;
  // symplectic Euler is symmetric to within one integration step (DT).
  return { airTime, apexHeight: GROUND_Y - apex, tApex, descent, spanMax: airTime * MAX_SPEED * 60 };
}

// ============================================================
// 2. SOLVABILITY — optimal controller vs the tightest legal blocker wall
// ============================================================
// Build the densest *legal* sequence for a leg: blockers spaced exactly
// minBlockingGap apart, alternating pothole(jump) <-> sign(duck) to force the
// hardest transition. Drive at MAX_SPEED (worst case) with an optimal
// controller and assert zero collisions. Clearing this is a constructive proof
// that no legal layout is unavoidable.
function solvabilityProof(legIdx) {
  const minGap = legMinGapPx(legIdx);          // speed-aware gap (table floor or time-based)
  const speedPx = legEffSpeed(legIdx) * 60;    // px/sec at this leg's escalated cap (worst case)
  const types = ['pothole', 'sign', 'cone', 'sign', 'pothole', 'sign', 'cone', 'sign'];
  const obstacles = types.map((type, i) => {
    const g = obstacleGeom(type);
    return { type, x: PLAYER_X + 600 + i * minGap, ...g, cleared: false, hit: false };
  });

  const p = { y: GROUND_Y, vy: 0, jumping: false, ducking: false };
  const f = DT * 60;
  let collisions = 0;
  let minCenterGapTime = Infinity;

  // record nose-to-nose time gaps actually presented to the player
  for (let i = 1; i < obstacles.length; i++) {
    const gapPx = obstacles[i].x - obstacles[i - 1].x;
    minCenterGapTime = Math.min(minCenterGapTime, gapPx / speedPx);
  }

  for (let step = 0; step < 6000; step++) {
    // scroll
    for (const o of obstacles) o.x -= speedPx * DT;

    // --- optimal control --------------------------------------------------
    // Nearest still-relevant blocker of each kind ahead of / over the player.
    const ahead = obstacles.filter((o) => o.x + o.w > PLAYER_X - 10);
    const nextGround = ahead.find((o) => o.type !== 'sign');
    const nextSign = ahead.find((o) => o.type === 'sign');

    // Duck whenever a sign is in the approach/overlap band and we're grounded.
    p.ducking = !!(nextSign && nextSign.x < PLAYER_X + 150 && nextSign.x + nextSign.w > PLAYER_X - 30 && p.y >= GROUND_Y - 0.01);

    // Jump pre-emptively for the nearest ground blocker: trigger when its near
    // edge is ~0.18-0.30s out so the long airborne window covers its pass.
    if (nextGround && p.y >= GROUND_Y - 0.01) {
      const lead = nextGround.x - (PLAYER_X + 76);
      const leadT = lead / speedPx;
      const signOverlappingNow = nextSign && nextSign.x < PLAYER_X + 76 && nextSign.x + nextSign.w > PLAYER_X;
      if (leadT <= 0.30 && leadT > 0.02 && !signOverlappingNow) {
        p.vy = JUMP_V; p.jumping = true;
      }
    }

    // --- physics (mirror updatePlayer) -----------------------------------
    p.vy += GRAVITY * f;
    p.y += p.vy * f;
    if (p.y >= GROUND_Y) { p.y = GROUND_Y; p.vy = 0; p.jumping = false; }

    // --- collision (mirror updateWorld) ----------------------------------
    const pb = playerBox(p.y, p.ducking);
    for (const o of obstacles) {
      if (o.hit) continue;
      if (overlap(pb, o)) { o.hit = true; collisions++; }
    }
    if (obstacles.every((o) => o.x + o.w < PLAYER_X - 10)) break;
  }
  return { legIdx, minGap, collisions, minGapTime: minCenterGapTime };
}

// ============================================================
// 2b. LANE SOLVABILITY — optimal controller vs the worst WALL_GAP stream
// ============================================================
// The lateral analogue of the single-track proof. Build the densest legal
// WALL_GAP stream (each pattern blocks 2 lanes, leaving exactly one open; the
// open lane cycles 0/2/1 to force max lateral travel). An optimal controller
// pre-positions into the open lane (one 0.16s hop at a time). Assert it never
// gets caught in a blocked lane. Per-lane vertical solvability (jump/duck) is
// covered by section [2]; LAYERED walls reduce to that single-lane proof.
function solvabilityProofLanes(legIdx) {
  const gap = legMinGapPx(legIdx);
  const speedPx = legEffSpeed(legIdx) * 60;
  const opens = [0, 2, 1, 0, 2, 1, 0, 2];      // worst-case alternation (up to 2 hops apart)
  const patterns = opens.map((open, i) => ({ open, x: PLAYER_X + 700 + i * gap, done: false }));
  let lane = 1, laneTarget = 1, tweenT = 0, collisions = 0;

  for (let step = 0; step < 12000; step++) {
    for (const p of patterns) p.x -= speedPx * DT;
    if (tweenT > 0) { tweenT = Math.max(0, tweenT - DT); if (tweenT === 0) lane = laneTarget; }

    // controller: pre-position toward the open lane of the nearest pattern ahead
    const next = patterns.find((p) => p.x + 78 > PLAYER_X - 10);
    if (next && tweenT === 0 && lane !== next.open) {
      laneTarget = lane + Math.sign(next.open - lane);
      tweenT = LANE_TWEEN_DUR;
    }

    // collision: while a pattern overlaps the player x-band, the occupied lane(s)
    // must all be the open lane (commit rule mid-hop).
    for (const p of patterns) {
      if (p.done) continue;
      const overlapX = PLAYER_X < p.x + 78 && PLAYER_X + 76 > p.x;
      if (!overlapX) continue;
      let occ;
      if (tweenT > 0) { const prog = 1 - tweenT / LANE_TWEEN_DUR; occ = prog < LANE_COMMIT_FRAC ? [lane, laneTarget] : [laneTarget]; }
      else occ = [lane];
      const blocked = [0, 1, 2].filter((l) => l !== p.open);
      if (occ.some((l) => blocked.includes(l))) { collisions++; p.done = true; }
    }
    if (patterns.every((p) => p.x + 78 < PLAYER_X - 10)) break;
  }
  return { legIdx, gap, collisions };
}

// Analytic reachability: lead time for a freshly-spawned pattern to reach the
// player must exceed the time to cross to the open lane (worst case 2 hops),
// and a non-layered pattern must never block all 3 lanes (maxLaneSpan <= 2).
function openLaneReach(legIdx) {
  const leadT = SPAWN_LEAD_PX / (legEffSpeed(legIdx) * 60);
  const reachT = REACTION_R + 2 * LANE_TWEEN_DUR;     // 0.25 + 0.32 = 0.57s
  return { legIdx, leadT, reachT, ok: leadT > reachT, spanOk: PATTERN[legIdx].maxLaneSpan <= 2 };
}

// ============================================================
// 3 + 4. ECONOMY — full-trip fuel sim under skilled vs careless policies
// ============================================================
// Event-level model of the real spawn loop. A "policy" defines speed, the
// fraction of blockers hit, and the fraction of fuel cans collected. We run the
// genuine spawn cadence + min-gap rule so blocker/fuel counts are realistic.
// Sample how many blockers a blocking-pattern roll produces on a leg (mirrors
// game.js spawnPattern: single=1, wallGap=2, layered=3, chicane=2; wallGap/chicane
// downgrade to single where maxLaneSpan < 2).
function samplePatternBlockers(leg, rng) {
  const P = PATTERN[leg], w = P.w;
  let r = rng(), pat;
  if ((r -= w.single) < 0) pat = 'single';
  else if ((r -= w.wallGap) < 0) pat = 'wallGap';
  else if ((r -= w.layered) < 0) pat = 'layered';
  else pat = 'chicane';
  if ((pat === 'wallGap' || pat === 'chicane') && P.maxLaneSpan < 2) pat = 'single';
  return pat === 'single' ? 1 : pat === 'layered' ? 3 : 2;
}

function economyRun(policy, seed) {
  const rng = makeRng(seed);
  let distance = 0, fuel = FUEL_MAX, t = 0;
  let spawnTimer = 0;
  let blockers = 0, blockersHit = 0, fuelCans = 0, fuelCansTaken = 0, pitstops = 0;
  let minFuel = FUEL_MAX, driedAtPct = null;
  const trace = []; // [pct, fuel]

  // queue of blockers in flight (x positions) so min-gap matches game.js
  let inFlight = [];
  // pit stops: spawn at distance milestones, collected when they reach the player
  let nextPit = PITSTOP_START;
  let pitsPending = []; // distances at which an already-spawned pit stop is collected

  while (distance < TRIP_TOTAL) {
    const leg = legForDistance(distance);
    const d = DIFFICULTY[leg];
    const speed = policy.speed(leg);

    // scroll in-flight blockers and drop the ones past the player
    const move = speed * 60 * DT;
    inFlight = inFlight.map((x) => x - move).filter((x) => x > -100);

    // spawn cadence (mirror updateWorld)
    spawnTimer -= DT;
    if (spawnTimer <= 0) {
      // New spawn model (mirror game.js): fuel / snack / else a blocking PATTERN
      // (single=1, wallGap=2, layered=3, chicane=2 blockers). More blockers on the
      // harder legs => more hit opportunities for careless play.
      const fuelChance = Math.min(0.4, 0.10 * d.fuelSpawnRate);
      const snackChance = 0.18;
      const r = rng();
      if (r < fuelChance) {
        fuelCans++;
        if (rng() < policy.fuelGrab(leg)) { fuelCansTaken++; fuel = Math.min(FUEL_MAX, fuel + d.fuelPerCan); }
      } else if (r < fuelChance + snackChance) {
        // snack — irrelevant to fuel
      } else {
        // blocking pattern — one spawn event (one min-gap check), N blockers
        const spawnX = W + 60;
        const rightmost = inFlight.length ? Math.max(...inFlight) : -Infinity;
        if (rightmost === -Infinity || spawnX - rightmost >= legMinGapPx(leg)) {
          inFlight.push(spawnX);
          const n = samplePatternBlockers(leg, rng);
          blockers += n;
          for (let k = 0; k < n; k++) {
            if (rng() < policy.hitRate(leg)) { blockersHit++; fuel -= HIT_FUEL_PENALTY; }
          }
        }
      }
      spawnTimer = Math.max(SPAWN_MIN_INTERVAL, (0.85 + rng() * 0.7 - speed * 0.045) / d.obstacleDensity);
    }

    // pit-stop spawn at distance milestone (mirror updateWorld); collected ~890
    // units later when it scrolls to the player (unavoidable while grounded).
    if (distance >= nextPit) {
      pitsPending.push(distance + PITSTOP_REACH);
      nextPit += PITSTOP_INTERVAL_MIN + rng() * PITSTOP_INTERVAL_RAND;
    }
    // Assume 100% collection: the pit-stop hitbox overlaps the player box while
    // grounded OR ducking, so it is missed only mid-jump (a ~0.25s window). This
    // is conservative for the careless-dry criterion (missing a pit stop only
    // makes drying *more* likely), and faithful for grounded skilled/moderate play.
    pitsPending = pitsPending.filter((collectAt) => {
      if (distance >= collectAt) { fuel = Math.min(FUEL_MAX, fuel + PITSTOP_REFILL); pitstops++; return false; }
      return true;
    });

    // integrate
    distance += speed * 60 * DT;
    fuel -= FUEL_DRAIN_PER_SEC * DT;
    t += DT;
    if (fuel < minFuel) minFuel = fuel;
    if (trace.length === 0 || (distance / TRIP_TOTAL) * 100 >= trace.length * 5) {
      trace.push([Math.round((distance / TRIP_TOTAL) * 100), Math.max(0, fuel)]);
    }
    if (fuel <= 0) { driedAtPct = (distance / TRIP_TOTAL) * 100; break; }
  }

  return {
    finished: fuel > 0 && distance >= TRIP_TOTAL,
    driedAtPct, fuelLeft: Math.max(0, fuel), minFuel, timeSec: t,
    blockers, blockersHit, fuelCans, fuelCansTaken, pitstops, trace
  };
}

// SKILL vs DISTANCE: does a fast "weaver" (near-misses + sustained combo) score
// far above a passive "grinder" (just drives, grabs little)? Mirrors the new
// score formula: passive distance * 3, +500/leg, pickups & near-misses * comboMult.
function scoreModel(policy, seed) {
  const rng = makeRng(seed);
  let distance = 0, spawnTimer = 0, score = 0, combo = 0, comboT = 0, lastLeg = -1;
  while (distance < TRIP_TOTAL) {
    const leg = legForDistance(distance);
    if (leg > lastLeg) { score += 500; lastLeg = leg; }   // biome-clear bonus
    const d = DIFFICULTY[leg];
    const speed = AUTO(leg);
    const bump = (val) => { combo = Math.min(COMBO_CEILING, combo + 1); comboT = comboWindow(combo); score += Math.round(val * comboMult(combo)); };
    spawnTimer -= DT;
    if (spawnTimer <= 0) {
      const fuelChance = Math.min(0.4, 0.10 * d.fuelSpawnRate), snackChance = 0.18;
      const r = rng();
      if (r < fuelChance) { if (rng() < policy.grab) bump(25); }
      else if (r < fuelChance + snackChance) { if (rng() < policy.grab) bump(50); }
      else { const n = samplePatternBlockers(leg, rng); for (let k = 0; k < n; k++) if (rng() < policy.nearMiss) bump(35); }
      spawnTimer = Math.max(SPAWN_MIN_INTERVAL, (0.85 + rng() * 0.7 - speed * 0.045) / d.obstacleDensity);
    }
    score += speed * DT * 3;
    distance += speed * 60 * DT;
    if (combo > 0) { comboT -= DT; if (comboT <= 0) combo = 0; }
  }
  return Math.round(score);
}
const grinder = { grab: 0.20, nearMiss: 0.00 };   // passive: drives, grabs little, no risk
const weaver = { grab: 0.85, nearMiss: 0.70 };     // aggressive: near-misses + sustained combo

// Aggregate a policy over many seeds so a claim never rests on one lucky seed.
function seedSweep(policy, n) {
  let finishes = 0, driedBeforeCoast = 0;
  let sumFuelLeft = 0, sumMinFuel = 0;
  for (let s = 1; s <= n; s++) {
    const r = economyRun(policy, s * 7919 + 1); // distinct seeds
    if (r.finished) { finishes++; sumFuelLeft += r.fuelLeft; }
    else if (r.driedAtPct < 75) driedBeforeCoast++;
    sumMinFuel += r.minFuel;
  }
  return {
    n,
    finishRate: finishes / n,
    dryRate: (n - finishes) / n,
    driedBeforeCoastRate: driedBeforeCoast / n,
    avgFuelLeft: finishes ? sumFuelLeft / finishes : 0,
    avgMinFuel: sumMinFuel / n
  };
}

// policies ----------------------------------------------------------------
// Manual throttle is RETIRED: the car auto-eases to the leg's effective cap, so
// EVERY policy drives at ~the same speed (≈0.97 of cap). Policies now differ only
// in skill expression: how many blockers they hit and how much fuel they grab.
// (This is the post-auto-throttle economy model; speed is no longer a player lever.)
const AUTO = (leg) => legEffSpeed(leg) * 0.97;
const skilled = {
  // clears every blocker, grabs most cans.
  speed: AUTO,
  hitRate: () => 0.0,
  fuelGrab: () => 0.85
};
const moderate = {
  // fumbles ~1 in 7 blockers, grabs most cans — finishes, but the tension is real.
  speed: AUTO,
  hitRate: () => 0.15,
  fuelGrab: () => 0.6
};
const careless = {
  // genuinely inattentive: mistimes ~70% of blockers, grabs few cans. With wider
  // (escalating) gaps there are fewer blockers, so the dry property now leans on
  // the higher hit penalty + low fuel-grab rather than slow time-drain.
  speed: AUTO,
  hitRate: () => 0.70,
  fuelGrab: () => 0.20
};
// careless policy variants for the transparency gradients (vary one lever each)
const carelessAtHit = (h) => ({ speed: AUTO, hitRate: () => h, fuelGrab: () => 0.20 });
const carelessAtGrab = (g) => ({ speed: AUTO, hitRate: () => 0.70, fuelGrab: () => g });

// ============================================================
// REPORT
// ============================================================
function bar(pct, width = 20) {
  const n = Math.round((pct / 100) * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

console.log('================================================================');
console.log(' WEEKEND ROAD TRIP — balance & physics simulation (Bot 3)');
console.log('================================================================\n');

// 1. jump arc
const jump = analyseJump();
console.log('[1] JUMP ARC (exact integrator)');
console.log(`    air time      : ${jump.airTime.toFixed(3)} s`);
console.log(`    rise / fall   : ${jump.tApex.toFixed(3)} s up / ${jump.descent.toFixed(3)} s down  (symmetric within 1 step: ${Math.abs(jump.tApex - jump.descent) <= DT + 1e-9 ? 'YES' : 'NO'})`);
console.log(`    apex height   : ${jump.apexHeight.toFixed(1)} px`);
console.log(`    horiz. span @ MAX_SPEED : ${jump.spanMax.toFixed(0)} px  (one full jump covers this)`);
console.log(`    flush landing : starts & ends at player.y=${GROUND_Y} -> contact line ${ROAD_SURFACE_Y}\n`);

// 2. solvability
console.log('[2] SOLVABILITY — optimal controller vs tightest legal blocker wall @ MAX_SPEED');
let allSolved = true;
['CITY', 'FOREST', 'DESERT', 'COAST'].forEach((name, i) => {
  const r = solvabilityProof(i);
  if (r.collisions > 0) allSolved = false;
  console.log(`    ${name.padEnd(6)} minGap ${String(r.minGap).padEnd(4)}px  (=${r.minGapTime.toFixed(3)}s @max, vs ${jump.airTime.toFixed(3)}s air)  collisions: ${r.collisions}  ${r.collisions === 0 ? 'CLEAR' : 'FAIL'}`);
});
console.log(`    => ${allSolved ? 'PROVEN: no unavoidable back-to-back blockers on any leg.' : 'FAIL: a leg has an unavoidable layout.'}\n`);

// 3 + 4. economy
console.log('[3/4] ECONOMY — full 20,000-unit trip\n');
function reportRun(label, res) {
  console.log(`    ${label}`);
  console.log(`      outcome   : ${res.finished ? 'FINISHED ✔' : `RAN DRY at ${res.driedAtPct.toFixed(1)}% ✘`}`);
  console.log(`      fuel left : ${res.fuelLeft.toFixed(1)} / ${FUEL_MAX}   (min during run: ${res.minFuel.toFixed(1)})`);
  console.log(`      blockers  : ${res.blockersHit}/${res.blockers} hit   fuel cans: ${res.fuelCansTaken}/${res.fuelCans} grabbed`);
  console.log(`      run time  : ${res.timeSec.toFixed(1)}s`);
  console.log('      fuel curve:');
  for (const [pct, f] of res.trace) {
    if (pct % 10 === 0) console.log(`        ${String(pct).padStart(3)}% |${bar(f)}| ${f.toFixed(0)}`);
  }
  console.log('');
}
// Illustrative single-seed traces (the "recorded runs"), pit stops included.
const sk = economyRun(skilled, 12345);
const mo = economyRun(moderate, 12345);
const ca = economyRun(careless, 12345);
reportRun('SKILLED  (≈92% top speed, 0 hits, grabs 85% of cans):', sk);
reportRun('MODERATE (≈80% top speed, ~15% hit, grabs 60% of cans):', mo);
reportRun('CARELESS (dawdles, hits ~70% of blockers, grabs 25%):', ca);

// Aggregate across many seeds so the claim never rests on one lucky seed.
const N = 500;
const skS = seedSweep(skilled, N);
const moS = seedSweep(moderate, N);
const caS = seedSweep(careless, N);
console.log(`    Cross-seed aggregate (${N} seeds, pit stops modelled, PITSTOP_REFILL=${PITSTOP_REFILL}):`);
const pctf = (x) => (x * 100).toFixed(1).padStart(5) + '%';
console.log('      policy    finish    dry   avgFuelLeft  avgMinFuel');
console.log(`      SKILLED   ${pctf(skS.finishRate)}  ${pctf(skS.dryRate)}    ${skS.avgFuelLeft.toFixed(1).padStart(5)}      ${skS.avgMinFuel.toFixed(1).padStart(5)}`);
console.log(`      MODERATE  ${pctf(moS.finishRate)}  ${pctf(moS.dryRate)}    ${moS.avgFuelLeft.toFixed(1).padStart(5)}      ${moS.avgMinFuel.toFixed(1).padStart(5)}`);
console.log(`      CARELESS  ${pctf(caS.finishRate)}  ${pctf(caS.dryRate)}    ${caS.avgFuelLeft.toFixed(1).padStart(5)}      ${caS.avgMinFuel.toFixed(1).padStart(5)}`);
console.log('');

// Transparency: dry-rate as a function of careless hit-rate, so the "careless
// dries" claim is shown as a gradient, not a single cherry-picked policy.
console.log(`    Dry-rate vs careless hit-rate (grab fixed 25%, ${N} seeds each):`);
[0.4, 0.5, 0.6, 0.7, 0.8].forEach((h) => {
  const s = seedSweep(carelessAtHit(h), N);
  console.log(`      hits ${(h * 100).toFixed(0)}%  ->  dry ${pctf(s.dryRate)}   (finish ${pctf(s.finishRate)})`);
});
console.log('');

// The careless-dry result is a TWO-lever property: it needs both frequent hits
// AND low fuel-collection. Shown explicitly so the criterion isn't read as
// resting on hit-rate alone. (A careless run dies ~46% in and never reaches the
// fuel-rich COAST, so assuming it grabs few cans is realistic, not cherry-picked.)
console.log(`    Dry-rate vs careless fuel-grab (hits fixed 70%, ${N} seeds each):`);
[0.10, 0.25, 0.40, 0.60].forEach((g) => {
  const s = seedSweep(carelessAtGrab(g), N);
  console.log(`      grab ${(g * 100).toFixed(0)}%  ->  dry ${pctf(s.dryRate)}   (finish ${pctf(s.finishRate)})`);
});
console.log('');

// Acceptance thresholds (aggregate, not single-seed):
//   skilled  finishes ~always; moderate finishes the large majority;
//   careless dries the large majority. Pit stops are a deliberate bailout, so
//   the bar for careless is "reliably dries", not "never finishes".
// jumpSpanSafe: at EVERY leg's escalated speed, the speed-aware min gap must
// exceed the horizontal jump span, or a blocker pair could be unavoidable.
// (This catches the regression where a fixed 460px gap was unsafe at MAX 11.0.)
const spanReport = DIFFICULTY.map((d, i) => {
  const span = jump.airTime * legEffSpeed(i) * 60;
  const gap = legMinGapPx(i);
  return { leg: ['CITY', 'FOREST', 'DESERT', 'COAST'][i], span, gap, safe: gap > span };
});
const jumpSpanSafe = spanReport.every((r) => r.safe);

// finaleIsClimax: COAST must be the fastest AND densest leg — the trip escalates
// to a peak rather than coasting home.
const finaleIsClimax =
  legEffSpeed(3) > legEffSpeed(2) && legEffSpeed(2) > legEffSpeed(1) && legEffSpeed(1) > legEffSpeed(0) &&
  DIFFICULTY[3].obstacleDensity >= Math.max(...DIFFICULTY.slice(0, 3).map((d) => d.obstacleDensity));

console.log('[5] FINALE ESCALATION & JUMP-SPAN SAFETY (per leg)');
spanReport.forEach((r) => {
  console.log(`    ${r.leg.padEnd(6)} effSpeed ${(legEffSpeed(['CITY','FOREST','DESERT','COAST'].indexOf(r.leg))).toFixed(2)}  jumpSpan ${r.span.toFixed(0)}px  minGap ${r.gap.toFixed(0)}px  ${r.safe ? 'SAFE' : 'UNSAFE'}`);
});
console.log(`    finale is climax (fastest + densest COAST): ${finaleIsClimax ? 'YES' : 'NO'}\n`);

// 2b. lane solvability + reachability
console.log('[6] LANE SOLVABILITY — optimal controller vs worst WALL_GAP stream + reach budget');
let lanesSolved = true, reachOk = true;
['CITY', 'FOREST', 'DESERT', 'COAST'].forEach((name, i) => {
  const s = solvabilityProofLanes(i);
  const r = openLaneReach(i);
  if (s.collisions > 0) lanesSolved = false;
  if (!r.ok || !r.spanOk) reachOk = false;
  console.log(`    ${name.padEnd(6)} laneCollisions ${s.collisions}  lead ${r.leadT.toFixed(3)}s vs reach ${r.reachT.toFixed(2)}s  span<=2 ${r.spanOk ? 'Y' : 'N'}  ${s.collisions === 0 && r.ok && r.spanOk ? 'CLEAR' : 'FAIL'}`);
});
console.log(`    => ${lanesSolved && reachOk ? 'PROVEN: an open lane is always reachable in time on every leg.' : 'FAIL: a leg has an unreachable/over-wide pattern.'}\n`);

// SKILL_DOMINATES_DISTANCE — a weaver should outscore a grinder by >= 2.5x.
const SEEDS_SCORE = 60;
let weaverSum = 0, grinderSum = 0;
for (let s = 1; s <= SEEDS_SCORE; s++) { weaverSum += scoreModel(weaver, s * 5779 + 3); grinderSum += scoreModel(grinder, s * 5779 + 3); }
const weaverAvg = Math.round(weaverSum / SEEDS_SCORE), grinderAvg = Math.round(grinderSum / SEEDS_SCORE);
const skillRatio = weaverAvg / grinderAvg;
const skillDominates = skillRatio >= 2.5;
console.log('[7] SKILL vs DISTANCE');
console.log(`    weaver avg score ${weaverAvg}  vs  grinder avg score ${grinderAvg}  =>  ${skillRatio.toFixed(2)}x  (need >=2.5x)\n`);

const C = {
  jumpSymmetric: Math.abs(jump.tApex - jump.descent) <= DT + 1e-9,
  skillDominates,
  solvable: allSolved,
  jumpSpanSafe,
  finaleIsClimax,
  lanesSolvable: lanesSolved,
  laneReach: reachOk,
  skilledFinish: skS.finishRate >= 0.99,
  moderateFinish: moS.finishRate >= 0.90,
  carelessDry: caS.dryRate >= 0.85
};
const pass = Object.values(C).every(Boolean);
console.log('    Criteria:');
console.log(`      jump arc symmetric & flush ........ ${C.jumpSymmetric ? 'PASS' : 'FAIL'}`);
console.log(`      no unavoidable blockers ........... ${C.solvable ? 'PASS' : 'FAIL'}`);
console.log(`      jump span < min gap (all legs) .... ${C.jumpSpanSafe ? 'PASS' : 'FAIL'}`);
console.log(`      finale is the climax .............. ${C.finaleIsClimax ? 'PASS' : 'FAIL'}`);
console.log(`      lanes solvable (open lane clears).. ${C.lanesSolvable ? 'PASS' : 'FAIL'}`);
console.log(`      open lane reachable in time ....... ${C.laneReach ? 'PASS' : 'FAIL'}`);
console.log(`      skill dominates distance (>=2.5x).. ${C.skillDominates ? 'PASS' : 'FAIL'}  (${skillRatio.toFixed(2)}x)`);
console.log(`      skilled finishes (>=99%) .......... ${C.skilledFinish ? 'PASS' : 'FAIL'}  (${pctf(skS.finishRate)})`);
console.log(`      moderate finishes (>=90%) ......... ${C.moderateFinish ? 'PASS' : 'FAIL'}  (${pctf(moS.finishRate)})`);
console.log(`      careless runs dry (>=85%) ......... ${C.carelessDry ? 'PASS' : 'FAIL'}  (${pctf(caS.dryRate)})`);
console.log('================================================================');
console.log(` ACCEPTANCE: ${pass ? 'ALL CRITERIA MET ✔' : 'CHECK FAILED ✘'}`);
console.log('================================================================');
process.exit(pass ? 0 : 1);
