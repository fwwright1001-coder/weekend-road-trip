/* ============================================================
 * Weekend Road Trip — single-player 2D side-scroller
 * ENGR 5513 Applied AI in Engineering · Lipscomb MSAI · Summer 2026
 * Forrest Wright
 *
 * Drive Marty's GT from the city to the coast in one tank
 * of gas. Jump potholes, duck under stop signs, grab fuel & snacks.
 * Don't run out of gas before you reach the ocean.
 *
 * Architecture (single-file, no dependencies, no build step):
 *   - Canvas 2D rendering, requestAnimationFrame loop
 *   - State machine: title, playing, paused, gameover, win, initials, scores,
 *     achievements, settings, ghost race, help
 *   - HTML/CSS overlays handle all menus + HUD (crisp typography)
 *   - 5-layer parallax + procedural per-biome scenery
 *   - Obstacle/collectible spawner + AABB collision
 *   - Particle pool (smoke, sparks, dust, pickup bursts)
 *   - Screen shake on impact
 *   - High scores, achievements, settings, and ghost replays persisted to localStorage
 * ============================================================ */

(() => {
  'use strict';

  // ============================================================
  // CONFIG
  // ============================================================
  // --- Logical coordinate space (device-independent) ----------------------
  // VIEW_W/VIEW_H are the single source of truth for the game's coordinate
  // space. ALL gameplay + draw math is authored in this fixed 960x540 space;
  // the canvas backing store is sized separately for the device's pixels (see
  // resizeCanvas) and a setTransform scales logical -> device every frame, so
  // nothing below ever has to know the real pixel resolution.
  const VIEW_W = 960;
  const VIEW_H = 540;
  // Legacy short aliases — kept so existing W/H references stay unchanged.
  const W = VIEW_W;
  const H = VIEW_H;

  // --- Vertical / ground-contact geometry -------------------------------
  // GROUND_Y is the physics anchor: the player's resting `y`, and the datum
  // every scenery layer is drawn from. The car is *drawn* a fixed distance
  // below this anchor so its tyres sit on the asphalt — that distance is
  // CAR_FOOT_OFFSET, and ROAD_SURFACE_Y is the resulting contact line where
  // the wheels (and the car's shadow) rest. Keeping these explicit means the
  // car lands flush every time and the jump arc starts/ends on the same line.
  const GROUND_Y = 432;            // physics anchor (resting player.y) + scenery datum
  const CAR_FOOT_OFFSET = 18;      // px from player.y down to the wheel-contact line
  const ROAD_SURFACE_Y = GROUND_Y + CAR_FOOT_OFFSET;  // 450: where tyres + shadow rest
  const GRAVITY = 0.78;
  const JUMP_V = -16;
  const PLAYER_X = 170;
  const BASE_SPEED = 5;
  const MAX_SPEED = 11.0;          // widened top end (was 9.5); per-leg speedScale escalates toward it
  const SPEED_ACCEL = 0.07;        // (retained for reference; manual throttle retired — speed auto-escalates)
  const SPEED_BRAKE = 0.16;
  const SPEED_DRAG = 0.018;
  const MIN_GAP_TIME = 0.72;       // min seconds between same-lane blockers; the real (speed-aware) gap
                                   // is max(table px, MIN_GAP_TIME * effSpeed). Exceeds the jump arc
                                   // (~0.683s) at every leg's escalated speed — see sim/balance-sim.js.
  // Lanes: 3 horizontal bands. Lane 1 (center) keeps the legacy GROUND_Y datum so
  // all pre-lane jump/duck/scenery/ghost math is the backward-compatible default.
  const LANE_COUNT = 3;
  const LANE_DY = [44, 0, -44];    // vertical offset from GROUND_Y: 0=near/bottom, 1=center, 2=far/top
  const LANE_TWEEN_DUR = 0.16;     // seconds for one lane hop
  const LANE_BUFFER = 0.18;        // queued lane-press window. Must be >= LANE_TWEEN_DUR so a
                                   // press made early in a hop survives to the completion check
                                   // (a 0.12s buffer would expire before a 0.16s tween finished).
  const LANE_COMMIT_FRAC = 0.5;    // past this tween fraction you occupy only the destination lane
  const laneBaseYFor = (i) => GROUND_Y + LANE_DY[Math.max(0, Math.min(LANE_COUNT - 1, i))];
  const FUEL_MAX = 100;
  const FUEL_DRAIN_PER_SEC = 1.4;
  const FUEL_LOW_FRAC = 0.15;      // fuel fraction below which state.fuelLow trips (the audio/UI layer consumes it)
  const HIT_FUEL_PENALTY = 20;     // per-hit fuel cost. Hits are always avoidable (see minBlockingGap), so
                                   // this is a pure skill signal. Bumped 14->20 alongside the auto-throttle
                                   // retune: faster trips drain less by time, so hits must carry the stakes
                                   // (careless play still reliably runs dry — see sim/balance-sim.js).
  const SNACK_POINTS = 50;
  // Nitro power-up — concept contributed by Levi Ray (PR #24). A rare blue
  // lightning bolt that grants a short INVINCIBLE speed-burst on pickup. It is
  // fairness-neutral by construction: the balance sim proves the base obstacle
  // stream solvable at MAX_SPEED, and you can't be unfairly blocked while you're
  // invincible — so nitro never touches that proof. The obstacle SPAWN cadence
  // stays on base speed (only world motion + distance scale during the burst),
  // and the spawn chance is carved from the obstacle-pattern share, so nitro only
  // ever makes a run easier, never denser.
  const NITRO_DURATION = 3.5;        // seconds of invincible boost
  const NITRO_SPEED_MULT = 1.4;      // world-scroll + distance multiplier while active
  const NITRO_POINTS = 250;          // pickup bonus (pre-combo)
  const NITRO_SPAWN_CHANCE = 0.03;   // rare; taken from the obstacle-pattern probability
  const FUEL_PICKUP_BONUS = 25;
  const FUEL_PICKUP_REFILL = 22;   // default fuel-per-can; per-leg override lives in DIFFICULTY
  const PITSTOP_REFILL = 28;       // fuel added per pit stop. Trimmed 40->28 with the auto-throttle retune
                                   // so pit stops are a strong help, not a careless-player bailout. Still the
                                   // biggest single fuel pickup + 500 pts, but the lose condition stays real.
  const SPAWN_MIN_INTERVAL = 0.32; // hard floor on seconds between spawn rolls
  const BIOME_BONUS = 500;

  // Developer flag. Off in shipped builds; enable via "?debug" in the URL or
  // localStorage 'wrt.debug'='1'. Gates the backtick hitbox/difficulty overlay
  // (physics/balance) AND auto-running the self-test harness on boot (audio/a11y).
  const DEBUG = (() => {
    try {
      return /[?&]debug(=1)?(&|$)/.test(location.search) || localStorage.getItem('wrt.debug') === '1';
    } catch (e) { return false; }
  })();
  const STORAGE_KEY = 'wrt.highscores.v2';
  const SETTINGS_KEY = 'wrt.settings.v1';
  const ACHIEVEMENTS_KEY = 'wrt.achievements.v1';
  const GHOST_KEY = 'wrt.ghost.v1';
  const SANDBOX_KEY = 'wrt.sandbox.v1';   // set when the player reaches the coast — unlocks the GTA sandbox entry
  const MUTE_KEY = 'wrt.muted.v1';     // legacy; migrated into SETTINGS_KEY on load
  const MAX_SCORES = 5;
  const GHOST_SAMPLE_STEP = 0.08;
  const GHOST_DISTANCE_SCALE = 0.28;

  // Per-run player-car liveries. startRun() picks one at random so every drive
  // looks a little different; red stays in the pool so "Marty's red GT"
  // still shows up. The GT-car port can read the same state.carStyle (drawPlayer),
  // so the randomization survives the eventual art swap.
  const CAR_LIVERIES = [
    { name: 'Classic Red',   body: '#c81e28', stripe: '#ffffff' },
    { name: 'Racing Blue',   body: '#1f6feb', stripe: '#ffffff' },
    { name: 'British Green', body: '#1f7a3d', stripe: '#ffd23f' },
    { name: 'Sunset Orange', body: '#e8581c', stripe: '#1a1a26' },
    { name: 'Sunflower',     body: '#f3c218', stripe: '#1a1a26' },
    { name: 'Plum',          body: '#7a3ea8', stripe: '#ffffff' },
    { name: 'Teal',          body: '#138a8a', stripe: '#ffffff' },
    { name: 'Graphite',      body: '#2a2d33', stripe: '#e0564a' },
    { name: 'Pearl White',   body: '#e8e8ee', stripe: '#c81e28' }
  ];
  function pickCarStyle() {
    return CAR_LIVERIES[Math.floor(Math.random() * CAR_LIVERIES.length)];
  }

  // Each biome covers a stretch of the road. Total trip = 20000 units.
  // Lengths are paced so each biome reads as a distinct "leg" of the drive.
  // Each biome has its own palette (sky, sun, ground) and time-of-day.
  //
  // === EXTENSION POINT: BIOMES ===
  // Add a new biome by pushing another object to this array (see CONTRIBUTING.md).
  // You'll also want to add a `case 'YOURNAME':` branch in drawMidScenery()
  // for biome-specific scenery.
  const BIOMES = [
    {
      name: 'CITY',
      end: 5000,
      timeOfDay: 'dawn',
      sky: ['#fbb87d', '#fde4b8', '#9bc3e0'],
      sunColor: '#fff0c0',
      sunY: 130,
      mountainColor: '#5a5670',
      ground: '#3a3a40',
      grass: '#3a5a3a',
      road: '#222226',
      dashColor: '#ffea88',
      birdColor: '#222222'
    },
    {
      name: 'FOREST',
      end: 10000,
      timeOfDay: 'morning',
      sky: ['#7ec3e8', '#bce0f0', '#e8f4ec'],
      sunColor: '#fff6d8',
      sunY: 95,
      mountainColor: '#3a5a3a',
      ground: '#2d4a2d',
      grass: '#456f3a',
      road: '#222226',
      dashColor: '#ffea88',
      birdColor: '#5a3a1f'  // hawks
    },
    {
      name: 'DESERT',
      end: 15000,
      timeOfDay: 'afternoon',
      sky: ['#f5b27a', '#f9d6a0', '#cce0e8'],
      sunColor: '#ffd680',
      sunY: 110,
      mountainColor: '#a67050',
      ground: '#c69065',
      grass: '#b88a5a',
      road: '#3a3338',
      dashColor: '#ffea88',
      birdColor: '#3a3a3a'  // vultures
    },
    {
      name: 'COAST',
      end: 20000,
      timeOfDay: 'sunset',
      sky: ['#ff7e3a', '#ffb37a', '#ffd9a8'],
      sunColor: '#ffe0a0',
      sunY: 200,
      mountainColor: '#a06a8a',
      ground: '#e8c890',
      grass: '#c8a880',
      road: '#2a2a30',
      dashColor: '#ffea88',
      birdColor: '#eeeeee'  // seagulls
    }
  ];
  const TRIP_TOTAL = BIOMES[BIOMES.length - 1].end;

  // ============================================================
  // DIFFICULTY CURVE  — single, reviewable source of truth for balance
  // ============================================================
  // One entry per leg, index-aligned with BIOMES. All gameplay tuning lives
  // here so balance is data-driven: tweak a number, not a code path.
  //
  //   obstacleDensity : relative spawn cadence (×). Higher = more frequent spawn
  //                     rolls. NOTE: at high speed minBlockingGap (below), not
  //                     this knob, dominates how many *blockers* actually land —
  //                     a rejected blocker leaves empty road. So obstacleDensity
  //                     mostly scales pickup/empty cadence once you're fast; it
  //                     is the blocker lever only at low speed.
  //   minBlockingGap  : minimum on-screen px between two consecutive *blocking*
  //                     obstacles (pothole/cone/sign). Sized so two blockers can
  //                     never be unavoidable at MAX_SPEED — a full jump arc spans
  //                     ~390px at MAX_SPEED, so every value below clears that with
  //                     margin. (The real guarantee is the constructive zero-collision
  //                     solvability proof in sim/balance-sim.js — see BALANCE.md.)
  //   fuelSpawnRate   : multiplier on the fuel-can spawn probability for this leg.
  //   fuelPerCan      : fuel restored per can collected on this leg.
  //   speedScale      : reserved per-leg pacing multiplier (1 = stock).
  //
  // The COAST row is intentionally the kindest on fuel: the finale should feel
  // like a payoff for a clean run, not a wall. De-clustering (minBlockingGap)
  // plus the fuel bump together fix the "runs dry at ~96%" cliff.
  //   speedScale      : per-leg pacing multiplier. Effective top speed for a leg
  //                     is MAX_SPEED * speedScale, ramped within the leg, so the
  //                     trip ACCELERATES toward COAST — the finale is the climax.
  //   patternWeights  : spawn mix across lanes — single (1 lane), wallGap (2 lanes
  //                     blocked, 1 open), layered (full-width single-verb wall:
  //                     all-jump or all-duck), chicane (two offset singles, a weave).
  //   maxLaneSpan     : max lanes a non-layered pattern may block (1 = singles only,
  //                     2 = wallGap/chicane allowed). The fairness invariant: a
  //                     non-layered pattern never blocks all 3 lanes (>=1 stays open).
  const DIFFICULTY = [
    { obstacleDensity: 1.00, minBlockingGap: 660, fuelSpawnRate: 1.00, fuelPerCan: 22, speedScale: 1.00, maxLaneSpan: 1, patternWeights: { single: 0.80, wallGap: 0.15, layered: 0.05, chicane: 0.00 } }, // CITY
    { obstacleDensity: 1.20, minBlockingGap: 640, fuelSpawnRate: 1.00, fuelPerCan: 22, speedScale: 1.12, maxLaneSpan: 1, patternWeights: { single: 0.55, wallGap: 0.30, layered: 0.10, chicane: 0.05 } }, // FOREST
    { obstacleDensity: 1.40, minBlockingGap: 640, fuelSpawnRate: 1.05, fuelPerCan: 24, speedScale: 1.28, maxLaneSpan: 2, patternWeights: { single: 0.38, wallGap: 0.34, layered: 0.18, chicane: 0.10 } }, // DESERT
    { obstacleDensity: 1.65, minBlockingGap: 620, fuelSpawnRate: 1.25, fuelPerCan: 28, speedScale: 1.45, maxLaneSpan: 2, patternWeights: { single: 0.25, wallGap: 0.34, layered: 0.23, chicane: 0.18 } }  // COAST
  ];

  const SCREEN = {
    TITLE: 'title',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAMEOVER: 'gameover',
    WIN: 'win',
    INITIALS: 'initials',
    SCORES: 'scores',
    ACHIEVEMENTS: 'achievements',
    GHOST: 'ghost',
    SETTINGS: 'settings',
    HELP: 'help'
  };

  const DEFAULT_SETTINGS = {
    screenShake: true,
    colorblind: false,
    ghostVisible: true,
    // Audio — all folded into the single wrt.settings.v1 key. The legacy
    // wrt.muted.v1 key is migrated on first load (see loadSettings).
    muted: false,
    sfxEnabled: true,
    masterVolume: 0.7,          // 0..1; scales AUDIO_BASE_GAIN at the master bus
    // Accessibility — reduceMotion is seeded from the OS prefers-reduced-motion
    // hint at load time, then persists once the player sets it explicitly.
    reduceMotion: false
  };

  // Spoken labels for the screen-reader live region on each screen change.
  const SCREEN_LABELS = {
    [SCREEN.TITLE]: 'Title screen',
    [SCREEN.PLAYING]: 'Trip started',
    [SCREEN.PAUSED]: 'Paused',
    [SCREEN.GAMEOVER]: 'Out of gas. Game over',
    [SCREEN.WIN]: 'You reached the coast. You win',
    [SCREEN.INITIALS]: 'New high score. Enter your initials',
    [SCREEN.SCORES]: 'High scores',
    [SCREEN.ACHIEVEMENTS]: 'Achievements',
    [SCREEN.GHOST]: 'Ghost race',
    [SCREEN.SETTINGS]: 'Settings',
    [SCREEN.HELP]: 'Controls'
  };

  const ACHIEVEMENTS = [
    { id: 'start', title: 'PTO Approved', desc: 'Start a weekend run.' },
    { id: 'first-jump', title: 'Clearance Check', desc: 'Jump over your first hazard.' },
    { id: 'first-hit', title: 'Rental Insurance', desc: 'Survive your first collision.' },
    { id: 'snack', title: 'Roadside Calories', desc: 'Collect a snack pickup.' },
    { id: 'fuel', title: 'Tank Top-Off', desc: 'Collect a fuel can.' },
    { id: 'pitstop', title: 'Full-Service Stop', desc: 'Pull through a pit stop.' },
    { id: 'combo-5', title: 'Perfect Snack Line', desc: 'Build a 5-chain combo.' },
    { id: 'combo-15', title: 'In the Zone', desc: 'Build a 15-chain combo.' },
    { id: 'combo-25', title: 'Untouchable', desc: 'Max out a 25-chain combo.' },
    { id: 'max-speed', title: 'Cruise Control Hero', desc: 'Reach top speed.' },
    { id: 'low-fuel', title: 'Running on Fumes', desc: 'Keep driving below 15 percent fuel.' },
    { id: 'forest', title: 'Into the Pines', desc: 'Reach the forest biome.' },
    { id: 'desert', title: 'Desert Heat', desc: 'Reach the desert biome.' },
    { id: 'coast', title: 'Coastbound', desc: 'Reach the coast biome.' },
    { id: 'halfway', title: 'Halfway There', desc: 'Drive past the midpoint.' },
    { id: 'score-3000', title: 'Scoreboard Material', desc: 'Score at least 3,000 points.' },
    { id: 'finish', title: 'Ocean View', desc: 'Finish the coast-to-coast trip.' },
    { id: 'clean-finish', title: 'No-Deductible Drive', desc: 'Finish without hitting an obstacle.' },
    { id: 'ghost-save', title: 'Ghost Writer', desc: 'Save a replay ghost from a run.' },
    { id: 'ghost-race', title: 'Race the Replay', desc: 'Start a run with a ghost loaded.' }
  ];

  // ============================================================
  // STATE
  // ============================================================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // ============================================================
  // DEVICE-PIXEL-RATIO-AWARE RENDERING
  // ------------------------------------------------------------
  // The canvas keeps its CSS size (driven entirely by styles.css), but its
  // backing store is sized to CSS-pixels * devicePixelRatio so HiDPI / Retina
  // displays and large windows render at native resolution instead of being
  // upscaled (blurry) by the browser. The game itself never leaves the fixed
  // VIEW_W x VIEW_H logical space — applyViewTransform() maps that space onto
  // whatever the real backing store happens to be, once per frame.
  //
  // Why imageSmoothingEnabled is left at its default (true): this game draws
  // only flat-vector shapes, gradients, and text — none of which are affected
  // by the smoothing flag (it only governs drawImage/pattern scaling, of which
  // there are none here). Gradients/backgrounds therefore stay smooth and
  // shapes/text stay crisp purely because setTransform — not CSS — performs the
  // upscale. If photographic background images are ever added, keep smoothing
  // true for those draws and the rest will remain sharp.
  const MAX_DPR = 3;   // clamp: beyond ~3x the extra fill cost buys nothing

  // Size the backing store to the canvas's real on-screen CSS size * DPR.
  // No-ops safely when the canvas is zero-sized (hidden tab / display:none)
  // so we never produce a 0-dimension buffer or a NaN transform.
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return; // hidden — keep last good size
    const dpr = Math.max(1, Math.min(MAX_DPR, window.devicePixelRatio || 1));
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);
    // Only touch the backing store when it actually changed — assigning
    // canvas.width/height clears the canvas and resets the 2D context state.
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    // CSS size is intentionally NOT set here — styles.css owns it (width/height
    // 100% of the aspect-locked #frame), so the canvas is never CSS-stretched.
  }

  // Re-establish the logical->device transform. Called at the very top of every
  // frame because setTransform replaces the whole matrix and the per-frame
  // save()/translate(shake)/restore() in render() all hang off this base.
  function applyViewTransform() {
    const sx = canvas.width / VIEW_W;
    const sy = canvas.height / VIEW_H;
    if (sx > 0 && sy > 0 && isFinite(sx) && isFinite(sy)) {
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
    }
  }

  // Coalesce bursts of resize/orientation events into a single relayout.
  let resizeRaf = 0;
  let resizeDebounce = 0;
  function scheduleResize() {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(resizeCanvas);
    }, 100);
  }

  // Fire resizeCanvas when the DPR itself changes (e.g. dragging the window to
  // a monitor with a different scale factor, or OS zoom). A media query bound
  // to the current dppx stops matching the instant DPR changes; we re-arm it
  // after each change since the threshold moves with the new ratio.
  function watchDpr() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => { resizeCanvas(); watchDpr(); };
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange, { once: true });
    } else if (mq.addListener) { // legacy Safari/old Edge
      const legacy = () => { mq.removeListener(legacy); onChange(); };
      mq.addListener(legacy);
    }
  }

  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
  window.addEventListener('load', resizeCanvas); // re-measure once layout settles
  resizeCanvas();  // size correctly before the first frame is drawn
  watchDpr();

  const state = {
    screen: SCREEN.TITLE,
    prevScreen: SCREEN.TITLE,
    keys: new Set(),
    pad: {},
    padPrev: {},
    padConnected: false,
    carStyle: CAR_LIVERIES[0],     // current run's livery; randomized in startRun()
    settings: loadSettings(),
    achievements: loadAchievements(),
    achievementToast: null,
    // gameplay
    distance: 0,
    score: 0,
    speed: 0,
    fuel: FUEL_MAX,
    biomeIdx: 0,
    biomeAnnounced: -1,
    obstacles: [],
    collectibles: [],
    nitro: 0,          // seconds remaining on the nitro boost (0 = inactive)
    particles: [],
    spawnTimer: 0,
    // --- Fuel-low contract (physics produces, HUD/audio consume; read-only) ---
    // `fuelLow` is true while fuel sits in the danger band (< FUEL_LOW_FRAC of
    // FUEL_MAX) and is not yet empty. `fuelLowJustEntered` is a single-frame
    // rising edge consumers can latch a one-shot warning (sound/flash) to.
    fuelLow: false,
    fuelLowJustEntered: false,
    debug: false,            // hidden overlay toggle (only flips when DEBUG === true)
    flashTimer: 0,
    shakeT: 0,
    shakeMag: 0,
    // player
    player: {
      y: GROUND_Y,             // drawn/collision y = laneBaseY - jumpOff (derived each frame)
      vy: 0,                   // jump velocity in jumpOff space (positive = rising)
      jumpOff: 0,              // height above the current lane base (>=0)
      ducking: false,
      jumping: false,
      tilt: 0,
      wheelAngle: 0,
      bob: 0,
      // lanes (geometry live now; input/tween land in the next commit)
      lane: 1,                 // 0 = far/top, 1 = center (= legacy GROUND_Y), 2 = near/bottom
      laneTarget: 1,
      laneBaseY: GROUND_Y,
      laneFromBaseY: GROUND_Y,
      laneTweenT: 0,
      laneBufferDir: 0,
      laneBufferT: 0,
      laneTilt: 0
    },
    // initials entry
    initials: ['A', 'A', 'A'],
    initialsIdx: 0,
    pendingScore: 0,
    // combo system
    combo: 0,
    comboTimer: 0,
    comboPopupT: 0,
    // floating "+50" texts
    scorePopups: [],
    runTime: 0,
    runStats: { hits: 0, pickups: 0, fuel: 0, snacks: 0, pitstops: 0 },
    // mini-events
    semis: [],
    nextSemiAt: 8,
    nextPitstopAt: 2200,
    // birds
    birds: [],
    nextBirdAt: 3,
    // asynchronous ghost race
    ghostLoaded: loadGhost(),
    ghostRecording: null,
    ghostSampleTimer: 0,
    ghostMessage: '',
    // scores
    scores: []
  };
  const COMBO_BASE_WINDOW = 4.0;  // base seconds before combo resets; shrinks as combo climbs
  const COMBO_CEILING = 25;       // soft cap on combo COUNT (bounds runaway), but the multiplier
                                  // keeps climbing — combo is now the score engine, not a flat x5.
  // Score multiplier from combo count: 1x, 1.6x, 2.2x ... combo5=3.4x, combo10=6.4x, combo20=12.4x.
  const comboMult = (c) => 1 + Math.max(0, c - 1) * 0.6;
  // Decay window tightens with combo so a long chain demands near-continuous skill.
  const comboWindow = (c) => Math.max(1.5, COMBO_BASE_WINDOW - c * 0.12);

  // ============================================================
  // STORAGE
  // ============================================================
  function loadScores() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.slice(0, MAX_SCORES) : [];
    } catch (e) {
      return [];
    }
  }
  function saveScores(scores) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scores.slice(0, MAX_SCORES)));
    } catch (e) {
      // localStorage unavailable — game still works per session
    }
  }
  function qualifies(score) {
    if (state.scores.length < MAX_SCORES) return true;
    return score > state.scores[state.scores.length - 1].score;
  }
  function insertScore(initials, score) {
    state.scores.push({
      initials: initials.join(''),
      score: Math.floor(score),
      date: new Date().toISOString().slice(0, 10)
    });
    state.scores.sort((a, b) => b.score - a.score);
    state.scores = state.scores.slice(0, MAX_SCORES);
    saveScores(state.scores);
  }

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }
  function legacyMutePref() {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
  }
  function loadSettings() {
    // Defaults first; the OS reduce-motion hint and the legacy mute key seed the
    // initial values, then an explicitly-saved wrt.settings.v1 overrides them.
    const seeded = {
      ...DEFAULT_SETTINGS,
      reduceMotion: prefersReducedMotion(),
      muted: legacyMutePref()
    };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const s = { ...seeded, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
      // Coerce/clamp so a stale or hand-edited payload can never break audio/UI.
      let vol = Number(s.masterVolume);
      if (!Number.isFinite(vol)) vol = DEFAULT_SETTINGS.masterVolume;
      s.masterVolume = Math.max(0, Math.min(1, vol));
      ['screenShake', 'colorblind', 'ghostVisible', 'muted', 'sfxEnabled', 'reduceMotion']
        .forEach((k) => { s[k] = !!s[k]; });
      return s;
    } catch (e) {
      return { ...seeded };
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (e) {
      // Settings are optional; defaults still work.
    }
  }
  function loadAchievements() {
    try {
      const raw = localStorage.getItem(ACHIEVEMENTS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }
  function saveAchievements() {
    try {
      localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(state.achievements));
    } catch (e) {
      // localStorage unavailable: achievements still unlock for this session.
    }
  }
  function achievementById(id) {
    return ACHIEVEMENTS.find((a) => a.id === id);
  }
  function unlockAchievement(id) {
    if (state.achievements[id]) return;
    const item = achievementById(id);
    if (!item) return;
    state.achievements[id] = new Date().toISOString();
    state.achievementToast = { title: item.title, t: 3.0 };
    saveAchievements();
    if (state.screen === SCREEN.ACHIEVEMENTS) renderAchievementsList();
  }

  function loadGhost() {
    try {
      const raw = localStorage.getItem(GHOST_KEY);
      return raw ? normalizeGhost(JSON.parse(raw)) : null;
    } catch (e) {
      return null;
    }
  }
  function saveGhost(ghost) {
    try {
      localStorage.setItem(GHOST_KEY, JSON.stringify(ghost));
    } catch (e) {
      // Ghost race export still works through the text box if storage is blocked.
    }
  }
  function normalizeGhost(data) {
    if (!data || data.version !== 1 || data.game !== 'Weekend Road Trip') return null;
    if (!Array.isArray(data.frames) || data.frames.length < 2) return null;
    const frames = data.frames
      .filter((f) => Array.isArray(f) && f.length >= 5)
      .map((f) => [
        Number(f[0]) || 0,
        Number(f[1]) || 0,
        Number(f[2]) || GROUND_Y,
        Number(f[3]) || BASE_SPEED,
        Number(f[4]) || 0
      ]);
    if (frames.length < 2) return null;
    return {
      version: 1,
      game: 'Weekend Road Trip',
      created: String(data.created || new Date().toISOString()),
      outcome: data.outcome === 'win' ? 'win' : 'gameover',
      score: Math.floor(Number(data.score) || 0),
      distance: Math.max(0, Number(data.distance) || frames[frames.length - 1][1]),
      duration: Math.max(0, Number(data.duration) || frames[frames.length - 1][0]),
      frames
    };
  }

  // ============================================================
  // AUDIO (Web Audio API — procedural, no assets)
  // ============================================================
  // Engine drone is a continuous oscillator pitched by speed.
  // Pickups, hits, jumps, win/lose are short envelope shapes.
  // Mute / master volume / SFX-enabled all live in state.settings (persisted to
  // wrt.settings.v1); the accessors below keep the audio graph in sync with that
  // single source of truth. The legacy wrt.muted.v1 key is READ once as a
  // migration seed (see loadSettings) and never written by the current code.
  const AUDIO_BASE_GAIN = 0.5;   // master level at volume=1.0, unmuted
  const audio = {
    ctx: null,
    master: null,
    engineOsc: null,
    engineGain: null,

    get muted() { return !!state.settings.muted; },
    get sfxOn() { return state.settings.sfxEnabled !== false; },
    masterLevel() {
      if (this.muted) return 0;
      let v = Number(state.settings.masterVolume);
      if (!Number.isFinite(v)) v = DEFAULT_SETTINGS.masterVolume;
      return Math.max(0, Math.min(1, v)) * AUDIO_BASE_GAIN;
    },

    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.masterLevel();
        this.master.connect(this.ctx.destination);
      } catch (e) { /* no audio available — game still works */ }
    },
    // Re-apply mute/volume to the live master bus. Safe to call before init().
    refresh() {
      if (this.master && this.ctx) {
        this.master.gain.setTargetAtTime(this.masterLevel(), this.ctx.currentTime, 0.02);
      }
    },
    setMuted(m) {
      state.settings.muted = !!m;
      saveSettings();
      this.refresh();
      syncSettingsInputs();
    },
    toggle() {
      this.setMuted(!this.muted);
      showAudioBanner(this.muted ? 'SOUND OFF' : 'SOUND ON');
      announce(this.muted ? 'Audio muted' : 'Audio on');
    },

    // Continuous engine — pitch tied to speed
    startEngine() {
      if (!this.ctx || this.engineOsc) return;
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 90;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 600;
      const gain = ctx.createGain();
      gain.gain.value = 0.0;
      osc.connect(filt); filt.connect(gain); gain.connect(this.master);
      osc.start();
      this.engineOsc = osc;
      this.engineGain = gain;
      this.engineFilt = filt;
      // ramp in
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.4);
    },
    stopEngine() {
      if (!this.engineOsc) return;
      const ctx = this.ctx;
      this.engineGain.gain.cancelScheduledValues(ctx.currentTime);
      this.engineGain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 0.2);
      const osc = this.engineOsc;
      setTimeout(() => { try { osc.stop(); } catch {} }, 260);
      this.engineOsc = null;
    },
    updateEngine(speedFrac) {
      if (!this.engineOsc) return;
      const f = 80 + speedFrac * 220;
      this.engineOsc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
      this.engineFilt.frequency.setTargetAtTime(500 + speedFrac * 900, this.ctx.currentTime, 0.08);
    },

    // One-shot helpers
    blip({ freq = 600, freq2 = freq, dur = 0.12, type = 'triangle', vol = 0.25 } = {}) {
      if (!this.ctx || !this.sfxOn) return;   // SFX toggle gates all one-shots
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq2), t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + dur + 0.02);
    },
    noiseHit(dur = 0.18) {
      if (!this.ctx || !this.sfxOn) return;
      const t = this.ctx.currentTime;
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 800;
      const g = this.ctx.createGain();
      g.gain.value = 0.4;
      src.connect(filt); filt.connect(g); g.connect(this.master);
      src.start(t);
      // Low thump alongside
      this.blip({ freq: 90, freq2: 50, dur: 0.18, type: 'sine', vol: 0.4 });
    },
    // === EXTENSION POINT: AUDIO ===
    // Add your own sound effects here. Use this.blip({freq, freq2, dur, type, vol})
    // for tone sweeps or this.noiseHit(dur) for noise bursts.
    playJump()   { this.blip({ freq: 480, freq2: 720, dur: 0.10, type: 'sine', vol: 0.16 }); },
    playSnack()  { this.blip({ freq: 880, freq2: 1320, dur: 0.10, type: 'triangle', vol: 0.22 }); },
    playFuel()   { this.blip({ freq: 660, freq2: 990, dur: 0.16, type: 'triangle', vol: 0.25 }); },
    playHit()    { this.noiseHit(); },
    playComboBreak() {
      // short descending two-tone — distinct from the noise hit
      this.blip({ freq: 520, freq2: 300, dur: 0.18, type: 'triangle', vol: 0.16 });
    },
    playLaneHop() {
      // quick low "whoosh" tick for a lane change — subtle so rapid weaving doesn't grate
      this.blip({ freq: 300, freq2: 420, dur: 0.07, type: 'sine', vol: 0.10 });
    },
    playBiome()  {
      // ascending arpeggio C E G
      [523, 659, 784].forEach((f, i) => setTimeout(() =>
        this.blip({ freq: f, freq2: f, dur: 0.18, type: 'triangle', vol: 0.18 }), i * 80));
    },
    playWin() {
      [523, 659, 784, 1046].forEach((f, i) => setTimeout(() =>
        this.blip({ freq: f, freq2: f, dur: 0.28, type: 'triangle', vol: 0.24 }), i * 140));
    },
    playLose() {
      [392, 330, 277, 220].forEach((f, i) => setTimeout(() =>
        this.blip({ freq: f, freq2: f, dur: 0.26, type: 'sawtooth', vol: 0.22 }), i * 130));
    },
    // Duck: short downward "whump".
    playDuck() { this.blip({ freq: 360, freq2: 200, dur: 0.10, type: 'sine', vol: 0.14 }); },
    // Combo escalation: a brief tick whose pitch climbs with the combo level, so
    // each step reads as forward progress. Very short + quiet so it layers over
    // the pickup sound without fatigue.
    playCombo(level) {
      const n = Math.max(2, level | 0);
      const base = 620 + (n - 2) * 130;
      this.blip({ freq: base, freq2: base * 1.5, dur: 0.07, type: 'triangle', vol: 0.10 });
    },
    // Low-fuel warning: two soft falling beeps — a nudge, not an alarm.
    playLowFuel() {
      this.blip({ freq: 520, freq2: 380, dur: 0.14, type: 'triangle', vol: 0.16 });
      setTimeout(() => this.blip({ freq: 430, freq2: 300, dur: 0.16, type: 'triangle', vol: 0.16 }), 150);
    }
  };
  let audioBanner = { text: '', t: 0 };
  function showAudioBanner(text) { audioBanner = { text, t: 1.3 }; }

  // ============================================================
  // DOM REFS
  // ============================================================
  const hudEl = document.getElementById('hud');
  const overlayEl = document.getElementById('overlay');
  const screenEls = {
    [SCREEN.TITLE]: document.getElementById('screen-title'),
    [SCREEN.PAUSED]: document.getElementById('screen-paused'),
    [SCREEN.GAMEOVER]: document.getElementById('screen-gameover'),
    [SCREEN.WIN]: document.getElementById('screen-win'),
    [SCREEN.INITIALS]: document.getElementById('screen-initials'),
    [SCREEN.SCORES]: document.getElementById('screen-scores'),
    [SCREEN.ACHIEVEMENTS]: document.getElementById('screen-achievements'),
    [SCREEN.GHOST]: document.getElementById('screen-ghost'),
    [SCREEN.SETTINGS]: document.getElementById('screen-settings'),
    [SCREEN.HELP]: document.getElementById('screen-help')
  };
  const hudScore = document.getElementById('hud-score');
  const hudBiome = document.getElementById('hud-biome');
  const hudTrip = document.getElementById('hud-trip');
  const hudMph = document.getElementById('hud-mph');
  const hudFuel = document.getElementById('hud-fuel');
  const ghostTitleStatus = document.getElementById('ghost-title-status');
  const ghostPayloadEl = document.getElementById('ghost-payload');
  const ghostSummaryEl = document.getElementById('ghost-summary');
  const ghostMessageEl = document.getElementById('ghost-message');
  const settingsInputs = document.querySelectorAll('[data-setting]');
  const hudFuelBar = hudFuel ? hudFuel.parentElement : null;   // .hud-fuel-bar
  const hudTripBar = hudTrip ? hudTrip.parentElement : null;   // .hud-trip-bar
  const liveRegion = document.getElementById('a11y-live');

  // ============================================================
  // ACCESSIBILITY (a11y workstream)
  // ============================================================
  // Polite screen-reader announcements (screen changes, leg transitions, low
  // fuel, run outcome). Clearing first guarantees identical repeats re-announce.
  function announce(msg) {
    if (!liveRegion || !msg) return;
    liveRegion.textContent = '';
    setTimeout(() => { liveRegion.textContent = msg; }, 30);
  }
  function reduceMotionOn() { return !!state.settings.reduceMotion; }
  // The canvas carries a text summary of game state for screen readers.
  function updateCanvasAria() {
    if (!canvas) return;
    let label;
    if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) {
      const b = currentBiome();
      const tripPct = Math.max(0, Math.min(100, Math.round((state.distance / TRIP_TOTAL) * 100)));
      const fuelPct = Math.max(0, Math.min(100, Math.round((state.fuel / FUEL_MAX) * 100)));
      label = 'Weekend Road Trip. Driving through ' + b.name + ', leg ' + (state.biomeIdx + 1) +
        ' of ' + BIOMES.length + '. Trip ' + tripPct + ' percent complete. Fuel ' + fuelPct +
        ' percent. Score ' + (state.score | 0) + (state.screen === SCREEN.PAUSED ? '. Paused.' : '.');
    } else {
      label = 'Weekend Road Trip. ' + (SCREEN_LABELS[state.screen] || 'Menu') +
        '. Use Tab to reach the on-screen buttons.';
    }
    canvas.setAttribute('aria-label', label);
  }
  // One-time ARIA wiring for the canvas + DOM HUD. Applied from JS so the HUD
  // markup (owned by the HUD layer) is left untouched — we only add attributes at runtime.
  function initA11y() {
    try {
      if (canvas) canvas.setAttribute('role', 'img');
      if (hudEl) {
        hudEl.setAttribute('role', 'group');
        hudEl.setAttribute('aria-label', 'Heads-up display');
      }
      [[hudFuelBar, 'Fuel'], [hudTripBar, 'Trip progress']].forEach((pair) => {
        const el = pair[0];
        if (!el) return;
        el.setAttribute('role', 'progressbar');
        el.setAttribute('aria-label', pair[1]);
        el.setAttribute('aria-valuemin', '0');
        el.setAttribute('aria-valuemax', '100');
        el.setAttribute('aria-valuenow', '0');
      });
      // Make each menu screen programmatically focusable (not in the tab order)
      // so focus can be moved into it on a screen change. See applyScreen().
      for (const key in screenEls) {
        if (screenEls[key] && screenEls[key].setAttribute) screenEls[key].setAttribute('tabindex', '-1');
      }
      updateCanvasAria();
    } catch (e) { /* a11y is best-effort; never block the game */ }
  }

  // ============================================================
  // SCREEN MANAGEMENT
  // ============================================================
  function show(target) {
    if (state.screen !== SCREEN.HELP) state.prevScreen = state.screen;
    state.screen = target;
    applyScreen();
  }
  function applyScreen() {
    for (const key in screenEls) screenEls[key].classList.add('hidden');
    if (screenEls[state.screen]) screenEls[state.screen].classList.remove('hidden');
    overlayEl.style.display = state.screen === SCREEN.PLAYING ? 'none' : 'grid';
    hudEl.classList.toggle('hidden',
      state.screen !== SCREEN.PLAYING && state.screen !== SCREEN.PAUSED);
    // Mobile: show touch controls only during active play; release any held
    // touch inputs when we leave PLAYING so an action can't stick (e.g. pause).
    document.body.classList.toggle('playing', state.screen === SCREEN.PLAYING);
    if (state.screen !== SCREEN.PLAYING) releaseTouchHolds();
    if (state.screen === SCREEN.SCORES) renderScoresList();
    if (state.screen === SCREEN.ACHIEVEMENTS) renderAchievementsList();
    if (state.screen === SCREEN.GHOST) renderGhostScreen();
    if (state.screen === SCREEN.SETTINGS) renderSettings();
    if (state.screen === SCREEN.INITIALS) renderInitials();
    if (state.screen === SCREEN.TITLE) updateSandboxEntry();
    // Quiet the engine drone whenever we leave active play (e.g. pause).
    if (audio.engineOsc && audio.engineGain && audio.ctx) {
      const target = state.screen === SCREEN.PLAYING ? 0.18 : 0;
      audio.engineGain.gain.setTargetAtTime(target, audio.ctx.currentTime, 0.05);
    }
    updateGhostTitleStatus();
    announce(SCREEN_LABELS[state.screen] || '');
    updateCanvasAria();
    // A11y focus management (WCAG 2.4.3): move focus into a newly shown menu so
    // it never stays stranded on a now-hidden control; drop focus out of the
    // overlay when gameplay starts so game keys aren't intercepted by a hidden
    // button.
    if (state.screen !== SCREEN.PLAYING) {
      const focusEl = screenEls[state.screen];
      if (focusEl && typeof focusEl.focus === 'function') {
        try { focusEl.focus({ preventScroll: true }); } catch (e) { try { focusEl.focus(); } catch (e2) {} }
      }
    } else if (document.activeElement && overlayEl.contains && overlayEl.contains(document.activeElement)) {
      try { document.activeElement.blur(); } catch (e) {}
    }
  }
  function openHelp() {
    state.prevScreen = state.screen;
    state.screen = SCREEN.HELP;
    applyScreen();
  }

  // ============================================================
  // GTA SANDBOX HANDOFF
  // ============================================================
  // Reaching the coast unlocks a standalone 3D crime-sandbox that lives in the
  // sibling gta-sandbox/ folder. We persist the unlock so the entry also appears
  // on the title menu for returning players, then hand off via a same-origin
  // navigation — the relative path resolves locally, when served, and on Pages.
  const SANDBOX_URL = 'gta-sandbox/#gta';   // land players straight in the on-foot heist (onfoot3d auto-enters on #gta)
  function sandboxUnlocked() {
    try { return localStorage.getItem(SANDBOX_KEY) === '1'; } catch (e) { return false; }
  }
  function unlockSandbox() {
    try { localStorage.setItem(SANDBOX_KEY, '1'); } catch (e) {}
  }
  function enterSandbox() {
    unlockSandbox();
    window.location.href = SANDBOX_URL;
  }
  // Reveal the title-menu entry only once the sandbox has been unlocked.
  function updateSandboxEntry() {
    const btn = document.getElementById('title-sandbox-btn');
    if (btn) btn.classList.toggle('hidden', !sandboxUnlocked());
  }

  // ============================================================
  // INPUT
  // ============================================================
  const KEYMAP = {
    jump: ['Space', 'KeyW', 'ArrowUp'],
    duck: ['KeyS', 'ArrowDown'],
    // Manual throttle retired (speed auto-escalates); A/D + ←/→ now change lanes.
    laneUp: ['KeyD', 'ArrowRight'],     // toward the far/top lane (index +1)
    laneDown: ['KeyA', 'ArrowLeft'],    // toward the near/bottom lane (index -1)
    confirm: ['Enter'],
    pause: ['KeyP', 'Escape'],
    help: ['Slash']
  };
  const isAction = (action, code) => KEYMAP[action] && KEYMAP[action].includes(code);
  const actionDown = (action) =>
    (KEYMAP[action] && KEYMAP[action].some((code) => state.keys.has(code))) || !!state.pad[action];

  window.addEventListener('keydown', (e) => {
    // Don't hijack keys while typing in a form field (e.g. the ghost JSON box).
    const tag = e.target && e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    state.keys.add(e.code);
    // OS key-repeat must NOT re-fire edge-triggered actions (jump, lane hops):
    // held keys still register in state.keys above for continuous reads
    // (duck via actionDown), but routing only runs on the genuine first press.
    // This matches the gamepad edge-trigger and enforces one-hop-per-press.
    if (e.repeat) return;
    if (e.code === 'KeyM') { audio.init(); audio.toggle(); return; }
    // Hidden debug overlay — only reachable in DEBUG builds.
    if (e.code === 'Backquote') { if (DEBUG) state.debug = !state.debug; return; }
    // A focused button activates itself on Enter (native click); don't also run
    // the screen-global confirm, or navigation would fire twice.
    if (e.code === 'Enter' && tag === 'BUTTON') return;
    handleKey(e.code);
  });
  window.addEventListener('keyup', (e) => {
    state.keys.delete(e.code);
    if (isAction('duck', e.code)) state.player.ducking = false;
  });

  // ============================================================
  // TOUCH CONTROLS (mobile)
  // ============================================================
  // On-screen buttons feed the SAME input path as the keyboard (state.keys /
  // tryJump / show), so physics, balance, and every action handler stay
  // identical. Shown only on coarse-pointer devices during play (see styles.css).
  // Each button uses its own pointer events, so multi-touch (gas + jump) works.
  const touchHeld = new Set();           // key codes currently held by a finger
  function releaseTouchHolds() {
    touchHeld.forEach((code) => state.keys.delete(code));
    touchHeld.clear();
    const tcEl = document.getElementById('touch-controls');
    if (tcEl && tcEl.querySelectorAll) {
      tcEl.querySelectorAll('.tc-btn.pressed').forEach((b) => b.classList.remove('pressed'));
    }
  }
  (function bindTouchControls() {
    const tcEl = document.getElementById('touch-controls');
    if (!tcEl || !tcEl.querySelectorAll) return;
    const HOLD = { duck: 'KeyS' };   // duck is the only held touch action now
    tcEl.querySelectorAll('[data-tc]').forEach((btn) => {
      const action = btn.dataset.tc;
      const code = HOLD[action];
      const down = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        audio.init();                                   // unlock audio on first touch
        btn.classList.add('pressed');
        if (action === 'jump') { if (state.screen === SCREEN.PLAYING) tryJump(); }
        else if (action === 'laneUp') { if (state.screen === SCREEN.PLAYING) hopLane(+1); }
        else if (action === 'laneDown') { if (state.screen === SCREEN.PLAYING) hopLane(-1); }
        else if (action === 'pause') { if (state.screen === SCREEN.PLAYING) show(SCREEN.PAUSED); }
        else if (code) { state.keys.add(code); touchHeld.add(code); }
      };
      const up = (e) => {
        if (e && e.preventDefault && e.cancelable) e.preventDefault();
        btn.classList.remove('pressed');
        if (code) { state.keys.delete(code); touchHeld.delete(code); }
      };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
      btn.addEventListener('lostpointercapture', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  })();
  // Drop held inputs if the tab is backgrounded mid-press, so nothing sticks.
  window.addEventListener('blur', releaseTouchHolds);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseTouchHolds(); });

  function handleKey(code) {
    switch (state.screen) {
      case SCREEN.TITLE:
        if (isAction('confirm', code)) startRun();
        else if (code === 'KeyH') show(SCREEN.SCORES);
        else if (code === 'KeyA') show(SCREEN.ACHIEVEMENTS);
        else if (code === 'KeyG') show(SCREEN.GHOST);
        else if (code === 'KeyO') show(SCREEN.SETTINGS);
        else if (isAction('help', code)) openHelp();
        break;
      case SCREEN.PLAYING:
        if (isAction('jump', code)) tryJump();
        if (isAction('duck', code)) state.player.ducking = true;
        if (isAction('laneUp', code)) hopLane(+1);
        if (isAction('laneDown', code)) hopLane(-1);
        if (isAction('pause', code)) show(SCREEN.PAUSED);
        if (isAction('help', code)) openHelp();
        break;
      case SCREEN.PAUSED:
        if (isAction('pause', code) || isAction('confirm', code)) show(SCREEN.PLAYING);
        else if (code === 'KeyQ') { audio.stopEngine(); show(SCREEN.TITLE); }
        break;
      case SCREEN.GAMEOVER:
      case SCREEN.WIN:
        if (isAction('confirm', code)) afterRun();
        break;
      case SCREEN.INITIALS:
        handleInitialsKey(code);
        break;
      case SCREEN.SCORES:
        if (isAction('confirm', code) || code === 'KeyR') show(SCREEN.TITLE);
        break;
      case SCREEN.ACHIEVEMENTS:
      case SCREEN.GHOST:
      case SCREEN.SETTINGS:
        if (isAction('confirm', code) || isAction('pause', code)) {
          show(state.prevScreen === state.screen ? SCREEN.TITLE : state.prevScreen);
        }
        break;
      case SCREEN.HELP:
        if (isAction('help', code) || isAction('confirm', code) || isAction('pause', code)) {
          show(state.prevScreen);
        }
        break;
    }
  }

  function handleInitialsKey(code) {
    if (code === 'ArrowLeft') {
      state.initialsIdx = (state.initialsIdx + 2) % 3;
    } else if (code === 'ArrowRight') {
      state.initialsIdx = (state.initialsIdx + 1) % 3;
    } else if (code === 'ArrowUp') {
      state.initials[state.initialsIdx] = cycleChar(state.initials[state.initialsIdx], +1);
    } else if (code === 'ArrowDown') {
      state.initials[state.initialsIdx] = cycleChar(state.initials[state.initialsIdx], -1);
    } else if (isAction('confirm', code)) {
      insertScore(state.initials, state.pendingScore);
      show(SCREEN.SCORES);
      return;
    } else if (/^Key[A-Z]$/.test(code)) {
      state.initials[state.initialsIdx] = code.slice(3);
      state.initialsIdx = Math.min(2, state.initialsIdx + 1);
    } else if (code === 'Backspace') {
      state.initialsIdx = Math.max(0, state.initialsIdx - 1);
      state.initials[state.initialsIdx] = 'A';
    }
    renderInitials();
  }
  function cycleChar(c, dir) {
    let n = c.charCodeAt(0) + dir;
    if (n > 90) n = 65;
    if (n < 65) n = 90;
    return String.fromCharCode(n);
  }

  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find(Boolean);
    if (!gp) {
      state.pad = {};
      state.padPrev = {};
      state.padConnected = false;
      return;
    }

    const b = (idx) => !!(gp.buttons[idx] && gp.buttons[idx].pressed);
    const axisX = gp.axes[0] || 0;
    const axisY = gp.axes[1] || 0;
    const next = {
      jump: b(0) || b(12),
      duck: b(1) || b(13) || axisY > 0.45,
      // lane changes are edge-triggered (dpad L/R or left-stick X)
      laneUp: b(15) || axisX > 0.45,
      laneDown: b(14) || axisX < -0.45,
      confirm: b(0),
      pause: b(9),
      help: b(8)
    };

    const prev = state.pad;
    state.padConnected = true;
    ['jump', 'laneUp', 'laneDown', 'confirm', 'pause', 'help'].forEach((action) => {
      if (next[action] && !prev[action]) handlePadAction(action);
    });
    state.padPrev = prev;
    state.pad = next;
  }

  function handlePadAction(action) {
    switch (state.screen) {
      case SCREEN.TITLE:
        if (action === 'confirm') startRun();
        if (action === 'help') openHelp();
        break;
      case SCREEN.PLAYING:
        if (action === 'jump') tryJump();
        if (action === 'laneUp') hopLane(+1);
        if (action === 'laneDown') hopLane(-1);
        if (action === 'pause') show(SCREEN.PAUSED);
        if (action === 'help') openHelp();
        break;
      case SCREEN.PAUSED:
        if (action === 'confirm' || action === 'pause') show(SCREEN.PLAYING);
        break;
      case SCREEN.GAMEOVER:
      case SCREEN.WIN:
        if (action === 'confirm') afterRun();
        break;
      case SCREEN.SCORES:
      case SCREEN.ACHIEVEMENTS:
      case SCREEN.GHOST:
      case SCREEN.SETTINGS:
      case SCREEN.HELP:
        if (action === 'confirm' || action === 'pause') {
          show(state.prevScreen === state.screen ? SCREEN.TITLE : state.prevScreen);
        }
        break;
    }
  }

  // Button wiring (mouse parity with keyboard)
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switch (btn.dataset.action) {
        case 'start': startRun(); break;
        case 'scores': show(SCREEN.SCORES); break;
        case 'achievements': show(SCREEN.ACHIEVEMENTS); break;
        case 'ghost': show(SCREEN.GHOST); break;
        case 'settings': show(SCREEN.SETTINGS); break;
        case 'help': openHelp(); break;
        case 'resume': show(SCREEN.PLAYING); break;
        case 'quit': audio.stopEngine(); show(SCREEN.TITLE); break;
        case 'continue': afterRun(); break;
        case 'enter-sandbox': enterSandbox(); break;
        case 'copy-ghost': copyGhostPayload(); break;
        case 'load-ghost': loadGhostFromPayload(); break;
        case 'clear-ghost': clearGhostReplay(); break;
        case 'return':
          if ([SCREEN.ACHIEVEMENTS, SCREEN.GHOST, SCREEN.SETTINGS].includes(state.screen)) {
            show(state.prevScreen === state.screen ? SCREEN.TITLE : state.prevScreen);
          } else {
            show(SCREEN.TITLE);
          }
          break;
      }
    });
  });

  settingsInputs.forEach((input) => {
    const apply = (persist) => {
      const key = input.dataset.setting;
      if (input.type === 'range') {
        let v = Number(input.value);
        if (!Number.isFinite(v)) v = DEFAULT_SETTINGS.masterVolume;
        state.settings[key] = Math.max(0, Math.min(1, v));
      } else {
        state.settings[key] = input.checked;
      }
      if (persist) saveSettings();
      applySettings();
      updateVolumeReadout();
    };
    input.addEventListener('change', () => apply(true));
    // Sliders also fire 'input' continuously while dragging — apply live, but
    // only persist on 'change' (release) to avoid hammering localStorage.
    if (input.type === 'range') input.addEventListener('input', () => apply(false));
  });

  // ============================================================
  // RUN LIFECYCLE
  // ============================================================
  function startRun() {
    state.distance = 0;
    state.score = 0;
    state.speed = BASE_SPEED;
    state.fuel = FUEL_MAX;
    state.biomeIdx = 0;
    state._lastBiomeIdx = 0;
    state.biomeAnnounced = -1;
    state.obstacles = [];
    state.collectibles = [];
    state.nitro = 0;
    state.particles = [];
    state.spawnTimer = 0;
    state.fuelLow = false;
    state.fuelLowJustEntered = false;
    state.flashTimer = 0;
    state.shakeT = 0;
    state.shakeMag = 0;
    state.pendingScore = 0;
    state.player.y = GROUND_Y;
    state.player.vy = 0;
    state.player.jumpOff = 0;
    state.player.jumping = false;
    state.player.jumpBufferT = 0;
    state.player.ducking = false;
    state.player.lane = 1;
    state.player.laneTarget = 1;
    state.player.laneBaseY = GROUND_Y;
    state.player.laneFromBaseY = GROUND_Y;
    state.player.laneTweenT = 0;
    state.player.laneBufferDir = 0;
    state.player.laneBufferT = 0;
    state.player.laneTilt = 0;
    state._duckHeldPrev = false;
    state._lowFuelWarned = false;
    state._ariaTick = 0;
    state.player.tilt = 0;
    state.player.bob = 0;
    state.carStyle = pickCarStyle();   // fresh random livery each run
    state.carNumber = 1 + Math.floor(Math.random() * 99);   // GT-mode door number
    state.combo = 0;
    state.comboTimer = 0;
    state.comboPopupT = 0;
    state.scorePopups = [];
    state.runTime = 0;
    state.runStats = { hits: 0, pickups: 0, fuel: 0, snacks: 0, pitstops: 0 };
    state.semis = [];
    state.nextSemiAt = 8;
    state.nextPitstopAt = 2200;
    state.guaranteedFuelDone = false;
    state.birds = [];
    state.nextBirdAt = 3;
    state.ghostRecording = makeGhostRecording();
    state.ghostSampleTimer = 0;
    if (state.ghostLoaded) unlockAchievement('ghost-race');
    unlockAchievement('start');
    audio.init();
    audio.startEngine();
    show(SCREEN.PLAYING);
  }

  function afterRun() {
    if (qualifies(state.pendingScore || state.score)) {
      state.pendingScore = state.pendingScore || state.score;
      state.initials = ['A', 'A', 'A'];
      state.initialsIdx = 0;
      show(SCREEN.INITIALS);
    } else {
      show(SCREEN.SCORES);
    }
  }

  function renderScoresList() {
    const ol = document.getElementById('scores-list');
    state.scores = loadScores();
    ol.innerHTML = '';
    if (state.scores.length === 0) {
      ol.innerHTML = '<li class="empty"><span class="empty">NO SCORES YET — HIT THE ROAD.</span></li>';
      return;
    }
    state.scores.forEach((s, i) => {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="rank">${i + 1}.</span>` +
        `<span class="player-initials">${s.initials}</span>` +
        `<span class="score">${pad(s.score, 6)}</span>` +
        `<span class="date">${s.date}</span>`;
      ol.appendChild(li);
    });
  }
  function renderInitials() {
    const el = document.getElementById('initials-display');
    el.innerHTML = state.initials.map((c, i) =>
      `<span class="${i === state.initialsIdx ? 'initial active' : 'initial'}">${c}</span>`
    ).join('');
    document.getElementById('initials-score').textContent = pad(state.pendingScore, 6);
  }
  function renderAchievementsList() {
    const el = document.getElementById('achievements-list');
    if (!el) return;
    el.innerHTML = '';
    ACHIEVEMENTS.forEach((item) => {
      const card = document.createElement('div');
      const unlocked = !!state.achievements[item.id];
      card.className = unlocked ? 'achievement unlocked' : 'achievement';

      const title = document.createElement('div');
      title.className = 'achievement-title';
      title.textContent = `${unlocked ? 'UNLOCKED' : 'LOCKED'} - ${item.title}`;

      const desc = document.createElement('div');
      desc.className = 'achievement-desc';
      desc.textContent = item.desc;

      card.appendChild(title);
      card.appendChild(desc);
      el.appendChild(card);
    });
  }
  function syncSettingsInputs() {
    settingsInputs.forEach((input) => {
      const key = input.dataset.setting;
      if (input.type === 'range') input.value = Number(state.settings[key]);
      else input.checked = !!state.settings[key];
    });
    updateVolumeReadout();
  }
  function updateVolumeReadout() {
    const slider = document.getElementById('setting-volume');
    const out = document.getElementById('setting-volume-value');
    const pct = Math.round(Math.max(0, Math.min(1, Number(state.settings.masterVolume))) * 100);
    if (out) out.textContent = pct + '%';
    if (slider) {
      slider.setAttribute('aria-valuenow', String(Math.max(0, Math.min(1, Number(state.settings.masterVolume)))));
      slider.setAttribute('aria-valuetext', pct + '%');
    }
  }
  function renderSettings() {
    syncSettingsInputs();
    applySettings();
  }
  function applySettings() {
    document.body.classList.toggle('colorblind', !!state.settings.colorblind);
    document.body.classList.toggle('reduce-motion', reduceMotionOn());
    audio.refresh();
  }
  function updateGhostTitleStatus() {
    if (!ghostTitleStatus) return;
    const g = state.ghostLoaded;
    if (!g) {
      ghostTitleStatus.textContent = 'No ghost loaded yet.';
      return;
    }
    const pct = Math.min(100, Math.round((g.distance / TRIP_TOTAL) * 100));
    ghostTitleStatus.textContent =
      `Ghost loaded: ${pct}% trip, ${pad(g.score, 6)} points, ${g.duration.toFixed(1)}s.`;
  }
  function ghostPayload() {
    return state.ghostLoaded ? JSON.stringify(state.ghostLoaded) : '';
  }
  function renderGhostScreen() {
    if (!ghostPayloadEl || !ghostSummaryEl || !ghostMessageEl) return;
    const g = state.ghostLoaded;
    if (g) {
      const pct = Math.min(100, Math.round((g.distance / TRIP_TOTAL) * 100));
      ghostSummaryEl.textContent =
        `Loaded ghost: ${pct}% trip, ${pad(g.score, 6)} points, ${g.duration.toFixed(1)} seconds. Start the trip to race it.`;
      ghostPayloadEl.value = ghostPayload();
    } else {
      ghostSummaryEl.textContent =
        'Finish a run to save a transparent replay car. Paste a classmate\'s ghost JSON here to race their line.';
      if (!ghostPayloadEl.value.trim()) ghostPayloadEl.value = '';
    }
    ghostMessageEl.textContent = state.ghostMessage || '';
  }
  function copyGhostPayload() {
    const payload = ghostPayload();
    if (!payload) {
      state.ghostMessage = 'No ghost saved yet. Finish a run first.';
      renderGhostScreen();
      return;
    }
    ghostPayloadEl.value = payload;
    ghostPayloadEl.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload)
        .then(() => {
          state.ghostMessage = 'Ghost JSON copied to clipboard.';
          renderGhostScreen();
        })
        .catch(() => {
          state.ghostMessage = 'Ghost JSON is selected and ready to copy.';
          renderGhostScreen();
        });
    } else {
      state.ghostMessage = 'Ghost JSON is selected and ready to copy.';
      renderGhostScreen();
    }
  }
  function loadGhostFromPayload() {
    try {
      const ghost = normalizeGhost(JSON.parse(ghostPayloadEl.value));
      if (!ghost) throw new Error('Invalid ghost payload');
      state.ghostLoaded = ghost;
      saveGhost(ghost);
      state.ghostMessage = 'Ghost loaded. Start the trip to race it.';
      unlockAchievement('ghost-race');
    } catch (e) {
      state.ghostMessage = 'That ghost JSON could not be loaded.';
    }
    renderGhostScreen();
    updateGhostTitleStatus();
  }
  function clearGhostReplay() {
    try { localStorage.removeItem(GHOST_KEY); } catch (e) {}
    state.ghostLoaded = null;
    if (ghostPayloadEl) ghostPayloadEl.value = '';
    state.ghostMessage = 'Ghost replay cleared.';
    renderGhostScreen();
    updateGhostTitleStatus();
  }
  function makeGhostRecording() {
    return {
      version: 1,
      game: 'Weekend Road Trip',
      created: new Date().toISOString(),
      outcome: 'gameover',
      score: 0,
      distance: 0,
      duration: 0,
      frames: []
    };
  }
  function ghostControlsMask() {
    return (actionDown('jump') ? 1 : 0) |
      (actionDown('duck') ? 2 : 0) |
      (actionDown('laneUp') ? 4 : 0) |
      (actionDown('laneDown') ? 8 : 0);
  }
  function recordGhostFrame(force = false) {
    if (!state.ghostRecording) return;
    if (!force && state.ghostSampleTimer > 0) return;
    state.ghostSampleTimer = GHOST_SAMPLE_STEP;
    state.ghostRecording.frames.push([
      Number(state.runTime.toFixed(2)),
      Number(state.distance.toFixed(1)),
      Number(state.player.y.toFixed(1)),
      Number(state.speed.toFixed(2)),
      ghostControlsMask()
    ]);
  }
  function finalizeGhost(outcome) {
    if (!state.ghostRecording || state.ghostRecording.frames.length < 2) return;
    recordGhostFrame(true);
    const ghost = state.ghostRecording;
    ghost.outcome = outcome;
    ghost.score = Math.floor(state.pendingScore || state.score);
    ghost.distance = Number(state.distance.toFixed(1));
    ghost.duration = Number(state.runTime.toFixed(2));
    const old = state.ghostLoaded;
    const isBetter = !old || ghost.distance > old.distance || ghost.score > old.score || outcome === 'win';
    if (isBetter && ghost.distance > 300) {
      state.ghostLoaded = normalizeGhost(ghost);
      saveGhost(state.ghostLoaded);
      state.ghostMessage = 'Latest run saved as your ghost replay.';
      unlockAchievement('ghost-save');
      updateGhostTitleStatus();
    }
  }
  function pad(n, w) {
    const s = String(Math.floor(n));
    return s.length >= w ? s : '0'.repeat(w - s.length) + s;
  }

  // ============================================================
  // PLAYER
  // ============================================================
  const JUMP_BUFFER = 0.12; // press jump up to 120ms before landing and it still fires
  function doJump() {
    state.player.vy = -JUMP_V;     // jumpOff space: +vy = rising (JUMP_V is the legacy upward magnitude)
    state.player.jumping = true;
    state.player.jumpBufferT = 0;
    spawnDust(PLAYER_X + 30, ROAD_SURFACE_Y, 8);
    audio.playJump();
    unlockAchievement('first-jump');
  }
  function tryJump() {
    if (!state.player.jumping) {
      doJump();
    } else {
      // Airborne — buffer the press so back-to-back obstacles don't need
      // pixel-perfect timing; it fires the instant we touch down.
      state.player.jumpBufferT = JUMP_BUFFER;
    }
  }
  // Lane change (edge-triggered, one hop per press). Mid-tween presses are
  // buffered and fire on completion — we commit to the destination first so the
  // reachable set stays discrete (the fairness invariant depends on it).
  function startLaneHop(target) {
    const p = state.player;
    p.laneFromBaseY = laneBaseYFor(p.lane);
    p.laneTarget = target;
    p.laneTweenT = LANE_TWEEN_DUR;
  }
  function hopLane(dir) {
    const p = state.player;
    if (p.laneTweenT > 0) { p.laneBufferDir = dir; p.laneBufferT = LANE_BUFFER; return; }
    const target = Math.max(0, Math.min(LANE_COUNT - 1, p.lane + dir));
    if (target === p.lane) { screenShake(4, 0.12); return; }  // into the rail — tiny nudge
    startLaneHop(target);
    audio.playLaneHop();
  }
  function updatePlayer(dt) {
    // Frame-rate-independent vertical physics: scale by 60fps-equivalent steps
    // so hang time is identical on 60Hz and 144Hz displays.
    const f = dt * 60;
    // Vertical jump physics in jumpOff space (height above the lane base, >=0).
    // Mirror-image of the legacy y-integrator, so the arc is byte-identical.
    state.player.vy -= GRAVITY * f;
    state.player.jumpOff += state.player.vy * f;
    if (state.player.jumpOff <= 0) {
      const wasJumping = state.player.jumping;
      state.player.jumpOff = 0;
      state.player.vy = 0;
      if (wasJumping) {
        state.player.jumping = false;
        spawnDust(PLAYER_X + 24, ROAD_SURFACE_Y, 14);
        // Honor a jump pressed just before touchdown.
        if (state.player.jumpBufferT > 0) doJump();
      }
    }
    if (state.player.jumpBufferT > 0) state.player.jumpBufferT -= dt;
    // Lane tween — smoothstep the lane base toward the target lane.
    const p = state.player;
    if (p.laneTweenT > 0) {
      p.laneTweenT = Math.max(0, p.laneTweenT - dt);
      const prog = 1 - p.laneTweenT / LANE_TWEEN_DUR;       // 0..1
      const sm = prog * prog * (3 - 2 * prog);              // smoothstep
      const toBaseY = laneBaseYFor(p.laneTarget);
      p.laneBaseY = p.laneFromBaseY + (toBaseY - p.laneFromBaseY) * sm;
      // bank into the hop (sign: hopping up/far = lean one way)
      p.laneTilt = Math.sin(prog * Math.PI) * 0.12 * Math.sign(toBaseY - p.laneFromBaseY);
      if (p.laneTweenT === 0) {
        p.lane = p.laneTarget;
        p.laneBaseY = toBaseY;
        spawnDust(PLAYER_X + 24, p.laneBaseY + CAR_FOOT_OFFSET, 6);
        // fire a press queued mid-hop (commit-to-destination, then continue)
        if (p.laneBufferT > 0 && p.laneBufferDir !== 0) {
          const dir = p.laneBufferDir; p.laneBufferDir = 0; p.laneBufferT = 0;
          const nt = Math.max(0, Math.min(LANE_COUNT - 1, p.lane + dir));
          if (nt !== p.lane) startLaneHop(nt);
        }
      }
    } else {
      p.laneBaseY = laneBaseYFor(p.lane);
      p.laneTilt += (0 - p.laneTilt) * 0.2;
    }
    if (p.laneBufferT > 0) p.laneBufferT -= dt;
    state.player.y = state.player.laneBaseY - state.player.jumpOff;
    // gentle body wobble — sells the suspension
    state.player.bob = Math.sin(state.distance * 0.05) * (state.speed * 0.12);
    // wheel rotation
    state.player.wheelAngle += state.speed * 0.18 * f;
    // body tilt now comes from lane hops (manual throttle retired)
    state.player.tilt += (state.player.laneTilt - state.player.tilt) * 0.3;
  }
  function playerBox() {
    const h = state.player.ducking ? 32 : 52;
    const w = 76;
    const y = state.player.y - h + 10;
    return { x: PLAYER_X, y, w, h };
  }
  // Lanes the car occupies for collision. Mid-hop it straddles BOTH lanes until
  // it commits (>= LANE_COMMIT_FRAC of the tween), then only the destination.
  function occupiedLanes() {
    const p = state.player;
    if (p.laneTweenT > 0) {
      const prog = 1 - p.laneTweenT / LANE_TWEEN_DUR;
      return prog < LANE_COMMIT_FRAC ? [p.lane, p.laneTarget] : [p.laneTarget];
    }
    return [p.lane];
  }
  // True if a blocker sits in `lane` close to the player (used for lane-risk bonus).
  function laneHasNearbyBlocker(lane) {
    for (const o of state.obstacles) {
      if (o.lane === lane && !o.hit && o.x > PLAYER_X - 50 && o.x < PLAYER_X + 320) return true;
    }
    return false;
  }

  // ============================================================
  // OBSTACLES & COLLECTIBLES
  // ============================================================
  // === EXTENSION POINT: OBSTACLE TYPES & COLLECTIBLE TYPES ===
  // - Add a new obstacle: pick a type string, add to makeObstacle(), then
  //   draw it in drawObstacles(). Tweak spawn() to spawn it.
  // - Add a new collectible: same pattern via makeCollectible() +
  //   drawCollectibles() + handle the pickup branch in updateWorld().
  // Obstacle types so far: 'pothole', 'cone', 'sign'
  // Collectible types so far: 'fuel', 'snack', 'pitstop'
  const randLane = () => Math.floor(Math.random() * LANE_COUNT);
  const blockerType = () => (Math.random() < 0.30 ? 'sign' : ['pothole', 'cone', 'pothole'][Math.floor(Math.random() * 3)]);

  function spawn() {
    const diff = currentDifficulty();
    const fuelChance = Math.min(0.4, 0.10 * (diff.fuelSpawnRate || 1));
    const snackChance = 0.18;

    // Guarantee one fuel can early so a run can't die to first-leg spawn
    // clustering before any fuel appears (the high early-variance issue).
    if (!state.guaranteedFuelDone && state.distance > 700) {
      state.guaranteedFuelDone = true;
      state.collectibles.push(makeCollectible('fuel', 1));
      return;
    }

    const r = Math.random();
    if (r < fuelChance) { state.collectibles.push(makeCollectible('fuel', randLane())); return; }
    if (r < fuelChance + snackChance) { state.collectibles.push(makeCollectible('snack', randLane())); return; }
    if (r < fuelChance + snackChance + NITRO_SPAWN_CHANCE) { state.collectibles.push(makeCollectible('nitro', randLane())); return; }
    spawnPattern(diff);
  }

  // Roll a cross-lane blocker pattern, clamped so a non-layered pattern never
  // blocks all 3 lanes (the open-lane fairness invariant; layered is the
  // all-same-verb exception, solvable by jump/duck with no lateral escape).
  function spawnPattern(diff) {
    const w = diff.patternWeights || { single: 1, wallGap: 0, layered: 0, chicane: 0 };
    const maxBlock = diff.maxLaneSpan || 1;
    let r = Math.random(), pat;
    if ((r -= w.single) < 0) pat = 'single';
    else if ((r -= w.wallGap) < 0) pat = 'wallGap';
    else if ((r -= w.layered) < 0) pat = 'layered';
    else pat = 'chicane';
    if ((pat === 'wallGap' || pat === 'chicane') && maxBlock < 2) pat = 'single';

    if (pat === 'single') {
      placePattern([{ type: blockerType(), lane: randLane() }], diff.minBlockingGap);
    } else if (pat === 'wallGap') {
      const open = randLane();
      const items = [0, 1, 2].filter((l) => l !== open).map((l) => ({ type: blockerType(), lane: l }));
      placePattern(items, diff.minBlockingGap);
    } else if (pat === 'layered') {
      // full-width wall of ONE verb: all-jump (pothole/cone) or all-duck (sign)
      const t = Math.random() < 0.5 ? 'pothole' : 'sign';
      placePattern([0, 1, 2].map((l) => ({ type: t, lane: l })), diff.minBlockingGap);
    } else { // chicane: two offset singles in different lanes — a quick weave
      const a = randLane();
      const b = (a + (Math.random() < 0.5 ? 1 : 2)) % LANE_COUNT;
      const dx = effGapPx(diff.minBlockingGap) * 0.55;
      placePattern([{ type: blockerType(), lane: a }, { type: blockerType(), lane: b, dx }], diff.minBlockingGap);
    }
  }

  // Speed-aware gap (px): larger of the table floor and a time-based gap at the
  // leg's effective speed — provably exceeds the jump arc at any leg's speed.
  function effGapPx(minGap) {
    return Math.max(minGap || 0, MIN_GAP_TIME * MAX_SPEED * legSpeedScale() * 60);
  }
  // Rightmost pending obstacle x IN A GIVEN LANE (per-lane gap), or -Infinity.
  function rightmostObstacleX(lane) {
    let m = -Infinity;
    for (const o of state.obstacles) if (o.lane === lane && o.x > m) m = o.x;
    return m;
  }
  function laneClear(lane, x, gap) {
    const px = rightmostObstacleX(lane);
    return px === -Infinity || (x - px) >= gap;
  }
  // Atomically place a pattern's items only if EVERY touched lane clears the gap
  // (so a pattern never lands half-formed and never clusters within a lane).
  function placePattern(items, minGap) {
    const gap = effGapPx(minGap);
    const baseX = W + 60;
    for (const it of items) if (!laneClear(it.lane, baseX + (it.dx || 0), gap)) return false;
    for (const it of items) state.obstacles.push(makeObstacle(it.type, it.lane, it.dx || 0));
    return true;
  }
  function makeObstacle(type, lane = 1, dx = 0) {
    const base = laneBaseYFor(lane);
    const o = { type, x: W + 60 + dx, hit: false, lane };
    if (type === 'pothole') {
      o.w = 64; o.h = 18; o.y = base + 2;
    } else if (type === 'cone') {
      o.w = 24; o.h = 36; o.y = base - o.h + 8;
    } else if (type === 'sign') {
      // Panel sits at standing-driver head height — must duck to pass under.
      // Hitbox = panel only; the visible post below is decorative.
      o.w = 78; o.h = 30; o.y = base - 60;
    }
    return o;
  }
  function makeCollectible(type, lane = 1) {
    const base = laneBaseYFor(lane);
    return {
      type,
      x: W + 60,
      w: 28,
      h: 28,
      lane,
      y: Math.random() < 0.35 ? base - 86 : base - 34,
      taken: false,
      bob: Math.random() * Math.PI * 2
    };
  }
  function makePitstop() {
    // Pit stops always spawn in the center lane — a guaranteed-collectible safety
    // valve (you don't have to gamble a lane choice to refuel).
    return {
      type: 'pitstop',
      x: W + 100,
      w: 64,
      h: 56,
      lane: 1,
      y: GROUND_Y - 56,
      taken: false,
      bob: 0
    };
  }
  function makeSemi() {
    return {
      x: W + 240,
      vx: -(state.speed + 2 + Math.random() * 1.5),
      color: ['#3a6aa8', '#aa3a3a', '#3aa83a', '#d4a040'][Math.floor(Math.random() * 4)]
    };
  }
  function spawnBirdFlock() {
    const fromLeft = Math.random() < 0.5;
    const size = 3 + Math.floor(Math.random() * 4); // 3..6 birds
    const baseY = 60 + Math.random() * 120;
    const speed = 0.6 + Math.random() * 0.8;
    const color = currentBiome().birdColor || '#222';
    const vx = fromLeft ? speed : -speed;
    for (let i = 0; i < size; i++) {
      state.birds.push({
        x: fromLeft ? -20 - i * 18 : W + 20 + i * 18,
        y: baseY + (i % 2 === 0 ? 0 : 6) + Math.random() * 4,
        vx,
        flap: Math.random() * Math.PI * 2,
        color
      });
    }
  }
  function updateBirds(dt) {
    for (const b of state.birds) {
      b.x += b.vx;
      b.flap += dt * 9;
    }
    state.birds = state.birds.filter((b) => b.x > -40 && b.x < W + 40);
  }
  function drawBirds() {
    ctx.save();
    for (const b of state.birds) {
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 1.6;
      const wing = Math.sin(b.flap) * 4 + 5;
      ctx.beginPath();
      ctx.moveTo(b.x - 6, b.y + wing);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x + 6, b.y + wing);
      ctx.stroke();
    }
    ctx.restore();
  }

  function updateWorld(dt) {
    // Nitro whooshes the world by; the spawn cadence below stays on base speed,
    // so the obstacle layout the balance sim proves is never made denser.
    const boost = state.nitro > 0 ? NITRO_SPEED_MULT : 1;
    const move = state.speed * boost * dt * 60;

    state.spawnTimer -= dt;
    if (state.spawnTimer <= 0) {
      spawn();
      // Spawns get faster as speed climbs and as the leg's obstacleDensity rises.
      // (min-gap enforcement in spawn() still guarantees blockers stay clearable.)
      const density = currentDifficulty().obstacleDensity || 1;
      state.spawnTimer = Math.max(SPAWN_MIN_INTERVAL,
        (0.85 + Math.random() * 0.7 - state.speed * 0.045) / density);
    }

    // Pit stop spawns at distance milestones
    if (state.distance >= state.nextPitstopAt) {
      state.collectibles.push(makePitstop());
      state.nextPitstopAt += 4000 + Math.random() * 1500;
    }

    // Semi-truck spawns on a timer (faster than player, overtakes)
    state.nextSemiAt -= dt;
    if (state.nextSemiAt <= 0) {
      state.semis.push(makeSemi());
      state.nextSemiAt = 9 + Math.random() * 8;
    }

    // Bird flocks
    state.nextBirdAt -= dt;
    if (state.nextBirdAt <= 0) {
      spawnBirdFlock();
      state.nextBirdAt = 7 + Math.random() * 8;
    }
    updateBirds(dt);

    for (const o of state.obstacles) o.x -= move;
    for (const c of state.collectibles) { c.x -= move; c.bob += dt * 4; }
    for (const s of state.semis) s.x += s.vx;

    state.obstacles = state.obstacles.filter((o) => o.x + o.w > -30);
    state.collectibles = state.collectibles.filter((c) => c.x + c.w > -30);
    state.semis = state.semis.filter((s) => s.x > -340);

    // Collisions — lane-gated: only obstacles in the player's occupied lane(s) bite.
    const pb = playerBox();
    const lanes = occupiedLanes();
    for (const o of state.obstacles) {
      if (o.hit) continue;
      if (!lanes.includes(o.lane)) {
        // Near-miss: an un-hit blocker in an ADJACENT lane sliding past the player
        // rewards riding the edge of danger — bumps combo and scores.
        if (!o.nearMissed && Math.abs(o.lane - state.player.lane) === 1 &&
            o.x + o.w < PLAYER_X + 24 && o.x + o.w > PLAYER_X - 30) {
          o.nearMissed = true;
          state.combo = Math.min(COMBO_CEILING, state.combo + 1);
          state.comboTimer = comboWindow(state.combo);
          const pts = Math.round(35 * comboMult(state.combo));
          state.score += pts;
          state.comboPopupT = 0.5;
          spawnScorePopup(PLAYER_X + 30, o.y - 8, `NEAR MISS +${pts}`, '#9fd8ff');
        }
        continue;
      }
      if (rectsOverlap(pb, o)) {
        o.hit = true;
        if (state.nitro > 0) {
          // Nitro: smash through the blocker — no fuel loss, no combo break.
          const smashPts = Math.round(25 * comboMult(state.combo));
          state.score += smashPts;
          spawnSparks(o.x + o.w / 2, o.y + o.h / 2);
          spawnPickupBurst(o.x + o.w / 2, o.y + o.h / 2, '#00d4ff');
          spawnScorePopup(o.x + o.w / 2, o.y - 10, 'SMASH +' + smashPts, '#00d4ff');
          continue;
        }
        state.fuel -= HIT_FUEL_PENALTY;
        state.runStats.hits += 1;
        state.flashTimer = 0.3;
        screenShake(10, 0.35);
        spawnSparks(o.x + o.w / 2, o.y + o.h / 2);
        spawnScorePopup(o.x + o.w / 2, o.y - 10, '-' + HIT_FUEL_PENALTY + ' FUEL', '#ff6b3a');
        if (state.combo >= 2) {
          // Tell the player their streak just died — was silent before.
          spawnScorePopup(PLAYER_X + 38, GROUND_Y - 96, 'COMBO LOST', '#ffd166');
          audio.playComboBreak();
        }
        state.combo = 0; // hit breaks combo
        audio.playHit();
        unlockAchievement('first-hit');
      }
    }
    for (const c of state.collectibles) {
      if (c.taken) continue;
      // Pit stops are a full-width refuel station — collected from any lane by
      // horizontal overlap (matches the sim's grounded 100%-collection model).
      // Everything else is lane-gated: be in its lane to grab it (lane-risk).
      const got = c.type === 'pitstop'
        ? (pb.x < c.x + c.w && pb.x + pb.w > c.x)
        : (lanes.includes(c.lane) && rectsOverlap(pb, c));
      if (got) {
        c.taken = true;
        // Bump combo (uncapped multiplier, soft-capped count)
        state.combo = Math.min(COMBO_CEILING, state.combo + 1);
        state.comboTimer = comboWindow(state.combo);
        state.comboPopupT = 0.6;
        state.runStats.pickups += 1;
        if (state.combo >= 5) unlockAchievement('combo-5');
        if (state.combo >= 15) unlockAchievement('combo-15');
        if (state.combo >= 25) unlockAchievement('combo-25');
        // Lane-risk bonus: grabbing a can in a lane that also holds a nearby
        // blocker is a deliberate risky line — reward it.
        const risky = c.type !== 'pitstop' && laneHasNearbyBlocker(c.lane);
        const mult = comboMult(state.combo) * (risky ? 1.5 : 1);
        if (state.combo >= 2) audio.playCombo(state.combo);   // combo milestone feedback
        if (c.type === 'fuel') {
          state.runStats.fuel += 1;
          const pts = Math.round(FUEL_PICKUP_BONUS * mult);
          const refill = currentDifficulty().fuelPerCan || FUEL_PICKUP_REFILL;
          state.fuel = Math.min(FUEL_MAX, state.fuel + refill);
          state.score += pts;
          spawnPickupBurst(c.x + c.w / 2, c.y + c.h / 2, '#7ee27e');
          spawnScorePopup(c.x + c.w / 2, c.y, `+${pts}` + (risky ? ' RISK!' : ''), '#7ee27e');
          audio.playFuel();
          unlockAchievement('fuel');
        } else if (c.type === 'pitstop') {
          // Big partial refuel + chunky bonus. (A full reset made running dry
          // impossible; PITSTOP_REFILL keeps it a strong rescue, not an auto-win.)
          state.runStats.pitstops += 1;
          state.fuel = Math.min(FUEL_MAX, state.fuel + PITSTOP_REFILL);
          const pts = Math.round(500 * mult);
          state.score += pts;
          spawnPickupBurst(c.x + c.w / 2, c.y + c.h / 2, '#7ee27e');
          spawnScorePopup(c.x + c.w / 2, c.y, `PIT STOP!  +${pts}`, '#7ee27e');
          audio.playBiome(); // celebratory arpeggio
          unlockAchievement('pitstop');
        } else if (c.type === 'nitro') {
          // Nitro pickup (concept by Levi Ray, PR #24): start the invincible burst.
          state.nitro = NITRO_DURATION;
          const npts = Math.round(NITRO_POINTS * mult);
          state.score += npts;
          screenShake(6, 0.25);
          spawnPickupBurst(c.x + c.w / 2, c.y + c.h / 2, '#00d4ff');
          spawnScorePopup(c.x + c.w / 2, c.y, `NITRO!  +${npts}`, '#00d4ff');
          audio.playBiome();
        } else {
          state.runStats.snacks += 1;
          const pts = Math.round(SNACK_POINTS * mult);
          state.score += pts;
          spawnPickupBurst(c.x + c.w / 2, c.y + c.h / 2, '#f5d76e');
          spawnScorePopup(c.x + c.w / 2, c.y, `+${pts}` + (risky ? ' RISK!' : ''), '#f5d76e');
          audio.playSnack();
          unlockAchievement('snack');
        }
      }
    }
    state.collectibles = state.collectibles.filter((c) => !c.taken);
  }

  // ============================================================
  // HUD SAFE ZONE + TOAST PALETTE
  // ------------------------------------------------------------
  // The DOM HUD cards (SCORE/STAGE/TRIP top row + SPEEDO/FUEL bottom row, see
  // index.html) sit in screen space over the canvas. Canvas-drawn toasts must
  // never render inside those bands or they read as a glitch — the old COMBO
  // toast drew at y=60, colliding with the TRIP card. All coordinates below are
  // in the fixed VIEW_W x VIEW_H logical space the render transform guarantees.
  const HUD_SAFE_TOP = 88;            // bottom of the SCORE/STAGE/TRIP card band (+margin)
  // COMBO toast sits in a clear band BELOW the card band AND the biome banner
  // (the banner occupies y 96..166). Centered ~0.40*VIEW_H so that even at the
  // toast's max pop scale (1.4x, yOff -8 → pill top ~COMBO_Y-37) it stays a
  // dozen px clear of the banner bottom, and well above the car.
  const COMBO_Y = Math.round(H * 0.40);   // = 216

  // Colorblind palette for canvas toasts. We CONSUME the existing palette source
  // (state.settings.colorblind — the same flag gameColor() reads); these
  // high-contrast hexes mirror the body.colorblind CSS vars so canvas toasts and
  // the DOM HUD stay in lockstep. The setting/persistence is owned upstream
  // (accessibility); we only read it.
  const TOAST_CB = {
    '#7ee27e': '#009e73',   // good / gain  -> CB green
    '#f5d76e': '#ffd23f',   // gold / score -> CB amber
    '#ff6b3a': '#cc79a7',   // penalty      -> CB magenta
  };
  function toastColor(hex) {
    if (!state.settings.colorblind) return hex;
    return TOAST_CB[hex.toLowerCase()] || hex;
  }

  // ============================================================
  // SCORE POPUPS + COMBO
  // ============================================================
  function spawnScorePopup(x, y, text, color) {
    state.scorePopups.push({
      x, y, text, color,
      vy: -1.4,
      life: 1.0,
      max: 1.0
    });
  }
  function updateScorePopups(dt) {
    for (const p of state.scorePopups) {
      p.y += p.vy;
      p.vy *= 0.96;
      p.life -= dt;
    }
    state.scorePopups = state.scorePopups.filter((p) => p.life > 0);
  }
  function drawScorePopups() {
    ctx.save();
    ctx.font = 'bold 16px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Dark halo keeps popups legible over bright biome skies (desert/coast).
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    for (const p of state.scorePopups) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      // Popups spawn at world objects (low on screen) and drift up; clamp so
      // none can ever drift into the top DOM card band.
      const py = Math.max(p.y, HUD_SAFE_TOP);
      ctx.fillStyle = toastColor(p.color);
      ctx.fillText(p.text, p.x, py);
    }
    ctx.restore();
  }
  function drawComboHud() {
    if (state.combo < 2 || state.screen !== SCREEN.PLAYING) return;
    const t = Math.min(1, state.comboPopupT * 2);
    const scale = 1 + (1 - t) * 0.4;
    const yOff = (1 - t) * -8;
    const label = `COMBO  x${state.combo}`;
    ctx.save();
    ctx.translate(W / 2, COMBO_Y + yOff);
    ctx.scale(scale, scale);
    ctx.font = 'bold 26px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Dark backplate pill — keeps the toast legible over bright skies
    // (desert noon, coast sunset), matching the DOM card backplates.
    const tw = ctx.measureText(label).width;
    const bw = tw + 32, bh = 42;
    ctx.fillStyle = 'rgba(12, 14, 24, 0.72)';
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 8);
    ctx.fill();
    ctx.strokeStyle = toastColor('#f5d76e');
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = toastColor('#f5d76e');
    ctx.fillText(label, 0, 1);
    ctx.restore();
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ============================================================
  // PARTICLES
  // ============================================================
  // === EXTENSION POINT: PARTICLES ===
  // Spawn your own particles with state.particles.push({ x, y, vx, vy,
  //   life, max, color, size, gravity }). The render loop fades them
  //   automatically based on life/max.
  function spawnSparks(x, y) {
    for (let i = 0; i < 14; i++) {
      state.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 9,
        vy: (Math.random() - 0.5) * 7 - 3,
        life: 0.55,
        max: 0.55,
        color: Math.random() < 0.5 ? '#ff7048' : '#f5d76e',
        size: 2 + Math.random() * 2,
        gravity: 0.4
      });
    }
  }
  function spawnPickupBurst(x, y, color) {
    for (let i = 0; i < 12; i++) {
      state.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 5,
        vy: -1 - Math.random() * 4.5,
        life: 0.7,
        max: 0.7,
        color,
        size: 3 + Math.random() * 2,
        gravity: 0.18
      });
    }
    // Bright sparkle accents for a poppier collect.
    for (let i = 0; i < 5; i++) {
      state.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 7,
        vy: -2 - Math.random() * 5,
        life: 0.5 + Math.random() * 0.3,
        max: 0.85,
        color: '#fffbe0',
        size: 1.5 + Math.random() * 1.5,
        gravity: 0.1
      });
    }
  }
  function spawnDust(x, y, count) {
    for (let i = 0; i < count; i++) {
      state.particles.push({
        x: x + (Math.random() - 0.5) * 10,
        y,
        vx: -1 - Math.random() * 2,
        vy: -0.5 - Math.random() * 1.5,
        life: 0.5 + Math.random() * 0.3,
        max: 0.8,
        color: 'rgba(220,210,190,0.7)',
        size: 3 + Math.random() * 3,
        gravity: -0.05 // floats up a touch
      });
    }
  }
  function spawnExhaust(x, y) {
    state.particles.push({
      x, y,
      vx: -2 - Math.random() * 2,
      vy: -0.5 - Math.random() * 0.6,
      life: 0.5,
      max: 0.5,
      color: 'rgba(200,200,210,0.55)',
      size: 4 + Math.random() * 3,
      gravity: -0.04
    });
  }
  function spawnTireSmoke(x, y) {
    for (let i = 0; i < 2; i++) {
      state.particles.push({
        x: x + (Math.random() - 0.5) * 6,
        y: y - Math.random() * 3,
        vx: -1.5 - Math.random() * 2,
        vy: -0.4 - Math.random() * 1.2,
        life: 0.45 + Math.random() * 0.3,
        max: 0.75,
        color: 'rgba(170,170,178,0.6)',
        size: 4 + Math.random() * 4,
        gravity: -0.06
      });
    }
  }
  function updateParticles(dt) {
    for (const p of state.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.life -= dt;
    }
    state.particles = state.particles.filter((p) => p.life > 0);
  }

  // ============================================================
  // SCREEN SHAKE
  // ============================================================
  function screenShake(mag, duration) {
    if (!state.settings.screenShake || reduceMotionOn()) return;
    state.shakeMag = mag;
    state.shakeT = duration;
  }
  function shakeOffset() {
    if (!state.settings.screenShake || reduceMotionOn() || state.shakeT <= 0) return { x: 0, y: 0 };
    const t = state.shakeT / 0.35;
    return {
      x: (Math.random() - 0.5) * state.shakeMag * t,
      y: (Math.random() - 0.5) * state.shakeMag * t
    };
  }

  // ============================================================
  // RENDERING — sky / parallax / scenery
  // ============================================================
  function currentBiome() {
    for (let i = 0; i < BIOMES.length; i++) {
      if (state.distance < BIOMES[i].end) {
        state.biomeIdx = i;
        return BIOMES[i];
      }
    }
    state.biomeIdx = BIOMES.length - 1;
    return BIOMES[state.biomeIdx];
  }
  // The difficulty knobs for the current leg. Refreshes the biome index from
  // distance first so spawn-time reads (called before render's currentBiome())
  // never lag a frame behind the leg the player is actually in.
  function currentDifficulty() {
    currentBiome();
    return DIFFICULTY[state.biomeIdx] || DIFFICULTY[DIFFICULTY.length - 1];
  }
  // Effective per-leg speed multiplier, ramped across the leg so each biome
  // visibly accelerates into the next (no hard speed steps at biome borders).
  function legSpeedScale() {
    currentBiome();
    const i = state.biomeIdx;
    const scale = DIFFICULTY[i].speedScale;
    const prevScale = i > 0 ? DIFFICULTY[i - 1].speedScale : scale;
    const legStart = i === 0 ? 0 : BIOMES[i - 1].end;
    const legEnd = BIOMES[i].end;
    const f = Math.max(0, Math.min(1, (state.distance - legStart) / (legEnd - legStart)));
    return prevScale + (scale - prevScale) * f;
  }
  function nextBiome() {
    return BIOMES[Math.min(state.biomeIdx + 1, BIOMES.length - 1)];
  }
  function biomeBlend() {
    // 0 in middle of biome, → 1 in last 200 units (transition zone)
    const b = BIOMES[state.biomeIdx];
    const start = state.biomeIdx === 0 ? 0 : BIOMES[state.biomeIdx - 1].end;
    const trans = 220;
    if (b.end - state.distance < trans) {
      return 1 - (b.end - state.distance) / trans;
    }
    if (state.distance - start < trans) {
      return (state.distance - start) / trans - 1; // negative → previous-biome blend
    }
    return 0;
  }
  // Blend a single-colour biome prop toward the next biome across the transition
  // zone, so scenery colours dissolve instead of snapping at a leg boundary.
  function biomeColor(biome, prop) {
    const bl = biomeBlend();
    return bl > 0 ? lerpColor(biome[prop], nextBiome()[prop], bl) : biome[prop];
  }
  function lerpColor(a, b, t) {
    const ah = a.replace('#', '');
    const bh = b.replace('#', '');
    const ar = parseInt(ah.slice(0, 2), 16);
    const ag = parseInt(ah.slice(2, 4), 16);
    const ab = parseInt(ah.slice(4, 6), 16);
    const br = parseInt(bh.slice(0, 2), 16);
    const bg = parseInt(bh.slice(2, 4), 16);
    const bb = parseInt(bh.slice(4, 6), 16);
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return `rgb(${r}, ${g}, ${bl})`;
  }
  function blendedBiomeColor(prop) {
    const b = currentBiome();
    const blend = biomeBlend();
    if (blend > 0) {
      const n = nextBiome();
      const ap = Array.isArray(b[prop]) ? b[prop] : [b[prop]];
      const bp = Array.isArray(n[prop]) ? n[prop] : [n[prop]];
      if (ap.length === bp.length) return ap.map((c, i) => lerpColor(c, bp[i], blend));
      return lerpColor(ap[0], bp[0], blend);
    }
    return b[prop];
  }

  function drawSky(biome) {
    const sky = blendedBiomeColor('sky');
    const colors = Array.isArray(sky) ? sky : [sky];
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    if (colors.length >= 3) {
      g.addColorStop(0, colors[2]);    // zenith
      g.addColorStop(0.55, colors[1]); // mid
      g.addColorStop(1.0, colors[0]);  // horizon
    } else {
      g.addColorStop(0, colors[0]);
      g.addColorStop(1, colors[0]);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, GROUND_Y + 30);
  }

  function drawSun(biome) {
    const sunX = W - 160 + Math.sin(state.distance * 0.0002) * 30;
    const sunY = biome.sunY;
    const sunR = biome.timeOfDay === 'sunset' ? 60 : 42;
    // halo — radial fade from warm core to transparent
    const haloG = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 3);
    haloG.addColorStop(0, hexToRgba(biome.sunColor, 0.65));
    haloG.addColorStop(0.45, hexToRgba(biome.sunColor, 0.18));
    haloG.addColorStop(1, hexToRgba(biome.sunColor, 0));
    ctx.fillStyle = haloG;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR * 3, 0, Math.PI * 2);
    ctx.fill();
    // Crepuscular rays (static sunburst) — strongest at sunset, lighter at noon.
    if (biome.timeOfDay === 'sunset' || biome.timeOfDay === 'afternoon') {
      ctx.save();
      ctx.translate(sunX, sunY);
      ctx.globalAlpha = biome.timeOfDay === 'sunset' ? 0.13 : 0.07;
      ctx.fillStyle = biome.sunColor;
      const rays = 9;
      for (let i = 0; i < rays; i++) {
        ctx.rotate((Math.PI * 2) / rays);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(sunR * 5, -sunR * 0.5);
        ctx.lineTo(sunR * 5, sunR * 0.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    // disk
    ctx.fillStyle = biome.sunColor;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    ctx.fill();
  }
  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  // Lighten (amt>0) or darken (amt<0) a #rrggbb by a fraction; returns #rrggbb.
  // Used for the car's metallic body gradient + machined wheel shading.
  function shade(hex, amt) {
    const h = hex.replace('#', '');
    const f = (i) => {
      const c = parseInt(h.slice(i, i + 2), 16);
      const v = amt >= 0 ? c + (255 - c) * amt : c * (1 + amt);
      return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(2) + f(4);
  }
  function gameColor(normal, highContrast) {
    return state.settings.colorblind ? highContrast : normal;
  }

  function drawClouds(biome) {
    // Cloud layer — slow parallax (0.05x)
    const off = state.distance * 0.05;
    ctx.fillStyle = biome.timeOfDay === 'sunset'
      ? 'rgba(255, 200, 160, 0.75)'
      : 'rgba(255, 255, 255, 0.78)';
    const cloudCount = 6;
    for (let i = 0; i < cloudCount; i++) {
      const baseX = (i * 320 + 100 - off) % (W + 400);
      const x = baseX < -200 ? baseX + W + 400 : baseX;
      const y = 50 + ((i * 47) % 80);
      drawCloud(x, y, 60 + (i * 17) % 40);
    }
  }
  function drawCloud(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
    ctx.arc(x + r * 0.5, y + 6, r * 0.42, 0, Math.PI * 2);
    ctx.arc(x - r * 0.5, y + 6, r * 0.42, 0, Math.PI * 2);
    ctx.arc(x - r * 0.2, y - r * 0.25, r * 0.36, 0, Math.PI * 2);
    ctx.arc(x + r * 0.3, y - r * 0.2, r * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawFarMountains(biome) {
    // Slow-moving mountain silhouette layer (0.12x parallax)
    const off = state.distance * 0.12;
    const baseY = GROUND_Y - 70;
    ctx.fillStyle = biomeColor(biome, 'mountainColor');
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    for (let i = 0; i < 8; i++) {
      const x = ((i * 180) - (off % 180)) - 90;
      ctx.lineTo(x, baseY);
      ctx.lineTo(x + 90, baseY - 80 - (i % 3) * 12);
      ctx.lineTo(x + 180, baseY);
    }
    ctx.lineTo(W, GROUND_Y);
    ctx.closePath();
    ctx.fill();
  }

  // Distance haze: a soft band of horizon light the far layers fade into, for
  // aerial depth. Warmer at dawn/sunset. Uses the raw horizon sky colour.
  function drawAtmosphere(biome) {
    const horizon = Array.isArray(biome.sky) ? biome.sky[0] : biome.sky;
    const top = GROUND_Y - 130;
    const g = ctx.createLinearGradient(0, top, 0, GROUND_Y + 10);
    g.addColorStop(0, hexToRgba(horizon, 0));
    g.addColorStop(1, hexToRgba(horizon, biome.timeOfDay === 'sunset' ? 0.5 : 0.36));
    ctx.fillStyle = g;
    ctx.fillRect(0, top, W, GROUND_Y - top + 10);
  }

  function drawMidFor(name, off) {
    switch (name) {
      case 'CITY':   drawCitySkyline(off); break;
      case 'FOREST': drawForestMid(off); break;
      case 'DESERT': drawDesertMid(off); break;
      case 'COAST':  drawCoastMid(off); break;
    }
  }
  function drawMidScenery(biome) {
    // Biome-specific mid layer (0.32x parallax). Through a leg transition, cross-
    // fade the current biome out and the next in, so the scenery dissolves
    // smoothly instead of popping at the boundary.
    const off = state.distance * 0.32;
    const bl = biomeBlend();
    if (bl > 0.001) {
      ctx.save(); ctx.globalAlpha = 1 - bl; drawMidFor(biome.name, off); ctx.restore();
      ctx.save(); ctx.globalAlpha = bl;     drawMidFor(nextBiome().name, off); ctx.restore();
    } else {
      drawMidFor(biome.name, off);
    }
  }
  function drawCitySkyline(off) {
    const baseY = GROUND_Y;
    for (let i = 0; i < 12; i++) {
      const x = ((i * 120) - (off % 120)) - 60;
      const h = 90 + ((i * 47) % 110);
      ctx.fillStyle = '#2e2e44';
      ctx.fillRect(x, baseY - h, 100, h);
      // antenna
      if (i % 3 === 1) {
        ctx.fillStyle = '#1a1a26';
        ctx.fillRect(x + 48, baseY - h - 12, 4, 12);
      }
      // windows
      ctx.fillStyle = '#f5d76e';
      for (let row = 0; row < Math.floor(h / 20) - 1; row++) {
        for (let col = 0; col < 4; col++) {
          if (((i + row + col) % 3) !== 0) continue;
          ctx.fillRect(x + 12 + col * 22, baseY - h + 12 + row * 20, 10, 10);
        }
      }
    }
  }
  function drawForestMid(off) {
    const baseY = GROUND_Y;
    // Background pine wall
    for (let i = 0; i < 22; i++) {
      const x = ((i * 60) - (off % 60)) - 30;
      const h = 110 + ((i * 37) % 50);
      // trunk
      ctx.fillStyle = '#5a3a1f';
      ctx.fillRect(x + 14, baseY - 28, 6, 28);
      // pine cone
      ctx.fillStyle = '#1f3a1f';
      ctx.beginPath();
      ctx.moveTo(x - 4, baseY - 28);
      ctx.lineTo(x + 17, baseY - 28 - h);
      ctx.lineTo(x + 38, baseY - 28);
      ctx.closePath();
      ctx.fill();
      // secondary tier
      ctx.beginPath();
      ctx.moveTo(x, baseY - 28 - h * 0.4);
      ctx.lineTo(x + 17, baseY - 28 - h * 0.95);
      ctx.lineTo(x + 34, baseY - 28 - h * 0.4);
      ctx.closePath();
      ctx.fill();
    }
  }
  function drawDesertMid(off) {
    const baseY = GROUND_Y;
    // distant mesas
    for (let i = 0; i < 6; i++) {
      const x = ((i * 220) - (off % 220)) - 110;
      const w = 160;
      const h = 80 + (i % 3) * 14;
      ctx.fillStyle = '#8a5530';
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.lineTo(x + 16, baseY - h);
      ctx.lineTo(x + w - 16, baseY - h);
      ctx.lineTo(x + w, baseY);
      ctx.closePath();
      ctx.fill();
      // top streak
      ctx.fillStyle = '#a96a3a';
      ctx.fillRect(x + 16, baseY - h, w - 32, 6);
    }
    // saguaros
    for (let i = 0; i < 14; i++) {
      const x = ((i * 110) - (off % 110)) - 55;
      const h = 60 + ((i * 41) % 30);
      ctx.fillStyle = '#5a8a3a';
      ctx.fillRect(x + 14, baseY - h, 12, h);
      ctx.fillRect(x + 6, baseY - h + 14, 8, 22);
      ctx.fillRect(x + 26, baseY - h + 22, 8, 18);
    }
  }
  function drawCoastMid(off) {
    const baseY = GROUND_Y;
    // ocean strip
    const oceanG = ctx.createLinearGradient(0, baseY - 60, 0, baseY - 20);
    oceanG.addColorStop(0, '#3a7eb4');
    oceanG.addColorStop(1, '#1f4e7a');
    ctx.fillStyle = oceanG;
    ctx.fillRect(0, baseY - 60, W, 40);
    // sun reflection on water
    ctx.fillStyle = 'rgba(255, 210, 140, 0.55)';
    ctx.fillRect(W - 240, baseY - 50, 80, 6);
    ctx.fillRect(W - 220, baseY - 40, 60, 4);
    // palms
    for (let i = 0; i < 8; i++) {
      const x = ((i * 160) - (off % 160)) - 80;
      const h = 100 + (i % 3) * 18;
      // trunk
      ctx.fillStyle = '#6a4a2a';
      ctx.beginPath();
      ctx.moveTo(x + 22, baseY);
      ctx.quadraticCurveTo(x + 30, baseY - h * 0.5, x + 24, baseY - h);
      ctx.lineTo(x + 28, baseY - h);
      ctx.quadraticCurveTo(x + 36, baseY - h * 0.5, x + 28, baseY);
      ctx.closePath();
      ctx.fill();
      // fronds
      ctx.fillStyle = '#2d7a3a';
      drawPalmFronds(x + 26, baseY - h);
    }
  }
  function drawPalmFronds(cx, cy) {
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + 0.2;
      const len = 32;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(
        cx + Math.cos(ang) * len * 0.5,
        cy + Math.sin(ang) * len * 0.5 - 6,
        cx + Math.cos(ang) * len,
        cy + Math.sin(ang) * len
      );
      ctx.lineWidth = 7;
      ctx.strokeStyle = '#2d7a3a';
      ctx.stroke();
    }
  }

  function drawNearScenery(biome) {
    // Near-ground details — fast parallax (0.7x)
    const off = state.distance * 0.7;
    ctx.fillStyle = biomeColor(biome, 'grass');
    // Grass tufts
    for (let i = 0; i < 28; i++) {
      const x = ((i * 50) - (off % 50)) - 25;
      const tuftY = GROUND_Y - 4;
      ctx.fillRect(x, tuftY, 3, 4);
      ctx.fillRect(x + 6, tuftY - 1, 3, 5);
      ctx.fillRect(x + 12, tuftY, 3, 4);
    }
    // Biome-specific roadside detail
    if (biome.name === 'CITY') {
      ctx.fillStyle = '#2a2a2e';
      for (let i = 0; i < 6; i++) {
        const x = ((i * 240) - (off % 240)) - 120;
        // streetlight pole + lamp
        ctx.fillRect(x, GROUND_Y - 60, 4, 60);
        ctx.fillRect(x - 12, GROUND_Y - 64, 20, 4);
        ctx.fillStyle = '#f5d76e';
        ctx.fillRect(x - 10, GROUND_Y - 60, 6, 4);
        ctx.fillStyle = '#2a2a2e';
      }
    } else if (biome.name === 'DESERT') {
      // small bushes
      ctx.fillStyle = '#7a8a3a';
      for (let i = 0; i < 12; i++) {
        const x = ((i * 110) - (off % 110)) - 55;
        ctx.beginPath();
        ctx.arc(x, GROUND_Y + 2, 6, 0, Math.PI * 2);
        ctx.arc(x + 8, GROUND_Y + 2, 5, 0, Math.PI * 2);
        ctx.arc(x - 8, GROUND_Y + 2, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawGround(biome) {
    // Three-lane asphalt: the road now spans all lane contact lines, with dashed
    // dividers between lanes. Lane 1 (center) keeps the legacy datum.
    const roadTop = laneBaseYFor(2) - 8;                       // just above the far lane
    const roadBot = laneBaseYFor(0) + CAR_FOOT_OFFSET + 12;    // just below the near lane
    // Grass behind the road
    ctx.fillStyle = biomeColor(biome, 'grass');
    ctx.fillRect(0, roadTop - 24, W, H - (roadTop - 24));
    // Asphalt band
    ctx.fillStyle = biomeColor(biome, 'road');
    ctx.fillRect(0, roadTop, W, roadBot - roadTop);
    // Edge highlights
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, roadTop, W, 2);
    ctx.fillRect(0, roadBot - 2, W, 2);
    // Dashed lane dividers (between the 3 lanes), scrolling with distance
    ctx.fillStyle = biomeColor(biome, 'dashColor');
    const dashW = 52, gap = 32, cycle = dashW + gap;
    const dashOff = state.distance % cycle;
    const dividers = [
      (laneBaseYFor(2) + laneBaseYFor(1)) / 2 + CAR_FOOT_OFFSET,
      (laneBaseYFor(1) + laneBaseYFor(0)) / 2 + CAR_FOOT_OFFSET
    ];
    for (const dy of dividers) {
      for (let x = -dashOff; x < W; x += cycle) ctx.fillRect(x, dy, dashW, 4);
    }
    // Depth shading: dim the far (top) lane, brighten the near (bottom) lane
    const sh = ctx.createLinearGradient(0, roadTop, 0, roadBot);
    sh.addColorStop(0, 'rgba(0,0,0,0.22)');
    sh.addColorStop(0.55, 'rgba(0,0,0,0.0)');
    sh.addColorStop(1, 'rgba(255,255,255,0.05)');
    ctx.fillStyle = sh;
    ctx.fillRect(0, roadTop, W, roadBot - roadTop);
    // Current-lane glow under the car for readability
    const glowY = state.player.laneBaseY + CAR_FOOT_OFFSET;
    const gg = ctx.createRadialGradient(PLAYER_X + 38, glowY, 4, PLAYER_X + 38, glowY, 130);
    gg.addColorStop(0, 'rgba(255,240,180,0.12)');
    gg.addColorStop(1, 'rgba(255,240,180,0)');
    ctx.fillStyle = gg;
    ctx.fillRect(0, roadTop, W, roadBot - roadTop);
  }

  // ============================================================
  // RENDERING — entities
  // ============================================================
  function currentGhostFrame() {
    const g = state.ghostLoaded;
    if (!g || !state.settings.ghostVisible || state.screen !== SCREEN.PLAYING) return null;
    const frames = g.frames;
    if (!frames || frames.length < 2) return null;
    const t = state.runTime;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (frames[mid][0] < t) lo = mid + 1;
      else hi = mid;
    }
    const b = frames[Math.min(lo, frames.length - 1)];
    const a = frames[Math.max(0, lo - 1)];
    const span = Math.max(0.001, b[0] - a[0]);
    const mix = Math.max(0, Math.min(1, (t - a[0]) / span));
    return [
      a[0] + (b[0] - a[0]) * mix,
      a[1] + (b[1] - a[1]) * mix,
      a[2] + (b[2] - a[2]) * mix,
      a[3] + (b[3] - a[3]) * mix,
      mix < 0.5 ? a[4] : b[4]
    ];
  }

  function drawGhostPlayer() {
    const frame = currentGhostFrame();
    if (!frame) return;
    const ghostDistance = frame[1];
    const diff = ghostDistance - state.distance;
    const x = PLAYER_X + diff * GHOST_DISTANCE_SCALE;
    if (x < -90 || x > W + 90) {
      drawGhostArrow(diff);
      return;
    }

    const y = frame[2];
    const ducking = !!(frame[4] & 2);
    const h = ducking ? 34 : 52;
    const w = 78;
    const top = y - h + 10;

    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.setLineDash([6, 5]);
    ctx.fillStyle = gameColor('#9be7ff', '#f0e442');
    ctx.strokeStyle = gameColor('#ffffff', '#0072b2');
    ctx.lineWidth = 2;
    roundRect(ctx, x + 4, top + 12, w - 8, h - 14, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = gameColor('#d8f7ff', '#fff7a8');
    ctx.fillRect(x + 18, top + 3, 34, 12);
    ctx.beginPath();
    ctx.arc(x + 18, top + h - 2, 9, 0, Math.PI * 2);
    ctx.arc(x + w - 18, top + h - 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.82;
    ctx.font = 'bold 10px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('GHOST', x + w / 2, top - 3);
    ctx.restore();
  }

  function drawGhostArrow(diff) {
    if (!state.settings.ghostVisible) return;
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = gameColor('#9be7ff', '#f0e442');
    ctx.font = 'bold 12px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = diff > 0 ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    const label = `GHOST ${diff > 0 ? '+' : ''}${Math.round(diff)}`;
    ctx.fillText(label, diff > 0 ? W - 18 : 18, 96);
    ctx.restore();
  }

  // Player car — GT / Le Mans racer body (the only car). Ported from the
  // car-prototype (faces right, same 80px footprint + hitbox). Wheels are planted
  // on the ROAD_SURFACE_Y contact line (body-only bob); body colour comes from
  // the per-run random livery, with a random door number.
  function drawWheelGT(cx, cy, angle, r) {
    r = r || 11;
    const tg = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.2, cx, cy, r);
    tg.addColorStop(0, '#2a2a2e'); tg.addColorStop(1, '#0c0c0e');
    ctx.fillStyle = tg;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#5a5a60';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2); ctx.fill();
    const rg = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, r * 0.55);
    rg.addColorStop(0, '#f0f0f5'); rg.addColorStop(0.6, '#b8b8c0'); rg.addColorStop(1, '#7a7a82');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle);
    ctx.strokeStyle = '#6a6a72'; ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) { ctx.rotate((Math.PI * 2) / 5); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r * 0.46, 0); ctx.stroke(); }
    ctx.restore();
    ctx.fillStyle = '#d4a040';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.16, 0, Math.PI * 2); ctx.fill();
  }
  function drawPlayerGT() {
    const x = PLAYER_X, y = state.player.y, groundY = GROUND_Y;
    const ducking = !!state.player.ducking, jumping = !!state.player.jumping;
    const tilt = state.player.tilt || 0, wheelAngle = state.player.wheelAngle || 0, bob = state.player.bob || 0;
    const color = state.carStyle.body, accent = '#15151c';
    const number = state.carNumber != null ? state.carNumber : 7;
    const w = 80, k = ducking ? 0.62 : 1, wheelR = ducking ? 11 : 12;
    // Plant wheels on the contact line (rises with the jump); only the body bobs.
    const lift = groundY - y, footY = ROAD_SURFACE_Y - lift, wheelY = footY - wheelR;
    const xRearWheel = x + 20, xFrontWheel = x + 60;
    const floorY = y + 2 + bob * 0.3, tailY = y - 14 * k + bob, deckY = y - 16 * k + bob;
    const noseY = y - 11 * k + bob, hoodY = y - 18 * k + bob, canopyY = y - 28 * k + bob;
    const wingY = y - 25 * k + bob, doorCY = y - 9 * k + bob;
    // ground shadow stays on the CURRENT lane's contact line; scales with the
    // jump height only (jumpOff), not the lane offset.
    ctx.save();
    const jOff = state.player.jumpOff || 0;
    const shadowScale = jumping ? 0.5 + Math.min(1, jOff / 90) * 0.5 : 1;
    const shadowY = state.player.laneBaseY + CAR_FOOT_OFFSET;
    ctx.fillStyle = `rgba(0,0,0,${0.32 * shadowScale})`;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, shadowY, (w / 2 + 5) * shadowScale, 7 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const cx = x + w / 2, cyRot = y - 14 * k;
    ctx.save();
    ctx.translate(cx, cyRot); ctx.rotate(tilt); ctx.translate(-cx, -cyRot);
    // rear wing
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.moveTo(x + 8, deckY); ctx.lineTo(x + 14, deckY); ctx.lineTo(x + 13, wingY + 3); ctx.lineTo(x + 9, wingY + 3); ctx.closePath(); ctx.fill();
    roundRect(ctx, x + 2, wingY, 22, 3.2, 1.5); ctx.fill();
    ctx.fillRect(x + 2, wingY - 2, 2.5, 7);
    // wheels
    drawWheelGT(xRearWheel, wheelY, wheelAngle, wheelR);
    drawWheelGT(xFrontWheel, wheelY, wheelAngle, wheelR);
    // body silhouette (low GT wedge)
    ctx.beginPath();
    ctx.moveTo(x + 3, floorY);
    ctx.lineTo(x + 2, tailY);
    ctx.quadraticCurveTo(x + 3, deckY, x + 18, deckY);
    ctx.quadraticCurveTo(x + 30, canopyY, x + 42, hoodY);
    ctx.quadraticCurveTo(x + 56, hoodY - 2, x + 72, noseY);
    ctx.quadraticCurveTo(x + w, noseY + 1, x + w, y - 4 * k);
    ctx.lineTo(x + w - 3, floorY);
    ctx.closePath();
    const bg = ctx.createLinearGradient(0, canopyY, 0, floorY);
    bg.addColorStop(0, shade(color, 0.45));
    bg.addColorStop(0.4, color);
    bg.addColorStop(0.78, color);
    bg.addColorStop(1, shade(color, -0.42));
    ctx.fillStyle = bg; ctx.fill();
    ctx.strokeStyle = shade(color, -0.55); ctx.lineWidth = 1; ctx.stroke();
    // wheel-arch lips
    ctx.strokeStyle = shade(color, -0.5); ctx.lineWidth = 1.5;
    [xRearWheel, xFrontWheel].forEach((wx) => { ctx.beginPath(); ctx.arc(wx, wheelY - 1, wheelR + 3, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke(); });
    // splitter + dive plane
    ctx.fillStyle = accent;
    ctx.fillRect(x + w - 18, floorY - 1.5, 20, 3);
    ctx.beginPath(); ctx.moveTo(x + w - 20, noseY + 4); ctx.lineTo(x + w - 8, noseY + 5); ctx.lineTo(x + w - 18, noseY + 7.5); ctx.closePath(); ctx.fill();
    // diffuser fins
    ctx.strokeStyle = accent; ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(x + 5 + i * 4, floorY); ctx.lineTo(x + 7 + i * 4, floorY - 3.5); ctx.stroke(); }
    // racing stripe
    ctx.save(); ctx.globalAlpha = 0.92; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4.5 * k;
    ctx.beginPath();
    ctx.moveTo(x + 4, tailY + 1);
    ctx.quadraticCurveTo(x + 3, deckY + 1, x + 18, deckY + 1.5);
    ctx.quadraticCurveTo(x + 30, canopyY + 2.5, x + 42, hoodY + 2.5);
    ctx.quadraticCurveTo(x + 56, hoodY, x + 74, noseY + 2);
    ctx.stroke(); ctx.restore();
    // cockpit glass
    const gg = ctx.createLinearGradient(x + 24, canopyY, x + 44, hoodY);
    gg.addColorStop(0, 'rgba(35,55,75,0.95)'); gg.addColorStop(0.5, 'rgba(120,170,210,0.92)'); gg.addColorStop(1, 'rgba(55,85,115,0.95)');
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.moveTo(x + 24, deckY - 1);
    ctx.quadraticCurveTo(x + 31, canopyY + 1.5, x + 40, hoodY + 1);
    ctx.lineTo(x + 38, hoodY + 4.5);
    ctx.quadraticCurveTo(x + 30, canopyY + 5, x + 25, deckY + 2);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x + 29, deckY); ctx.lineTo(x + 35, canopyY + 4); ctx.stroke();
    // driver helmet
    if (!ducking) {
      ctx.fillStyle = '#f0f0f0';
      ctx.beginPath(); ctx.arc(x + 33, hoodY + 1, 3.6, Math.PI, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color; ctx.fillRect(x + 30, hoodY - 0.5, 7, 1.6);
    }
    // side mirror
    ctx.fillStyle = accent; ctx.fillRect(x + 43, hoodY - 3, 4, 2.5);
    // door roundel + number
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(x + 50, doorCY, 6 * k, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = accent;
    ctx.font = `bold ${Math.round(8.5 * k)}px "JetBrains Mono", Consolas, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(number), x + 50, doorCY + 0.5);
    // headlight pod + lens glow
    const hl = ctx.createLinearGradient(x + w - 12, noseY, x + w - 12, noseY + 7);
    hl.addColorStop(0, '#ffffff'); hl.addColorStop(1, '#fff2a8');
    ctx.fillStyle = hl;
    roundRect(ctx, x + w - 13, noseY + 1.5, 9, 5.5, 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,248,168,0.28)'; ctx.fillRect(x + w - 4, noseY + 2.5, 16, 3);
    // rear light + exhaust tip
    ctx.fillStyle = '#ff3a3a'; ctx.fillRect(x + 2, tailY + 1, 3, 4);
    ctx.fillStyle = '#999'; ctx.fillRect(x + 1, floorY - 5, 4, 3);
    // metallic top sheen
    ctx.save(); ctx.globalAlpha = 0.16; ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x + 44, hoodY + 1);
    ctx.quadraticCurveTo(x + 60, hoodY - 1, x + 74, noseY + 1);
    ctx.lineTo(x + 74, noseY + 4);
    ctx.quadraticCurveTo(x + 60, hoodY + 2, x + 44, hoodY + 4);
    ctx.closePath(); ctx.fill(); ctx.restore();
    ctx.restore();
  }
  function drawPlayer() {
    drawPlayerGT();   // the GT body is the only car now
  }

  function drawObstacles() {
    for (const o of state.obstacles) {
      if (o.type === 'pothole') {
        // Cracked asphalt depression — high-contrast rim + depth + cracks, plus a
        // dark outline so it stays readable against the warm dusk grade.
        const px = o.x + o.w / 2, py = o.y + o.h / 2;
        ctx.fillStyle = 'rgba(0,0,0,0.30)';
        ctx.beginPath();
        ctx.ellipse(px, py + 3, o.w / 2 + 4, o.h / 2 + 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#050507';   // dark contrast outline (reads on bright/orange)
        ctx.beginPath();
        ctx.ellipse(px, py, o.w / 2 + 4, o.h / 2 + 3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#54545e';   // crumbled rim (lighter + wider than before)
        ctx.beginPath();
        ctx.ellipse(px, py, o.w / 2 + 2, o.h / 2 + 1.5, 0, 0, Math.PI * 2);
        ctx.fill();
        const hg = ctx.createRadialGradient(px, py - 2, 2, px, py, o.w / 2);
        hg.addColorStop(0, '#000');
        hg.addColorStop(0.7, '#0a0a0e');
        hg.addColorStop(1, '#1c1c22');
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.ellipse(px, py, o.w / 2 - 2, o.h / 2 - 1, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(180,180,195,0.85)';  // bright near-rim crescent (instant read)
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.ellipse(px, py - 1, o.w / 2 - 3, o.h / 2 - 2, 0, Math.PI * 1.02, Math.PI * 1.98);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(8,8,10,0.9)';        // stronger cracks
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(px - o.w / 2, py); ctx.lineTo(px - o.w / 2 - 10, py - 5);
        ctx.moveTo(px - o.w / 2 + 4, py + 2); ctx.lineTo(px - o.w / 2 - 6, py + 6);
        ctx.moveTo(px + o.w / 2, py + 1); ctx.lineTo(px + o.w / 2 + 11, py + 4);
        ctx.stroke();
      } else if (o.type === 'cone') {
        // Traffic cone — weighted base, lit/shaded body, reflective bands.
        const cxm = o.x + o.w / 2, byb = o.y + o.h;
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.beginPath();
        ctx.ellipse(cxm, byb, o.w / 2 + 5, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#17171b';   // base slab
        roundRect(ctx, o.x - 4, byb - 5, o.w + 8, 6, 2);
        ctx.fill();
        const cg = ctx.createLinearGradient(o.x - 4, 0, o.x + o.w + 4, 0);
        cg.addColorStop(0, '#ff7a3a'); cg.addColorStop(0.5, '#e85a1a'); cg.addColorStop(1, '#b8430f');
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.moveTo(cxm, o.y);
        ctx.lineTo(o.x + o.w + 4, byb - 4);
        ctx.lineTo(o.x - 4, byb - 4);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fdfdfd';   // reflective bands (trapezoids following the taper)
        ctx.beginPath();
        ctx.moveTo(cxm - 5, o.y + 13); ctx.lineTo(cxm + 5, o.y + 13);
        ctx.lineTo(cxm + 7, o.y + 18); ctx.lineTo(cxm - 7, o.y + 18); ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cxm - 9, o.y + 23); ctx.lineTo(cxm + 9, o.y + 23);
        ctx.lineTo(cxm + 11, o.y + 28); ctx.lineTo(cxm - 11, o.y + 28); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.45)';   // tip highlight
        ctx.beginPath(); ctx.arc(cxm, o.y + 2, 2, 0, Math.PI * 2); ctx.fill();
      } else if (o.type === 'sign') {
        // Overhead low-clearance warning panel on a hazard-striped post (duck under).
        const postX = o.x + o.w / 2 - 3;
        ctx.fillStyle = '#5a5a62';
        ctx.fillRect(postX, o.y + o.h, 6, GROUND_Y - (o.y + o.h));
        for (let i = 0; i < 4; i++) {   // yellow/black hazard stripes near the base
          ctx.fillStyle = i % 2 === 0 ? '#f5c518' : '#1a1a1e';
          ctx.fillRect(postX, GROUND_Y - 8 - i * 8, 6, 8);
        }
        ctx.fillStyle = '#48484f';   // mounting gantry bar + brackets above the panel
        ctx.fillRect(o.x - 4, o.y - 6, o.w + 8, 5);
        ctx.fillRect(o.x + 8, o.y - 1, 4, 3);
        ctx.fillRect(o.x + o.w - 12, o.y - 1, 4, 3);
        const pg = ctx.createLinearGradient(0, o.y, 0, o.y + o.h);   // beveled red panel
        pg.addColorStop(0, '#e8484a'); pg.addColorStop(1, '#b82a2a');
        ctx.fillStyle = pg;
        roundRect(ctx, o.x, o.y, o.w, o.h, 4);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;   // reflective border
        roundRect(ctx, o.x + 3, o.y + 3, o.w - 6, o.h - 6, 3);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';   // corner bolts
        [[o.x + 7, o.y + 6], [o.x + o.w - 7, o.y + 6], [o.x + 7, o.y + o.h - 6], [o.x + o.w - 7, o.y + o.h - 6]]
          .forEach((b) => { ctx.beginPath(); ctx.arc(b[0], b[1], 1.4, 0, Math.PI * 2); ctx.fill(); });
        ctx.font = 'bold 16px "JetBrains Mono", Consolas, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillText('STOP', o.x + o.w / 2 + 1, o.y + o.h / 2 + 1);
        ctx.fillStyle = '#fff';
        ctx.fillText('STOP', o.x + o.w / 2, o.y + o.h / 2);
      }
    }
  }
  // Nitro pickup — a glowing blue lightning bolt (concept by Levi Ray, PR #24).
  function drawNitro(c) {
    const cx = c.x + c.w / 2;
    const cy = c.y + Math.sin(c.bob) * 4 + c.h / 2;
    const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(c.bob * 1.5));
    ctx.save();
    ctx.fillStyle = `rgba(0, 212, 255, ${0.30 * pulse})`;
    ctx.beginPath();
    ctx.arc(cx, cy, c.w * 0.78, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(cx, cy);
    ctx.scale(c.w / 28, c.h / 28);
    ctx.beginPath();
    ctx.moveTo(2, -14); ctx.lineTo(-6, 2); ctx.lineTo(-1, 2);
    ctx.lineTo(-3, 14); ctx.lineTo(7, -3); ctx.lineTo(1, -3);
    ctx.lineTo(5, -14); ctx.closePath();
    ctx.shadowColor = '#00d4ff';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#00d4ff';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.scale(0.55, 0.55);
    ctx.fill();
    ctx.restore();
  }

  // Active-nitro screen feedback: a pulsing blue edge glow + a labelled timer
  // bar (and a few speed streaks when motion is allowed).
  function drawNitroOverlay() {
    if (state.nitro <= 0) return;
    const frac = state.nitro / NITRO_DURATION;   // 1 -> 0
    const calm = reduceMotionOn();
    ctx.save();
    const pulse = calm ? 0.5 : 0.5 + 0.5 * Math.sin(state.runTime * 18);
    ctx.lineWidth = 8;
    ctx.strokeStyle = `rgba(0, 212, 255, ${0.30 + 0.25 * pulse})`;
    ctx.shadowColor = '#00d4ff';
    ctx.shadowBlur = 22;
    ctx.strokeRect(4, 4, VIEW_W - 8, VIEW_H - 8);
    ctx.shadowBlur = 0;
    if (!calm) {
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.35)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const y = (i * 113 + Math.floor(state.runTime * 1400)) % VIEW_H;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(70 + (i % 3) * 40, y); ctx.stroke();
      }
    }
    ctx.fillStyle = '#00d4ff';
    ctx.font = 'bold 20px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = '#00d4ff';
    ctx.shadowBlur = 12;
    ctx.fillText('⚡ NITRO ⚡', VIEW_W / 2, 12);
    ctx.shadowBlur = 0;
    const bw = 180, bx = (VIEW_W - bw) / 2, by = 38;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(bx, by, bw, 5);
    ctx.fillStyle = '#00d4ff';
    ctx.fillRect(bx, by, bw * frac, 5);
    ctx.restore();
  }

  function drawCollectibles() {
    for (const c of state.collectibles) {
      if (c.type === 'pitstop') {
        drawPitstop(c);
        continue;
      }
      if (c.type === 'nitro') {
        drawNitro(c);
        continue;
      }
      const float = Math.sin(c.bob) * 4;
      const y = c.y + float;
      if (c.type === 'fuel') {
        // Stereotypical NATO jerry can: red body with the signature embossed
        // X-brace, a pour spout + cap, and a top carry-handle. Red in the default
        // palette; the colorblind palette keeps it blue so it never reads as a
        // hazard — and the unmistakable can SHAPE means fuel never relies on
        // colour alone (accessibility: shape redundancy, not just hue).
        const fuelGlow  = gameColor('rgba(220, 70, 55, 0.34)', 'rgba(0, 114, 178, 0.38)');
        const fuelBody  = gameColor('#c0392b', '#005f8f');
        const fuelShade = gameColor('#7d241b', '#00405c');
        const fuelEdge  = gameColor('#e8897f', '#7fc7ef');
        const metal     = '#9aa3ab';
        const cx = c.x + c.w / 2;
        // soft glow halo
        ctx.fillStyle = fuelGlow;
        ctx.beginPath();
        ctx.arc(cx, y + c.h / 2, c.w * 0.72, 0, Math.PI * 2);
        ctx.fill();
        // can geometry (body leaves headroom for the spout + handle)
        const bx = c.x + c.w * 0.12, bw = c.w * 0.76;
        const bTop = y + c.h * 0.22, bh = c.h * 0.76;
        // pour spout (top-right), drawn first so the body overlaps its base
        ctx.fillStyle = metal;
        ctx.strokeStyle = fuelShade;
        ctx.lineWidth = 1;
        const sx = bx + bw * 0.66, sTop = bTop - c.h * 0.16;
        ctx.beginPath();
        ctx.moveTo(sx, bTop);
        ctx.lineTo(sx + c.w * 0.20, sTop);
        ctx.lineTo(sx + c.w * 0.30, sTop + c.h * 0.06);
        ctx.lineTo(sx + c.w * 0.12, bTop + c.h * 0.05);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        // body
        ctx.fillStyle = fuelBody;
        roundRect(ctx, bx, bTop, bw, bh, 2);
        ctx.fill();
        ctx.strokeStyle = fuelShade;
        ctx.lineWidth = 2;
        ctx.stroke();
        // top carry-handle (arched strap straddling the body top)
        ctx.strokeStyle = fuelShade;
        ctx.lineWidth = Math.max(1.5, c.w * 0.07);
        ctx.beginPath();
        ctx.arc(bx + bw * 0.32, bTop, bw * 0.20, Math.PI, 0);
        ctx.stroke();
        // signature X-brace on an inset face panel
        const ix = bx + bw * 0.15, iy = bTop + bh * 0.16;
        const iw = bw * 0.70, ih = bh * 0.66;
        ctx.lineWidth = 1;
        ctx.strokeStyle = fuelShade;
        ctx.strokeRect(ix, iy, iw, ih);
        ctx.strokeStyle = fuelEdge;
        ctx.lineWidth = Math.max(1.3, c.w * 0.05);
        ctx.beginPath();
        ctx.moveTo(ix, iy); ctx.lineTo(ix + iw, iy + ih);
        ctx.moveTo(ix + iw, iy); ctx.lineTo(ix, iy + ih);
        ctx.stroke();
      } else {
        // Snack — yellow coin
        const snackGlow = gameColor('rgba(245, 215, 110, 0.4)', 'rgba(255, 210, 63, 0.42)');
        const snackBody = gameColor('#f5d76e', '#ffd23f');
        const snackStroke = gameColor('#a86a1a', '#7a4b00');
        ctx.fillStyle = snackGlow;
        ctx.beginPath();
        ctx.arc(c.x + c.w / 2, y + c.h / 2, c.w * 0.65, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = snackBody;
        ctx.beginPath();
        ctx.arc(c.x + c.w / 2, y + c.h / 2, c.w / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = snackStroke;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = snackStroke;
        ctx.font = 'bold 16px "JetBrains Mono", Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('$', c.x + c.w / 2, y + c.h / 2);
      }
    }
  }
  function drawPitstop(c) {
    // A lively roadside station: pulsing welcome glow, a chase-blink marquee,
    // a flickering price display, a fuel hose, and a little attendant waving you
    // in. All motion eases off under reduce-motion (calm = steady lights/figure).
    // Drawn ~1.3x around its bottom-centre for more presence/dwell — pure visual
    // scale; the pickup hitbox (makePitstop) is unchanged.
    const x = c.x, y = c.y, t = state.runTime, calm = reduceMotionOn();
    const _ox = c.x + c.w / 2, _oy = c.y + c.h;
    ctx.save();
    ctx.translate(_ox, _oy); ctx.scale(1.3, 1.3); ctx.translate(-_ox, -_oy);
    // pulsing welcome glow
    const glow = calm ? 0.30 : 0.24 + 0.12 * (0.5 + 0.5 * Math.sin(t * 3));
    ctx.fillStyle = `rgba(126, 226, 126, ${glow})`;
    ctx.beginPath();
    ctx.arc(x + c.w / 2, y + c.h / 2 + 8, c.w * 0.72, 0, Math.PI * 2);
    ctx.fill();
    // posts
    ctx.fillStyle = '#6a5a48';
    ctx.fillRect(x + 4, y + 18, 4, c.h - 18);
    ctx.fillRect(x + c.w - 8, y + 18, 4, c.h - 18);
    // awning (red+white) + trim
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#d63a3a' : '#fafafa';
      ctx.fillRect(x + i * (c.w / 6), y, c.w / 6 + 1, 14);
    }
    ctx.fillStyle = '#3a3a40';
    ctx.fillRect(x, y + 14, c.w, 4);
    // marquee bulbs along the trim — chase-blink
    for (let i = 0; i < 7; i++) {
      const bx = x + 6 + i * ((c.w - 12) / 6);
      const on = calm ? (i % 2 === 0) : ((Math.floor(t * 6) + i) % 2 === 0);
      ctx.fillStyle = on ? '#fff2a8' : '#6b5a2a';
      ctx.beginPath(); ctx.arc(bx, y + 17, 2, 0, Math.PI * 2); ctx.fill();
    }
    // pump body
    ctx.fillStyle = '#2f7a3a';
    roundRect(ctx, x + c.w / 2 - 12, y + 24, 24, c.h - 24, 3);
    ctx.fill();
    ctx.strokeStyle = '#1f5526'; ctx.lineWidth = 1; ctx.stroke();
    // flickering price display
    ctx.fillStyle = '#0d1f0c';
    ctx.fillRect(x + c.w / 2 - 9, y + 28, 18, 9);
    ctx.fillStyle = '#7cfc7c';
    ctx.font = 'bold 8px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const price = calm ? '3.49' : '3.' + String(40 + (Math.floor(t * 3) % 9)).padStart(2, '0');
    ctx.fillText(price, x + c.w / 2, y + 33);
    // fuel hose from the pump
    ctx.strokeStyle = '#1f1f24'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + c.w / 2 + 12, y + 32);
    ctx.quadraticCurveTo(x + c.w - 6, y + 38, x + c.w - 9, y + c.h - 6);
    ctx.stroke();
    // attendant — bobs + waves you in
    const wob = calm ? 0 : Math.sin(t * 4) * 1.4;
    const ax = x + 13, ay = y + c.h - 16 + wob;
    ctx.fillStyle = '#3a6aa8'; ctx.fillRect(ax - 3, ay, 6, 12);            // overalls
    ctx.fillStyle = '#f4c891'; ctx.beginPath(); ctx.arc(ax, ay - 3, 3, 0, Math.PI * 2); ctx.fill(); // head
    const wave = calm ? -0.5 : Math.sin(t * 9) * 0.5 - 0.3;               // waving arm
    ctx.strokeStyle = '#3a6aa8'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax + 2, ay + 3);
    ctx.lineTo(ax + 4 + Math.cos(wave) * 5, ay + 1 + Math.sin(wave) * 5);
    ctx.stroke();
    // label
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 8px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('PIT STOP', x + c.w / 2, y + c.h - 2);
    ctx.restore();
  }

  function drawSemis() {
    for (const s of state.semis) {
      // Trailer
      ctx.fillStyle = s.color;
      roundRect(ctx, s.x, GROUND_Y - 64, 180, 56, 4);
      ctx.fill();
      // Trailer logo stripe
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(s.x + 16, GROUND_Y - 44, 148, 4);
      // Cab
      ctx.fillStyle = '#dadada';
      roundRect(ctx, s.x + 180, GROUND_Y - 52, 56, 44, 5);
      ctx.fill();
      // Cab windshield
      ctx.fillStyle = '#9cd0f0';
      ctx.fillRect(s.x + 198, GROUND_Y - 46, 28, 14);
      // Headlight (we're facing -X so it's on the left side)
      ctx.fillStyle = '#fff8a8';
      ctx.fillRect(s.x + 234, GROUND_Y - 30, 4, 6);
      // Wheels — three under trailer, one under cab
      const wheelY = GROUND_Y - 4;
      [s.x + 24, s.x + 96, s.x + 168, s.x + 220].forEach((wx) => {
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.arc(wx, wheelY, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.arc(wx, wheelY, 3, 0, Math.PI * 2);
        ctx.fill();
      });
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(s.x + 4, GROUND_Y + 10, 232, 4);
    }
  }

  function drawParticles() {
    for (const p of state.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  // ============================================================
  // RENDERING — overlays drawn on canvas
  // ============================================================
  function drawDamageFlash() {
    if (state.flashTimer <= 0) return;
    ctx.fillStyle = `rgba(232, 90, 26, ${state.flashTimer * 1.4})`;
    ctx.fillRect(0, 0, W, H);
  }
  function drawSpeedLines() {
    if (reduceMotionOn()) return;   // motion-blur speed lines disabled for reduced motion
    // Only at higher speeds; intensity scales with how fast above base
    const frac = (state.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED);
    if (frac < 0.55) return;
    const intensity = (frac - 0.55) / 0.45; // 0..1
    const count = Math.floor(4 + intensity * 14);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.15 + intensity * 0.35})`;
    ctx.lineWidth = 1.2;
    for (let i = 0; i < count; i++) {
      // pseudo-random but stable per-frame seed by state.distance for some flicker
      const seed = (i * 9301 + Math.floor(state.distance * 1.4)) % 233280;
      const r = (seed / 233280);
      const y = 100 + r * (GROUND_Y - 120);
      const len = 40 + r * 80 + intensity * 60;
      const x = (Math.floor(state.distance * 4) + i * 71) % (W + 200) - 100;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawSpeedVignette() {
    const frac = (state.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED);
    if (frac < 0.7) return;
    const intensity = (frac - 0.7) / 0.3;
    const g = ctx.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 540);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.18 * intensity})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  // Cinematic grade: soft vignette + a very subtle per-biome warm/cool wash.
  // Static (no motion). Eased off under colorblind so it never muddies contrast.
  function drawColorGrade(biome) {
    const vg = ctx.createRadialGradient(W / 2, H / 2 - 30, H * 0.36, W / 2, H / 2, H * 0.82);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    if (!state.settings.colorblind) {
      const wash = {
        dawn:      'rgba(255,150,90,0.05)',
        morning:   'rgba(120,170,255,0.045)',
        afternoon: 'rgba(255,170,60,0.048)',
        sunset:    'rgba(255,110,70,0.058)'
      }[biome.timeOfDay];
      if (wash) { ctx.fillStyle = wash; ctx.fillRect(0, 0, W, H); }
    }
  }
  // Pulsing red screen-edge glow while fuel is critical (the physics layer's state.fuelLow).
  // Motion, so gated by reduce-motion — the steady HUD 'low' bar still shows.
  function drawLowFuelPulse() {
    if (!state.fuelLow || reduceMotionOn()) return;
    const pulse = 0.16 + 0.16 * (0.5 + 0.5 * Math.sin(state.runTime * 6));
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.46, W / 2, H / 2, H * 0.92);
    g.addColorStop(0, 'rgba(220,40,30,0)');
    g.addColorStop(1, `rgba(220,40,30,${pulse})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  function drawBiomeBanner() {
    // Show biome name briefly when entering a new biome
    const b = currentBiome();
    if (state.biomeAnnounced !== state.biomeIdx) {
      state.biomeAnnounced = state.biomeIdx;
      state.bannerT = 2.2;
      state.bannerText = b.name;
    }
    if (state.bannerT > 0) {
      const a = Math.min(1, state.bannerT * 1.5);
      const leg = state.biomeIdx + 1;
      const total = BIOMES.length;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(12, 14, 24, 0.78)';
      const bw = 300, bh = 70;
      const bx = (W - bw) / 2, by = 96;
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#f5d76e';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#9fb6ff';
      ctx.font = 'bold 13px "JetBrains Mono", Consolas, monospace';
      ctx.fillText(`LEG ${leg} OF ${total}`, W / 2, by + 22);
      ctx.fillStyle = '#f5d76e';
      ctx.font = 'bold 24px "JetBrains Mono", Consolas, monospace';
      ctx.fillText(`▸  ${state.bannerText}  ◂`, W / 2, by + 47);
      ctx.restore();
    }
  }

  // Checkered race gate that scrolls in during the final stretch of the coast.
  function drawFinishLine() {
    const ahead = TRIP_TOTAL - state.distance;
    if (ahead > W - PLAYER_X + 60 || ahead < -140) return;
    const x = PLAYER_X + ahead;
    const top = GROUND_Y - 150;
    const gateW = 76;
    const sq = 13;
    ctx.save();
    // checkered banner across the top of the gate
    const cols = Math.ceil(gateW / sq);
    for (let i = 0; i < cols; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#fafafa' : '#15151c';
      ctx.fillRect(x + i * sq, top, sq, 26);
    }
    ctx.strokeStyle = '#15151c';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, top, gateW, 26);
    // posts
    ctx.fillStyle = '#dcdce2';
    ctx.fillRect(x - 6, top, 6, GROUND_Y - top);
    ctx.fillRect(x + gateW, top, 6, GROUND_Y - top);
    // label
    ctx.fillStyle = '#15151c';
    ctx.font = 'bold 12px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FINISH', x + gateW / 2, top + 13);
    // checkered strip painted across the road
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i < cols + 1; i++) {
        ctx.fillStyle = (i + row) % 2 === 0 ? '#fafafa' : '#15151c';
        ctx.fillRect(x - 6 + i * sq, GROUND_Y + row * 6, sq, 6);
      }
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  // ============================================================
  // HUD
  // ============================================================
  function updateHUD() {
    const b = currentBiome();
    hudScore.textContent = pad(state.score, 6);
    hudBiome.textContent = `${b.name} ${state.biomeIdx + 1}/${BIOMES.length}`;
    hudMph.textContent = String(Math.round(state.speed * 12));
    const fuelFrac = Math.max(0, state.fuel) / FUEL_MAX;
    hudFuel.style.width = `${fuelFrac * 100}%`;
    hudFuel.classList.toggle('low', fuelFrac < 0.25);
    hudFuel.classList.toggle('mid', fuelFrac >= 0.25 && fuelFrac < 0.5);
    hudTrip.style.width = `${Math.min(100, (state.distance / TRIP_TOTAL) * 100)}%`;
    // A11y: keep progressbar values + canvas summary in sync (canvas throttled).
    if (hudFuelBar) hudFuelBar.setAttribute('aria-valuenow', String(Math.round(fuelFrac * 100)));
    if (hudTripBar) hudTripBar.setAttribute('aria-valuenow', String(Math.min(100, Math.round((state.distance / TRIP_TOTAL) * 100))));
    state._ariaTick = (state._ariaTick || 0) + 1;
    if (state._ariaTick % 20 === 0) updateCanvasAria();
  }

  function checkProgressAchievements() {
    if (state.speed >= MAX_SPEED - 0.05) unlockAchievement('max-speed');
    // Reuse the fuel-low band so the achievement can never drift from the flag.
    if (state.fuelLow) unlockAchievement('low-fuel');
    if (state.distance >= TRIP_TOTAL * 0.5) unlockAchievement('halfway');
    if (state.score >= 3000) unlockAchievement('score-3000');
  }


  // ============================================================
  // GAMEPLAY UPDATE
  // ============================================================
  let lastFrame = 0;
  let exhaustTimer = 0;
  let brakeSmokeTimer = 0;

  function updateGame(dt) {
    // Speed input
    const duckHeld = actionDown('duck');
    if (duckHeld && !state._duckHeldPrev) audio.playDuck();   // duck SFX on press (kbd + gamepad)
    state._duckHeldPrev = duckHeld;
    state.player.ducking = duckHeld;
    // Auto-throttle: manual accel/brake retired (A/D now drive lane changes).
    // Speed eases toward the per-leg effective cap (MAX_SPEED * ramped speedScale),
    // so the car always presses forward and the trip accelerates toward COAST.
    const cap = MAX_SPEED * legSpeedScale();
    state.speed += (cap - state.speed) * Math.min(1, 0.05 * (dt * 60));

    updatePlayer(dt);
    updateWorld(dt);
    updateParticles(dt);
    updateScorePopups(dt);

    const nitroBoost = state.nitro > 0 ? NITRO_SPEED_MULT : 1;   // mirrors the world-motion boost in updateWorld
    state.distance += state.speed * nitroBoost * dt * 60;
    if (state.nitro > 0) state.nitro = Math.max(0, state.nitro - dt);
    state.score += state.speed * dt * 3;        // passive distance score (trimmed 8->3: skill, not idling, should dominate)
    state.fuel -= FUEL_DRAIN_PER_SEC * dt;
    // Fuel-low feedback hook (physics produces; HUD/audio consume). We compute the
    // rising edge against the *previous* value before overwriting it, so a
    // consumer can fire a one-shot warning without tracking history itself.
    const lowNow = state.fuel > 0 && state.fuel < FUEL_MAX * FUEL_LOW_FRAC;
    state.fuelLowJustEntered = lowNow && !state.fuelLow;
    state.fuelLow = lowNow;
    state.runTime += dt;
    state.ghostSampleTimer -= dt;
    recordGhostFrame();
    state.flashTimer = Math.max(0, state.flashTimer - dt);
    state.shakeT = Math.max(0, state.shakeT - dt);
    state.bannerT = Math.max(0, (state.bannerT || 0) - dt);
    state.comboPopupT = Math.max(0, state.comboPopupT - dt);
    // Combo decay window
    if (state.combo > 0) {
      state.comboTimer -= dt;
      if (state.comboTimer <= 0) state.combo = 0;
    }

    // Biome clear bonus
    const b = currentBiome();
    if (state.biomeIdx > state._lastBiomeIdx) {
      state.score += BIOME_BONUS;
      state._lastBiomeIdx = state.biomeIdx;
      audio.playBiome();                 // leg transition sound
      announce('Entering ' + b.name);
      if (b.name === 'FOREST') unlockAchievement('forest');
      if (b.name === 'DESERT') unlockAchievement('desert');
      if (b.name === 'COAST') unlockAchievement('coast');
    }
    checkProgressAchievements();

    // Low-fuel warning: the physics layer flags the rising edge (state.fuelLowJustEntered);
    // we play the one-shot beep + announce here. It re-arms automatically after a
    // refuel because the physics layer only sets the flag on a fresh crossing into the low band.
    if (state.fuelLowJustEntered) {
      audio.playLowFuel();
      announce('Low fuel');
    }

    // Engine pitch follows speed
    audio.updateEngine((state.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED));

    // Exhaust puffs while moving fast
    exhaustTimer -= dt;
    if (exhaustTimer <= 0 && state.speed > BASE_SPEED + 0.5) {
      spawnExhaust(PLAYER_X + 4, state.player.y - 10);
      exhaustTimer = 0.07;
    }
    // Tyre smoke when skidding into a lane change at speed.
    if (state.player.laneTweenT > 0 && state.speed > BASE_SPEED + 1) {
      brakeSmokeTimer -= dt;
      if (brakeSmokeTimer <= 0) {
        spawnTireSmoke(PLAYER_X + 22, state.player.laneBaseY + CAR_FOOT_OFFSET - 2);
        brakeSmokeTimer = 0.04;
      }
    } else {
      brakeSmokeTimer = 0;
    }

    // Win/lose
    if (state.distance >= TRIP_TOTAL) {
      state.pendingScore = state.score;
      finalizeGhost('win');
      audio.stopEngine();
      audio.playWin();
      unlockAchievement('finish');
      if (state.runStats.hits === 0) unlockAchievement('clean-finish');
      unlockSandbox();
      show(SCREEN.WIN);
      document.getElementById('win-score').textContent = pad(state.score, 6);
      const rs = state.runStats;
      const secs = Math.round(state.runTime);
      const timeStr = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const cleanLine = rs.hits === 0
        ? '<div class="stat stat-clean">CLEAN RUN — no deductible!</div>'
        : '';
      document.getElementById('win-stats').innerHTML =
        `<div class="stat"><span>TIME</span><b>${timeStr}</b></div>` +
        `<div class="stat"><span>SNACKS</span><b>${rs.snacks}</b></div>` +
        `<div class="stat"><span>FUEL CANS</span><b>${rs.fuel}</b></div>` +
        `<div class="stat"><span>PIT STOPS</span><b>${rs.pitstops}</b></div>` +
        `<div class="stat"><span>HITS</span><b>${rs.hits}</b></div>` +
        cleanLine;
      return;
    }
    if (state.fuel <= 0) {
      state.fuel = 0;
      state.pendingScore = state.score;
      const pct = Math.round((state.distance / TRIP_TOTAL) * 100);
      document.getElementById('go-summary').textContent =
        `You made it ${pct}% of the way before the tank ran dry.`;
      document.getElementById('go-score').textContent = pad(state.score, 6);
      finalizeGhost('gameover');
      audio.stopEngine();
      audio.playLose();
      show(SCREEN.GAMEOVER);
    }
  }

  // ============================================================
  // RENDER FRAME
  // ============================================================
  function render() {
    // Reset the logical->device transform first so every draw below works in
    // the fixed VIEW_W x VIEW_H space regardless of the real backing-store size.
    applyViewTransform();
    const b = currentBiome();
    const shake = state.screen === SCREEN.PLAYING ? shakeOffset() : { x: 0, y: 0 };

    ctx.save();
    ctx.translate(shake.x, shake.y);

    drawSky(b);
    drawSun(b);
    drawClouds(b);
    drawBirds();
    drawFarMountains(b);
    drawAtmosphere(b);
    drawMidScenery(b);
    drawGround(b);
    drawNearScenery(b);

    if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) {
      drawSemis();
      drawCollectibles();
      drawObstacles();
      drawFinishLine();
      drawSpeedLines();
      drawGhostPlayer();
      drawPlayer();
      drawParticles();
      drawScorePopups();
    }

    ctx.restore();

    drawColorGrade(b);   // cinematic vignette + subtle per-biome grade (all screens)

    if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) {
      drawSpeedVignette();
      drawLowFuelPulse();
      drawBiomeBanner();
      drawComboHud();
      drawDamageFlash();
      drawNitroOverlay();
    }
    drawAudioBanner();
    drawAchievementToast();
    if (state.debug) drawDebugOverlay();
  }

  // Hidden developer overlay (toggled by backtick when DEBUG === true). Draws
  // the exact collision boxes the physics/collision code uses, the ground-
  // contact reference line, and a live per-leg difficulty readout — so balance
  // and hitbox tuning are inspectable in the running game. Authored in the
  // logical VIEW space (the render transform maps it to device pixels for free).
  function drawDebugOverlay() {
    ctx.save();
    ctx.lineWidth = 1.5;
    // Player hitbox — the real rect collisions are tested against.
    const pb = playerBox();
    ctx.strokeStyle = '#00ff88';
    ctx.strokeRect(pb.x, pb.y, pb.w, pb.h);
    // Obstacle + collectible hitboxes.
    ctx.strokeStyle = '#ff3a3a';
    for (const o of state.obstacles) ctx.strokeRect(o.x, o.y, o.w, o.h);
    ctx.strokeStyle = '#3aa0ff';
    for (const c of state.collectibles) ctx.strokeRect(c.x, c.y, c.w, c.h);
    // Ground-contact reference: wheels + shadow rest exactly on this line.
    ctx.strokeStyle = 'rgba(255,235,90,0.7)';
    ctx.beginPath();
    ctx.moveTo(0, ROAD_SURFACE_Y);
    ctx.lineTo(W, ROAD_SURFACE_Y);
    ctx.stroke();

    const diff = currentDifficulty();
    const b = currentBiome();
    const pct = ((state.distance / TRIP_TOTAL) * 100).toFixed(1);
    const lines = [
      'DEBUG  (backtick toggles)',
      `leg ${state.biomeIdx + 1}/${BIOMES.length}  ${b.name}`,
      `density ${diff.obstacleDensity}  minGap ${diff.minBlockingGap}px`,
      `fuelRate ${diff.fuelSpawnRate}  fuel/can ${diff.fuelPerCan}  speedScale ${diff.speedScale}`,
      `speed ${state.speed.toFixed(2)} (${Math.round(state.speed * 12)} mph)  max ${MAX_SPEED}`,
      `fuel ${state.fuel.toFixed(1)}  low=${state.fuelLow}`,
      `player.y ${state.player.y.toFixed(1)}  vy ${state.player.vy.toFixed(2)}  jump=${state.player.jumping}`,
      `combo x${state.combo}  window ${state.comboTimer.toFixed(1)}s`,
      `obstacles ${state.obstacles.length}  collectibles ${state.collectibles.length}`,
      `dist ${Math.round(state.distance)}/${TRIP_TOTAL}  (${pct}%)`
    ];
    ctx.font = '11px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const lineH = 14, panelW = 330, panelH = lines.length * lineH + 12;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(8, 78, panelW, panelH);
    ctx.fillStyle = '#9effa0';
    lines.forEach((ln, i) => ctx.fillText(ln, 16, 84 + i * lineH));
    ctx.restore();
  }

  function drawAudioBanner() {
    if (audioBanner.t <= 0) return;
    const a = Math.min(1, audioBanner.t * 2);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(12,14,24,0.85)';
    const bw = 180, bh = 36;
    ctx.fillRect(W - bw - 20, 20, bw, bh);
    const bannerC = toastColor('#f5d76e');   // palette-aware (colorblind map)
    ctx.strokeStyle = bannerC;
    ctx.lineWidth = 1;
    ctx.strokeRect(W - bw - 20, 20, bw, bh);
    ctx.fillStyle = bannerC;
    ctx.font = 'bold 13px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`♪  ${audioBanner.text}`, W - bw / 2 - 20, 38);
    ctx.restore();
  }

  function drawAchievementToast() {
    if (!state.achievementToast) return;
    const a = Math.min(1, state.achievementToast.t * 2);
    // Anchored just BELOW the top card band (old position y=20 overlapped the
    // SCORE/STAGE cards). x range stays clear of the centered biome banner.
    const bw = 280, bh = 48;
    const bx = 20, by = HUD_SAFE_TOP + 4;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(12,14,24,0.9)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = toastColor('#f5d76e');
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = toastColor('#f5d76e');
    ctx.font = 'bold 11px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('ACHIEVEMENT UNLOCKED', bx + 12, by + 9);
    ctx.fillStyle = '#ececec';
    ctx.font = 'bold 14px "JetBrains Mono", Consolas, monospace';
    ctx.fillText(state.achievementToast.title, bx + 12, by + 25);
    ctx.restore();
  }

  // ============================================================
  // MAIN LOOP
  // ============================================================
  function tick(time) {
    const dt = Math.min(0.05, (time - lastFrame) / 1000 || 0);
    lastFrame = time;
    pollGamepad();

    if (state.screen === SCREEN.PLAYING) {
      updateGame(dt);
      updateHUD();
    }
    audioBanner.t = Math.max(0, audioBanner.t - dt);
    if (state.achievementToast) {
      state.achievementToast.t -= dt;
      if (state.achievementToast.t <= 0) state.achievementToast = null;
    }

    render();
    requestAnimationFrame(tick);
  }

  // ============================================================
  // SELF-TEST HARNESS (DEBUG-gated; also callable from the console)
  // ============================================================
  // Self-tests run manually via window.runSelfTests() / window.WRT.runSelfTests(),
  // and auto-run on boot when DEBUG is on (defined in CONFIG: "?debug" or
  // localStorage 'wrt.debug'='1'). Tests are NON-DESTRUCTIVE: anything written to
  // real storage is snapshotted and restored, and no AudioContext is created
  // without a user gesture. Returns { pass, fail, total, results } + logs a summary.
  function runSelfTests() {
    const results = [];
    const check = (name, cond, detail) => results.push({ name: name, pass: !!cond, detail: detail || '' });

    // 1) localStorage JSON round-trip for each persistence key (temp sibling key
    //    so real saved data is never touched).
    [SETTINGS_KEY, STORAGE_KEY, ACHIEVEMENTS_KEY, GHOST_KEY].forEach((key) => {
      const tmp = key + '.__selftest__';
      const sample = { key: key, n: 42, list: [3, 2, 1], nested: { ok: true }, s: 'café' };
      let pass = false, err = '';
      try {
        localStorage.setItem(tmp, JSON.stringify(sample));
        const back = JSON.parse(localStorage.getItem(tmp));
        pass = !!back && back.n === 42 && back.list.length === 3 &&
               back.nested.ok === true && back.s === 'café';
      } catch (e) { err = String(e); }
      try { localStorage.removeItem(tmp); } catch (e) {}
      check('localStorage round-trip: ' + key, pass, err);
    });

    // 2) settings load merges defaults; all keys present and correctly typed.
    {
      let pass = false, detail = '';
      try {
        const s = loadSettings();
        const bools = ['screenShake', 'colorblind', 'ghostVisible', 'muted', 'sfxEnabled', 'reduceMotion'];
        const boolsOk = bools.every((k) => typeof s[k] === 'boolean');
        const volOk = typeof s.masterVolume === 'number' && s.masterVolume >= 0 && s.masterVolume <= 1;
        pass = boolsOk && volOk;
        detail = JSON.stringify(s);
      } catch (e) { detail = String(e); }
      check('settings load: defaults + all keys typed', pass, detail);
    }

    // 3) settings save → load preserves every field (round-trip via the real key,
    //    snapshotted + restored).
    {
      let pass = false, detail = '';
      const snap = (() => { try { return localStorage.getItem(SETTINGS_KEY); } catch (e) { return null; } })();
      const realSettings = state.settings;
      try {
        const probe = { screenShake: false, colorblind: true, ghostVisible: false,
                        muted: true, sfxEnabled: false, masterVolume: 0.3, reduceMotion: true };
        state.settings = Object.assign({}, DEFAULT_SETTINGS, probe);
        saveSettings();
        const loaded = loadSettings();
        pass = loaded.screenShake === false && loaded.colorblind === true &&
               loaded.ghostVisible === false && loaded.muted === true &&
               loaded.sfxEnabled === false && loaded.masterVolume === 0.3 &&
               loaded.reduceMotion === true;
        detail = JSON.stringify(loaded);
      } catch (e) { detail = String(e); }
      finally {
        state.settings = realSettings;
        try {
          if (snap === null) localStorage.removeItem(SETTINGS_KEY);
          else localStorage.setItem(SETTINGS_KEY, snap);
        } catch (e) {}
      }
      check('settings save → load preserves all fields', pass, detail);
    }

    // 4) high-score sort is descending and capped at MAX_SCORES (same logic as
    //    insertScore, run on a synthetic list).
    {
      const raw = [120, 50, 999, 3000, 7, 480, 1500, 60];
      const list = raw.map((n, i) => ({ initials: 'AAA', score: n, date: '2026-01-0' + (i % 9) }));
      const sorted = list.slice().sort((a, b) => b.score - a.score).slice(0, MAX_SCORES);
      let descending = true;
      for (let i = 1; i < sorted.length; i++) if (sorted[i - 1].score < sorted[i].score) descending = false;
      check('high-score sort is descending', descending, sorted.map((s) => s.score).join(', '));
      check('high-score list capped at MAX_SCORES (' + MAX_SCORES + ')',
            sorted.length === MAX_SCORES, 'len=' + sorted.length);
      check('high-score top entry is the maximum', sorted[0].score === Math.max.apply(null, raw));
    }

    // 5) achievements never duplicate — unlock is idempotent (snapshot + restore).
    {
      let pass = false, detail = '';
      const id = ACHIEVEMENTS[0].id;
      const snapState = JSON.stringify(state.achievements);
      const snapStore = (() => { try { return localStorage.getItem(ACHIEVEMENTS_KEY); } catch (e) { return null; } })();
      const snapToast = state.achievementToast;
      try {
        unlockAchievement(id);
        const c1 = Object.keys(state.achievements).length;
        const t1 = state.achievements[id];
        unlockAchievement(id);   // second call must be a no-op
        const c2 = Object.keys(state.achievements).length;
        const t2 = state.achievements[id];
        pass = c1 === c2 && t1 === t2;
        detail = 'count ' + c1 + ' → ' + c2;
      } catch (e) { detail = String(e); }
      finally {
        try { state.achievements = JSON.parse(snapState); } catch (e) { state.achievements = {}; }
        state.achievementToast = snapToast;
        try {
          if (snapStore === null) localStorage.removeItem(ACHIEVEMENTS_KEY);
          else localStorage.setItem(ACHIEVEMENTS_KEY, snapStore);
        } catch (e) {}
      }
      check('achievement unlock is idempotent (no dupes)', pass, detail);
    }

    // 6) AudioContext can initialize. To honor the autoplay policy we never
    //    create a context without a user gesture: if the game already has one
    //    (post-gesture) we assert it; otherwise we assert the constructor exists.
    {
      let pass = false, detail = '';
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (audio.ctx) {
          pass = typeof audio.ctx.state === 'string';
          detail = 'live ctx, state=' + audio.ctx.state;
        } else {
          pass = typeof AC === 'function';
          detail = 'constructor available (not instantiated — no user gesture yet)';
        }
      } catch (e) { detail = String(e); }
      check('AudioContext initializes', pass, detail);
    }

    // 7) prefers-reduced-motion seeds the reduceMotion default on a fresh profile
    //    (no saved settings); a saved value still wins. Mocks matchMedia and
    //    snapshots the settings key — fully non-destructive.
    {
      let pass = false, detail = '';
      const realMM = (typeof window !== 'undefined') ? window.matchMedia : undefined;
      const snap = (() => { try { return localStorage.getItem(SETTINGS_KEY); } catch (e) { return null; } })();
      try {
        try { localStorage.removeItem(SETTINGS_KEY); } catch (e) {}
        window.matchMedia = () => ({ matches: true });
        if (!(window.matchMedia('(prefers-reduced-motion: reduce)') || {}).matches) {
          pass = true; detail = 'matchMedia override unsupported — skipped';
        } else {
          const onPref = loadSettings();
          window.matchMedia = () => ({ matches: false });
          const offPref = loadSettings();
          pass = onPref.reduceMotion === true && offPref.reduceMotion === false;
          detail = 'OS reduce-motion on→' + onPref.reduceMotion + ', off→' + offPref.reduceMotion;
        }
      } catch (e) { detail = String(e); }
      finally {
        try { window.matchMedia = realMM; } catch (e) {}
        try {
          if (snap === null) localStorage.removeItem(SETTINGS_KEY);
          else localStorage.setItem(SETTINGS_KEY, snap);
        } catch (e) {}
      }
      check('prefers-reduced-motion seeds reduceMotion default (calm by default)', pass, detail);
    }

    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;
    const tag = failed === 0 ? 'ALL PASS' : failed + ' FAILED';
    try {
      console.group('WRT self-tests — ' + tag + ' (' + passed + '/' + results.length + ')');
      results.forEach((r) => console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  — ' + r.detail : '')));
      console.groupEnd();
    } catch (e) {
      results.forEach((r) => console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name));
    }
    return { pass: passed, fail: failed, total: results.length, results: results };
  }

  // ============================================================
  // BOOT
  // ============================================================
  state._lastBiomeIdx = 0;
  state.bannerT = 0;
  state.scores = loadScores();
  initA11y();
  applySettings();
  syncSettingsInputs();   // reflect loaded settings in the controls before first open
  applyScreen();
  try {
    window.WRT = window.WRT || {};
    window.WRT.runSelfTests = runSelfTests;
    window.runSelfTests = runSelfTests;   // convenience for the console
  } catch (e) {}
  if (DEBUG) {
    try { runSelfTests(); } catch (e) { try { console.error('Self-tests threw:', e); } catch (e2) {} }
  }
  requestAnimationFrame(tick);
})();
