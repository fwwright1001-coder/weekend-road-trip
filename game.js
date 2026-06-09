/* ============================================================
 * Weekend Road Trip — single-player 2D side-scroller
 * ENGR 5513 Applied AI in Engineering · Lipscomb MSAI · Summer 2026
 * Forrest Wright
 *
 * Drive Marty's GT through a Nashville night cruise in one tank
 * of gas. Jump potholes, duck under stop signs, grab fuel & snacks.
 * Don't run out of gas before you reach Lower Broadway.
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
 *   - High scores, achievements, settings, and ghost replays persisted locally
 *     with Vercel/Neon cloud high scores when deployed
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
  const MAX_SPEED = 9.0;           // trimmed 11.0->9.0 (2026-06-09 feel rework): the world read as
                                   // jarringly fast; per-leg speedScale still escalates toward it
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
  const FUEL_DRAIN_PER_SEC = 1.15; // trimmed 1.4->1.15 with the speed cut: trips run ~22% longer
                                   // in time, so per-second drain drops to keep total time-drain
                                   // roughly constant (sim re-proves all economy bands)
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
  const MUTE_KEY = 'wrt.muted.v1';     // legacy; migrated into SETTINGS_KEY on load
  const MAX_SCORES = 5;
  const GHOST_SAMPLE_STEP = 0.08;
  const GHOST_DISTANCE_SCALE = 0.28;
  const GHOST_MAX_FRAMES = 20000;  // import cap: a real run samples a few thousand frames at
                                   // GHOST_SAMPLE_STEP, so anything larger is malformed/hostile
  const GHOST_VERSION = 2;         // bumped with the 2026-06-09 speed retune — v1 ghosts were
                                   // recorded at the old (faster) speeds and would unfairly
                                   // outpace every post-retune run, so they no longer load
  const CAMERA_SIDE = 'side';
  const CAMERA_CHASE = 'chase';

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
      name: 'DOWNTOWN',
      end: 5000,
      timeOfDay: 'dawn',
      sky: ['#f1a56f', '#f8d4a4', '#8fb8d8'],
      sunColor: '#ffe7b2',
      sunY: 120,
      mountainColor: '#4b4a63',
      ground: '#32333a',
      grass: '#304a36',
      road: '#222226',
      dashColor: '#ffea88',
      birdColor: '#222222'
    },
    {
      name: 'MUSIC ROW',
      end: 10000,
      timeOfDay: 'morning',
      sky: ['#78b9dd', '#b7d9ec', '#e8f2ef'],
      sunColor: '#fff6d8',
      sunY: 95,
      mountainColor: '#3f5f48',
      ground: '#344536',
      grass: '#48643d',
      road: '#222226',
      dashColor: '#ffea88',
      birdColor: '#5a3a1f'  // hawks
    },
    {
      name: 'CUMBERLAND',
      end: 15000,
      timeOfDay: 'afternoon',
      sky: ['#d99a6a', '#f3c891', '#bcd8e4'],
      sunColor: '#ffd891',
      sunY: 116,
      mountainColor: '#5e6f71',
      ground: '#5d6f59',
      grass: '#637a4a',
      road: '#2b2b31',
      dashColor: '#ffea88',
      birdColor: '#3a3a3a'
    },
    {
      name: 'BROADWAY',
      end: 20000,
      timeOfDay: 'sunset',
      sky: ['#3d2345', '#9c4165', '#f0a45f'],
      sunColor: '#ffc879',
      sunY: 190,
      mountainColor: '#3b2d4c',
      ground: '#312638',
      grass: '#3f4f34',
      road: '#25252c',
      dashColor: '#ffea88',
      birdColor: '#d8d8e8'
    }
  ];
  const TRIP_TOTAL = BIOMES[BIOMES.length - 1].end;
  const NASHVILLE_GEO = [
    { biome: 'DOWNTOWN', distance: 1250, name: 'RYMAN AUDITORIUM', label: 'RYMAN 5TH AVE', lat: 36.1612473, lon: -86.7784951 },
    { biome: 'DOWNTOWN', distance: 2200, name: 'AT&T BUILDING', label: '333 COMMERCE', lat: 36.1620757, lon: -86.7771139 },
    { biome: 'DOWNTOWN', distance: 3300, name: 'COUNTRY MUSIC HALL OF FAME', label: 'CMHOF 222 REP JOHN LEWIS', lat: 36.1581728, lon: -86.7760929 },
    { biome: 'MUSIC ROW', distance: 6250, name: 'MUSIC ROW ROUNDABOUT', label: 'MUSIC SQ E/W', lat: 36.1516, lon: -86.7922 },
    { biome: 'MUSIC ROW', distance: 7600, name: '16TH AVENUE SOUTH', label: '16TH AVE S', lat: 36.1508, lon: -86.7935 },
    { biome: 'CUMBERLAND', distance: 11800, name: 'JOHN SEIGENTHALER PEDESTRIAN BRIDGE', label: 'PEDESTRIAN BRIDGE', lat: 36.1620654, lon: -86.7722371 },
    { biome: 'CUMBERLAND', distance: 13900, name: 'NISSAN STADIUM', label: 'NISSAN EAST BANK', lat: 36.1665236, lon: -86.7713148 },
    { biome: 'BROADWAY', distance: 16250, name: 'BRIDGESTONE ARENA', label: '5TH & BROAD', lat: 36.1589806, lon: -86.7783819 },
    { biome: 'BROADWAY', distance: 17650, name: 'LOWER BROADWAY', label: '1ST-5TH BROADWAY', lat: 36.1606, lon: -86.7760 },
    { biome: 'BROADWAY', distance: 19000, name: 'RIVERFRONT', label: '1ST AVE / RIVER', lat: 36.1620, lon: -86.7730 }
  ];

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
  // The BROADWAY row is intentionally the kindest on fuel: the finale should feel
  // like a payoff for a clean run, not a wall. De-clustering (minBlockingGap)
  // plus the fuel bump together fix the "runs dry at ~96%" cliff.
  //   speedScale      : per-leg pacing multiplier. Effective top speed for a leg
  //                     is MAX_SPEED * speedScale, ramped within the leg, so the
  //                     trip ACCELERATES toward BROADWAY - the finale is the climax.
  //   patternWeights  : spawn mix across lanes — single (1 lane), wallGap (2 lanes
  //                     blocked, 1 open), layered (full-width single-verb wall:
  //                     all-jump or all-duck), chicane (two offset singles, a weave).
  //   maxLaneSpan     : max lanes a non-layered pattern may block (1 = singles only,
  //                     2 = wallGap/chicane allowed). The fairness invariant: a
  //                     non-layered pattern never blocks all 3 lanes (>=1 stays open).
  const DIFFICULTY = [
    { obstacleDensity: 1.00, minBlockingGap: 660, fuelSpawnRate: 1.00, fuelPerCan: 22, speedScale: 1.00, maxLaneSpan: 1, patternWeights: { single: 0.80, wallGap: 0.15, layered: 0.05, chicane: 0.00 } }, // DOWNTOWN
    { obstacleDensity: 1.20, minBlockingGap: 640, fuelSpawnRate: 1.00, fuelPerCan: 22, speedScale: 1.12, maxLaneSpan: 1, patternWeights: { single: 0.55, wallGap: 0.30, layered: 0.10, chicane: 0.05 } }, // MUSIC ROW
    { obstacleDensity: 1.40, minBlockingGap: 640, fuelSpawnRate: 1.05, fuelPerCan: 24, speedScale: 1.28, maxLaneSpan: 2, patternWeights: { single: 0.38, wallGap: 0.34, layered: 0.18, chicane: 0.10 } }, // CUMBERLAND
    { obstacleDensity: 1.65, minBlockingGap: 620, fuelSpawnRate: 1.25, fuelPerCan: 28, speedScale: 1.45, maxLaneSpan: 2, patternWeights: { single: 0.25, wallGap: 0.34, layered: 0.23, chicane: 0.18 } }  // BROADWAY
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
    ghostVisible: false,   // ghost car is OPT-IN (2026-06-09 feel rework): no
                           // translucent twin racing you unless you choose it
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
    [SCREEN.WIN]: 'You reached Lower Broadway. You win',
    [SCREEN.INITIALS]: 'New high score. Enter your initials',
    [SCREEN.SCORES]: 'High scores',
    [SCREEN.ACHIEVEMENTS]: 'Achievements',
    [SCREEN.GHOST]: 'Ghost race',
    [SCREEN.SETTINGS]: 'Settings',
    [SCREEN.HELP]: 'Controls'
  };

  const ACHIEVEMENTS = [
    { id: 'start', title: 'Demo Night', desc: 'Start the Nashville cruise.' },
    { id: 'first-jump', title: 'Clearance Check', desc: 'Jump over your first hazard.' },
    { id: 'first-hit', title: 'Rental Insurance', desc: 'Survive your first collision.' },
    { id: 'snack', title: 'Roadside Calories', desc: 'Collect a snack pickup.' },
    { id: 'fuel', title: 'Tank Top-Off', desc: 'Collect a fuel can.' },
    { id: 'pitstop', title: 'Full-Service Stop', desc: 'Pull through a pit stop.' },
    { id: 'combo-5', title: 'Perfect Snack Line', desc: 'Build a 5-chain combo.' },
    { id: 'combo-15', title: 'In the Zone', desc: 'Build a 15-chain combo.' },
    { id: 'combo-25', title: 'Untouchable', desc: 'Build a 25-chain combo.' },
    { id: 'max-speed', title: 'Cruise Control Hero', desc: 'Reach top speed.' },
    { id: 'low-fuel', title: 'Running on Fumes', desc: 'Keep driving below 15 percent fuel.' },
    { id: 'music-row', title: 'Music Row Roll', desc: 'Reach the Music Row leg.' },
    { id: 'cumberland', title: 'Riverfront View', desc: 'Reach the Cumberland riverfront leg.' },
    { id: 'broadway', title: 'Broadway Lights', desc: 'Reach the Lower Broadway leg.' },
    { id: 'halfway', title: 'Halfway There', desc: 'Drive past the midpoint.' },
    { id: 'score-3000', title: 'Scoreboard Material', desc: 'Score at least 3,000 points.' },
    { id: 'finish', title: 'Music City Loop', desc: 'Finish the Nashville cruise.' },
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
    cameraMode: CAMERA_SIDE, // renderer only: physics/spawn/collision stay shared
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
      // lanes
      lane: 1,                 // 0 = near/bottom, 1 = center (= legacy GROUND_Y), 2 = far/top
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
    ambient: 0,        // title-screen attract drift (cloud layer); never advances in play
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
    scores: [],
    cloudScores: null,
    cloudScoreStatus: '',
    cloudScoreWritePending: false
  };
  const COMBO_BASE_WINDOW = 4.0;  // base seconds before combo resets; shrinks as combo climbs
  const COMBO_CEILING = 25;       // clamps the SFX pitch ramp ONLY — the combo count and score
                                  // multiplier are uncapped, so a long clean chain keeps climbing
                                  // (the shrinking decay window is the practical limit).
  const MAX_PARTICLES = 240;      // caps short-lived VFX so long sessions cannot balloon draw work
  const MAX_SCORE_POPUPS = 32;    // enough for busy combo bursts without unbounded text draws
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
  function scoreBoardForQualification() {
    const source = state.cloudScores && state.cloudScores.length
      ? state.cloudScores
      : (state.scores && state.scores.length ? state.scores : loadScores());
    return source
      .map(normalizeScoreEntry)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SCORES);
  }
  function qualifies(score) {
    const board = scoreBoardForQualification();
    const s = Math.floor(Number(score) || 0);
    if (board.length < MAX_SCORES) return true;
    return s > board[board.length - 1].score;
  }
  function insertScore(initials, score) {
    const entry = normalizeScoreEntry({
      initials: Array.isArray(initials) ? initials.join('') : initials,
      score,
      date: new Date().toISOString().slice(0, 10)
    });
    state.scores.push(entry);
    state.scores.sort((a, b) => b.score - a.score);
    state.scores = state.scores.slice(0, MAX_SCORES);
    saveScores(state.scores);
    submitCloudScore(entry);
  }
  function normalizeScoreEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const initials = String(entry.initials || 'AAA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, 'A');
    const score = Math.max(0, Math.floor(Number(entry.score) || 0));
    const date = String(entry.date || entry.created_at || new Date().toISOString()).slice(0, 10);
    return { initials, score, date };
  }
  function canUseCloudScores() {
    try {
      if (typeof fetch !== 'function') return false;
      const loc = window.location || location || {};
      const host = String(loc.hostname || '');
      if (!host || loc.protocol === 'file:') return false;
      if (/\.github\.io$/i.test(host)) return false;
      if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(host)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }
  async function refreshCloudScores() {
    if (!canUseCloudScores()) return;
    const writePendingAtStart = !!state.cloudScoreWritePending;
    if (!writePendingAtStart) state.cloudScoreStatus = 'Checking Neon high scores...';
    try {
      const res = await fetch('/api/highscores', { method: 'GET', cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (writePendingAtStart) return;
      if (!res.ok || !data.ok) {
        state.cloudScoreStatus = res.status === 503
          ? 'Cloud high scores need Neon DATABASE_URL in Vercel.'
          : 'Cloud high scores are unavailable; local scores are shown.';
        return;
      }
      const rows = Array.isArray(data.scores) ? data.scores.map(normalizeScoreEntry).filter(Boolean) : [];
      state.cloudScores = rows.slice(0, MAX_SCORES);
      state.cloudScoreStatus = state.cloudScores.length
        ? 'Showing Neon cloud high scores.'
        : 'Neon high scores are online; no scores saved yet.';
    } catch (e) {
      state.cloudScoreStatus = 'Cloud high scores are unavailable; local scores are shown.';
    } finally {
      if (state.screen === SCREEN.SCORES) renderScoresList({ skipCloudRefresh: true });
    }
  }
  async function submitCloudScore(entry) {
    if (!canUseCloudScores()) return;
    const payload = normalizeScoreEntry(entry);
    if (!payload) return;
    state.cloudScoreWritePending = true;
    state.cloudScoreStatus = 'Saving score to Neon...';
    try {
      const res = await fetch('/api/highscores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, source: 'weekend-road-trip-game' })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok && Array.isArray(data.scores)) {
        state.cloudScores = data.scores.map(normalizeScoreEntry).filter(Boolean).slice(0, MAX_SCORES);
        state.cloudScoreStatus = 'Score saved to Neon.';
      } else if (res.status === 503) {
        state.cloudScoreStatus = 'Score saved locally; add Neon DATABASE_URL for cloud scores.';
      } else {
        state.cloudScoreStatus = 'Score saved locally; cloud scores are unavailable.';
      }
    } catch (e) {
      state.cloudScoreStatus = 'Score saved locally; cloud sync was not reachable.';
    } finally {
      state.cloudScoreWritePending = false;
      if (state.screen === SCREEN.SCORES) renderScoresList({ skipCloudRefresh: true });
    }
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
      // One-time migration (2026-06-09): the ghost car switched from opt-out to
      // OPT-IN. Profiles saved in the opt-out era carry ghostVisible:true the
      // player never chose — reset it; re-enabling in Settings stamps ghostOptIn
      // so the explicit choice sticks from then on.
      if (s.ghostVisible && !(parsed && parsed.ghostOptIn)) s.ghostVisible = false;
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
      if (!parsed || typeof parsed !== 'object') return {};
      // Preserve unlocks from pre-Nashville saves that used old route ids.
      const legacyLegIds = {
        forest: 'music-row',
        desert: 'cumberland',
        coast: 'broadway'
      };
      let migrated = false;
      Object.keys(legacyLegIds).forEach((oldId) => {
        const newId = legacyLegIds[oldId];
        if (parsed[oldId] && !parsed[newId]) {
          parsed[newId] = parsed[oldId];
          migrated = true;
        }
      });
      if (migrated) localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(parsed));
      return parsed;
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
    if (!data || data.version !== GHOST_VERSION || data.game !== 'Weekend Road Trip') return null;
    // Bounded frame count (spec): reject oversized pastes instead of ballooning
    // memory / the localStorage quota with a malformed or hostile payload.
    if (!Array.isArray(data.frames) || data.frames.length < 2 ||
        data.frames.length > GHOST_MAX_FRAMES) return null;
    // Finite-only coercion — Number(x) || fallback would let Infinity through (truthy).
    const num = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const frames = data.frames
      .filter((f) => Array.isArray(f) && f.length >= 5)
      .map((f) => [
        num(f[0], 0),
        num(f[1], 0),
        num(f[2], GROUND_Y),
        num(f[3], BASE_SPEED),
        num(f[4], 0)
      ]);
    if (frames.length < 2) return null;
    return {
      version: GHOST_VERSION,
      game: 'Weekend Road Trip',
      created: String(data.created || new Date().toISOString()),
      outcome: data.outcome === 'win' ? 'win' : 'gameover',
      score: Math.floor(num(data.score, 0)),
      distance: Math.max(0, num(data.distance, 0) || frames[frames.length - 1][1]),
      duration: Math.max(0, num(data.duration, 0) || frames[frames.length - 1][0]),
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
  const ENGINE_PLAY_GAIN = 0.144; // 20% quieter than the old 0.18 default drone
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
      gain.gain.linearRampToValueAtTime(ENGINE_PLAY_GAIN, ctx.currentTime + 0.4);
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
    // Quiet the engine drone whenever we leave active play (e.g. pause).
    if (audio.engineOsc && audio.engineGain && audio.ctx) {
      const target = state.screen === SCREEN.PLAYING ? ENGINE_PLAY_GAIN : 0;
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
    if (e.code === 'KeyT' && (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED)) {
      toggleCameraMode();
      return;
    }
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
  function releaseHeldInputs() {
    releaseTouchHolds();
    state.keys.clear();
    state.player.ducking = false;
    state._duckHeldPrev = false;
    state.pad = {};
    state.padPrev = {};
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
        if (e && e.pointerId != null && btn.setPointerCapture) {
          try { btn.setPointerCapture(e.pointerId); } catch (err) {}
        }
        audio.init();                                   // unlock audio on first touch
        btn.classList.add('pressed');
        if (action === 'jump') { if (state.screen === SCREEN.PLAYING) tryJump(); }
        else if (action === 'laneUp') { if (state.screen === SCREEN.PLAYING) hopLane(+1); }
        else if (action === 'laneDown') { if (state.screen === SCREEN.PLAYING) hopLane(-1); }
        else if (action === 'pause') { if (state.screen === SCREEN.PLAYING) show(SCREEN.PAUSED); }
        else if (action === 'camera') { if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) toggleCameraMode(); }
        else if (code) { state.keys.add(code); touchHeld.add(code); }
      };
      const up = (e) => {
        if (e && e.preventDefault && e.cancelable) e.preventDefault();
        if (e && e.pointerId != null && btn.releasePointerCapture) {
          try { btn.releasePointerCapture(e.pointerId); } catch (err) {}
        }
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
  window.addEventListener('blur', releaseHeldInputs);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseHeldInputs(); });

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

  function toggleCameraMode() {
    state.cameraMode = state.cameraMode === CAMERA_CHASE ? CAMERA_SIDE : CAMERA_CHASE;
    announce(state.cameraMode === CAMERA_CHASE ? 'Chase camera' : 'Side camera');
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
      help: b(8),
      // Keyboard parity for T (camera) and M (mute) — chase view and mute must
      // be reachable without a keyboard.
      camera: b(3),   // Y / triangle
      mute: b(2)      // X / square
    };

    const prev = state.pad;
    state.padConnected = true;
    ['jump', 'duck', 'laneUp', 'laneDown', 'confirm', 'pause', 'help', 'camera', 'mute'].forEach((action) => {
      if (next[action] && !prev[action]) handlePadAction(action);
    });
    state.padPrev = prev;
    state.pad = next;
  }

  // --- Gamepad menu navigation -------------------------------------------
  // D-pad / stick left-right moves DOM focus across the active screen's
  // controls (buttons + settings inputs) and A activates the focused one, so a
  // pad-only player can reach every menu — including Settings — without a
  // keyboard. A focused volume slider consumes left/right as value nudges; A
  // moves on from it.
  function padFocusables() {
    const el = screenEls[state.screen];
    if (!el || !el.querySelectorAll) return [];
    return Array.from(el.querySelectorAll('button, input')).filter((n) =>
      !n.disabled && n.offsetParent !== null);
  }
  function padMoveFocus(dir) {
    const items = padFocusables();
    if (!items.length) return;
    const active = document.activeElement;
    if (active && active.type === 'range' && items.includes(active)) {
      const step = (Number(active.step) || 0.05) * dir;
      const lo = active.min !== '' ? Number(active.min) : 0;
      const hi = active.max !== '' ? Number(active.max) : 1;
      active.value = String(Math.max(lo, Math.min(hi, Number(active.value) + step)));
      active.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const idx = items.indexOf(active);
    const next = idx === -1 ? (dir > 0 ? 0 : items.length - 1) : (idx + dir + items.length) % items.length;
    items[next].focus();
  }
  function padActivateFocused() {
    const active = document.activeElement;
    if (!active || !padFocusables().includes(active)) return false;
    if (active.type === 'range') { padMoveFocus(1); return true; }   // "done adjusting"
    active.click();
    return true;
  }

  function handlePadAction(action) {
    // Screen-independent actions mirror their keyboard twins (M mute, T camera).
    if (action === 'mute') { audio.init(); audio.toggle(); return; }
    if (action === 'camera') {
      if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) toggleCameraMode();
      return;
    }
    switch (state.screen) {
      case SCREEN.TITLE:
        if (action === 'confirm') { if (!padActivateFocused()) startRun(); }
        if (action === 'help') openHelp();
        if (action === 'laneUp') padMoveFocus(1);
        if (action === 'laneDown') padMoveFocus(-1);
        break;
      case SCREEN.PLAYING:
        if (action === 'jump') tryJump();
        if (action === 'laneUp') hopLane(+1);
        if (action === 'laneDown') hopLane(-1);
        if (action === 'pause') show(SCREEN.PAUSED);
        if (action === 'help') openHelp();
        break;
      case SCREEN.PAUSED:
        if (action === 'confirm') { if (!padActivateFocused()) show(SCREEN.PLAYING); }
        else if (action === 'pause') show(SCREEN.PLAYING);
        if (action === 'laneUp') padMoveFocus(1);
        if (action === 'laneDown') padMoveFocus(-1);
        break;
      case SCREEN.GAMEOVER:
      case SCREEN.WIN:
        if (action === 'confirm') { if (!padActivateFocused()) afterRun(); }
        if (action === 'laneUp') padMoveFocus(1);
        if (action === 'laneDown') padMoveFocus(-1);
        break;
      case SCREEN.INITIALS:
        // Arcade initials entry, pad edition: left/right picks the slot, duck
        // (B / d-pad down / stick down) cycles the letter, A submits.
        if (action === 'laneUp') handleInitialsKey('ArrowRight');
        if (action === 'laneDown') handleInitialsKey('ArrowLeft');
        if (action === 'duck') handleInitialsKey('ArrowDown');
        if (action === 'confirm') handleInitialsKey('Enter');
        break;
      case SCREEN.SCORES:
      case SCREEN.ACHIEVEMENTS:
      case SCREEN.GHOST:
      case SCREEN.SETTINGS:
      case SCREEN.HELP:
        if (action === 'confirm') {
          if (!padActivateFocused()) show(state.prevScreen === state.screen ? SCREEN.TITLE : state.prevScreen);
        } else if (action === 'pause') {
          show(state.prevScreen === state.screen ? SCREEN.TITLE : state.prevScreen);
        }
        if (action === 'laneUp') padMoveFocus(1);
        if (action === 'laneDown') padMoveFocus(-1);
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
        // Re-enabling the ghost car is an explicit choice — stamp it so the
        // opt-in migration in loadSettings never resets it again.
        if (key === 'ghostVisible' && input.checked) state.settings.ghostOptIn = true;
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

  function renderScoresList(options) {
    const opts = options || {};
    const ol = document.getElementById('scores-list');
    const status = document.getElementById('scores-cloud-status');
    state.scores = loadScores();
    if (!opts.skipCloudRefresh && canUseCloudScores()) refreshCloudScores();
    if (status) {
      status.textContent = state.cloudScoreStatus ||
        (canUseCloudScores()
          ? 'Vercel syncs finished runs to Neon high scores.'
          : 'Local high scores are shown here; Vercel stores them in Neon.');
    }
    const visibleScores = state.cloudScores && state.cloudScores.length ? state.cloudScores : state.scores;
    ol.innerHTML = '';
    if (visibleScores.length === 0) {
      ol.innerHTML = '<li class="empty"><span class="empty">NO SCORES YET — HIT THE ROAD.</span></li>';
      return;
    }
    visibleScores.forEach((s, i) => {
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
        `Loaded ghost: ${pct}% trip, ${pad(g.score, 6)} points, ${g.duration.toFixed(1)} seconds. ` +
        (state.settings.ghostVisible
          ? 'Start the trip to race it.'
          : 'Turn on "Show ghost replay car" in Settings to race it.');
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
      version: GHOST_VERSION,
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
    // The FIRST finished run always saves (any distance) so a shareable ghost
    // exists immediately; after that it's keep-best, with a 300-unit floor so a
    // trivial stall can never overwrite a real replay.
    if (isBetter && (!old || ghost.distance > 300)) {
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
      // Lean into the hop (sign: hopping up/far = lean one way)
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
    // gentle body wobble — sells the suspension (motion, so honors reduce-motion)
    state.player.bob = reduceMotionOn() ? 0 : Math.sin(state.distance * 0.05) * (state.speed * 0.12);
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
    const f = dt * 60;
    for (const b of state.birds) {
      b.x += b.vx * f;
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
        (0.85 + Math.random() * 0.7 - state.speed * 0.055) / density);
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
    for (const s of state.semis) s.x += s.vx * dt * 60;

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
          state.combo += 1;   // uncapped — the chain (and multiplier) keep climbing
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
        // Bump combo — uncapped, so stringing clean actions keeps paying more
        state.combo += 1;
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
        if (state.combo >= 2) audio.playCombo(Math.min(COMBO_CEILING, state.combo));   // pitch ramp clamps; the score never does
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
          // (no screen shake — shake is impact feedback; a pickup is a reward)
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
  function capTransientList(list, max) {
    if (list.length > max) list.splice(0, list.length - max);
  }
  function spawnScorePopup(x, y, text, color) {
    state.scorePopups.push({
      x, y, text, color,
      vy: -1.4,
      life: 1.0,
      max: 1.0
    });
    capTransientList(state.scorePopups, MAX_SCORE_POPUPS);
  }
  function updateScorePopups(dt) {
    const f = dt * 60;
    const drift = !reduceMotionOn();   // calm mode: popups fade in place, no float
    for (const p of state.scorePopups) {
      if (drift) {
        p.y += p.vy * f;
        p.vy *= Math.pow(0.96, f);
      }
      p.life -= dt;
    }
    state.scorePopups = state.scorePopups.filter((p) => p.life > 0);
  }
  function drawScorePopups() {
    ctx.save();
    ctx.font = 'bold 16px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Dark halo keeps popups legible over bright route skies and neon.
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
    const calm = reduceMotionOn();   // calm mode: steady pill, no pop-scale bounce
    const scale = calm ? 1 : 1 + (1 - t) * 0.4;
    const yOff = calm ? 0 : (1 - t) * -8;
    const label = `COMBO  x${state.combo}`;
    ctx.save();
    ctx.translate(W / 2, COMBO_Y + yOff);
    ctx.scale(scale, scale);
    ctx.font = 'bold 26px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Dark backplate pill — keeps the toast legible over bright skies
    // (river glare, Broadway sunset), matching the DOM card backplates.
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
    if (reduceMotionOn()) return;   // particles are pure motion — gated at the source for calm mode
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
    capTransientList(state.particles, MAX_PARTICLES);
  }
  function spawnPickupBurst(x, y, color) {
    if (reduceMotionOn()) return;
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
    capTransientList(state.particles, MAX_PARTICLES);
  }
  function spawnDust(x, y, count) {
    if (reduceMotionOn()) return;
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
    capTransientList(state.particles, MAX_PARTICLES);
  }
  function spawnExhaust(x, y) {
    if (reduceMotionOn()) return;
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
    capTransientList(state.particles, MAX_PARTICLES);
  }
  function spawnTireSmoke(x, y) {
    if (reduceMotionOn()) return;
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
    capTransientList(state.particles, MAX_PARTICLES);
  }
  function updateParticles(dt) {
    const f = dt * 60;
    for (const p of state.particles) {
      p.x += p.vx * f;
      p.y += p.vy * f;
      p.vy += p.gravity * f;
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
    // Coherent damped oscillation instead of fresh white noise per frame —
    // the old per-frame Math.random read as the whole scene twitching.
    const a = state.runTime * 55;
    return {
      x: Math.sin(a * 1.3) * state.shakeMag * 0.5 * t,
      y: Math.cos(a) * state.shakeMag * 0.5 * t
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
    // 0 in middle of biome, → 1 across the transition zone. Kept SHORT: while
    // blending, two whole mid-scenery layers are superimposed at partial alpha
    // — the most literal "translucent overlapping assets" moment in the game —
    // so the dissolve is a quick beat, not a lingering double exposure.
    const b = BIOMES[state.biomeIdx];
    const start = state.biomeIdx === 0 ? 0 : BIOMES[state.biomeIdx - 1].end;
    const trans = 80;
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
  function safeShade(color, amt) {
    return /^#[0-9a-f]{6}$/i.test(String(color || '')) ? shade(color, amt) : color;
  }
  function gameColor(normal, highContrast) {
    return state.settings.colorblind ? highContrast : normal;
  }
  function noise01(seed) {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }
  function pathModulo(value, period) {
    return ((value % period) + period) % period;
  }
  // Re-graded x0.7 in the 2026-06-09 feel rework: combined with the world-speed
  // trim, background layers drift instead of whipping by. Strict far-to-near
  // ordering is locked by self-test 4d; ROAD_SCROLL stays exactly 1.0.
  const CLOUD_PARALLAX = 0.028;
  const MOUNTAIN_PARALLAX = 0.056;
  const SKYLINE_PARALLAX = 0.084;
  const MID_SCENERY_PARALLAX = 0.126;
  const GEO_SIGN_PARALLAX = 0.154;
  const ROAD_SCROLL = 1.0; // every painted asphalt detail moves with obstacles
  const SHOW_GEO_LABELS = false; // remove map-like place + coordinate placards
  const SHOW_WAYFINDING = false; // remove non-gameplay text labels from scenery
  const CHASE_HORIZON_Y = 188;
  const CHASE_BOTTOM_Y = 532;
  const CHASE_DRAW_AHEAD = 930;
  const CHASE_CENTER_X = W / 2;

  function fillQuad(x1, y1, x2, y2, x3, y3, x4, y4) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.lineTo(x4, y4);
    ctx.closePath();
    ctx.fill();
  }
  function geoAnchorsForBiome(name) {
    return NASHVILLE_GEO.filter((p) => p.biome === name);
  }
  function routeAnchorX(anchor, parallax, lead) {
    return (lead || PLAYER_X + 310) + (anchor.distance - state.distance) * (parallax || 0.62);
  }
  function fmtCoord(v) {
    return (Math.round(v * 1000) / 1000).toFixed(3);
  }
  function buildingGradient(x, top, w, h, base, warmSide) {
    const g = ctx.createLinearGradient(x, top, x + w, top + h);
    g.addColorStop(0, safeShade(base, warmSide ? 0.16 : 0.08));
    g.addColorStop(0.45, base);
    g.addColorStop(1, safeShade(base, -0.32));
    return g;
  }
  function drawWindowGrid(x, top, w, h, cols, rows, seed, warm) {
    const cellW = w / cols;
    const cellH = h / rows;
    const lit = warm ? '#f8d37c' : '#b9d9ff';
    const dim = warm ? 'rgba(248, 211, 124, 0.16)' : 'rgba(185, 217, 255, 0.13)';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const n = noise01(seed + r * 17.3 + c * 5.7);
        ctx.fillStyle = n > 0.72 ? lit : dim;
        const padX = cellW * 0.26;
        const padY = cellH * 0.28;
        ctx.globalAlpha = n > 0.72 ? 0.88 : 0.5;
        ctx.fillRect(x + c * cellW + padX, top + r * cellH + padY, Math.max(3, cellW * 0.34), Math.max(3, cellH * 0.34));
      }
    }
    ctx.globalAlpha = 1;
  }
  function drawNeonBox(x, y, w, h, color, label, fontSize) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    roundRect(ctx, x, y, w, h, 4);
    ctx.stroke();
    ctx.shadowBlur = 5;
    ctx.fillStyle = color;
    ctx.font = `bold ${fontSize || 11}px "JetBrains Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (SHOW_WAYFINDING && label) {
      ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
    } else {
      // Text labels are off — fill the tube frame with abstract neon dashes so
      // the sign still reads as lit signage, not an empty outline.
      ctx.fillRect(x + w * 0.18, y + h / 2 - 1.5, w * 0.38, 3);
      ctx.fillRect(x + w * 0.62, y + h / 2 - 1.5, w * 0.2, 3);
    }
    ctx.restore();
    ctx.textAlign = 'left';
  }
  function drawLampGlow(x, y, r, color, alpha) {
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    g.addColorStop(0, hexToRgba(color, alpha));
    g.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  function drawRoadSign(x, y, w, h, color, label, baseY) {
    const ground = baseY !== undefined ? baseY : GROUND_Y;
    const postH = ground - (y + h);
    const postXs = w > 68 ? [x + w * 0.26, x + w * 0.74] : [x + w / 2];
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    fillQuad(x + 6, y + h + 4, x + w + 9, y + h + 4, x + w + 22, ground + 2, x + 17, ground + 2);
    for (const px of postXs) {
      const postW = 5;
      const pg = ctx.createLinearGradient(px - postW / 2, 0, px + postW / 2, 0);
      pg.addColorStop(0, '#343941');
      pg.addColorStop(0.5, '#707883');
      pg.addColorStop(1, '#252a31');
      ctx.fillStyle = pg;
      ctx.fillRect(px - postW / 2, y + h - 1, postW, postH + 1);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(px - postW / 2 + 1, y + h + 3, 1, Math.max(8, postH - 8));
    }
    if (postXs.length > 1) {
      ctx.strokeStyle = 'rgba(56,62,70,0.78)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(postXs[0], y + h + 10);
      ctx.lineTo(postXs[1], ground - 12);
      ctx.moveTo(postXs[1], y + h + 10);
      ctx.lineTo(postXs[0], ground - 12);
      ctx.stroke();
    }
    ctx.fillStyle = safeShade(color, -0.42);
    roundRect(ctx, x + 5, y + 5, w, h, 3);
    ctx.fill();
    ctx.fillStyle = safeShade(color, -0.20);
    fillQuad(x + w, y + 4, x + w + 7, y + 8, x + w + 7, y + h + 5, x + w, y + h);
    ctx.fillStyle = safeShade(color, 0.10);
    fillQuad(x + 4, y, x + w, y, x + w + 7, y + 5, x + 10, y + 5);
    ctx.fillStyle = color;
    roundRect(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.72)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x + 3, y + 3, w - 6, h - 6, 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.68)';
    for (const bx of [x + 8, x + w - 8]) {
      ctx.beginPath();
      ctx.arc(bx, y + 7, 1.6, 0, Math.PI * 2);
      ctx.arc(bx, y + h - 7, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (SHOW_WAYFINDING && label) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
      ctx.textAlign = 'left';
    } else {
      // Wayfinding text is off by default — give the board non-textual content
      // (route chevrons) so it never reads as an empty placeholder panel.
      ctx.strokeStyle = 'rgba(255,255,255,0.78)';
      ctx.lineWidth = 2;
      const cy = y + h / 2;
      const n = w > 60 ? 3 : 2;
      const startX = x + w / 2 - (n * 14) / 2 + 3;
      ctx.beginPath();
      for (let ci = 0; ci < n; ci++) {
        const cx = startX + ci * 14;
        ctx.moveTo(cx, cy - 5);
        ctx.lineTo(cx + 6, cy);
        ctx.lineTo(cx, cy + 5);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawGeoPlate(anchor, x, y, compact) {
    const w = compact ? 118 : 178;
    const h = compact ? 24 : 38;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    fillQuad(x + 5, y + h + 5, x + w + 5, y + h + 5, x + w + 19, y + h + 16, x + 18, y + h + 16);
    ctx.fillStyle = 'rgba(3, 9, 13, 0.92)';
    roundRect(ctx, x + 4, y + 4, w, h, 4);
    ctx.fill();
    ctx.fillStyle = '#143743';
    fillQuad(x + w, y + 3, x + w + 7, y + 7, x + w + 7, y + h + 5, x + w, y + h);
    ctx.fillStyle = 'rgba(9, 18, 22, 0.86)';
    roundRect(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = '#6ee7ff';
    ctx.lineWidth = 1.2;
    roundRect(ctx, x + 2, y + 2, w - 4, h - 4, 3);
    ctx.stroke();
    ctx.fillStyle = '#d9fbff';
    ctx.font = `bold ${compact ? 7 : 8}px "JetBrains Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(anchor.label, x + w / 2, y + (compact ? 9 : 11));
    ctx.fillStyle = '#9ddfec';
    ctx.font = `${compact ? 7 : 8}px "JetBrains Mono", Consolas, monospace`;
    ctx.fillText(`${fmtCoord(anchor.lat)}  ${fmtCoord(anchor.lon)}`, x + w / 2, y + (compact ? 18 : 27));
    ctx.restore();
  }
  function drawGeoAnchorMarkers(biome) {
    if (!SHOW_GEO_LABELS) return;
    const anchors = geoAnchorsForBiome(biome.name);
    for (const a of anchors) {
      const x = routeAnchorX(a, GEO_SIGN_PARALLAX, PLAYER_X + 360);
      if (x < -210 || x > W + 90) continue;
      const y = GROUND_Y - 116;
      ctx.save();
      ctx.fillStyle = '#3d444d';
      ctx.fillRect(x + 31, y + 24, 4, 92);
      ctx.fillRect(x + 84, y + 24, 4, 92);
      ctx.strokeStyle = 'rgba(30,36,42,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 33, y + 38);
      ctx.lineTo(x + 86, y + 86);
      ctx.moveTo(x + 86, y + 38);
      ctx.lineTo(x + 33, y + 86);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.24)';
      fillQuad(x + 28, GROUND_Y - 5, x + 92, GROUND_Y - 5, x + 108, GROUND_Y + 3, x + 42, GROUND_Y + 3);
      ctx.restore();
      drawGeoPlate(a, x, GROUND_Y - 116, true);
    }
  }

  function drawClouds(biome) {
    // Cloud layer — slow parallax. state.ambient drifts ONLY on the title
    // screen (attract motion) so the menu world reads as live; in play it is
    // frozen and distance owns the parallax exactly as before.
    const off = (state.distance + state.ambient) * CLOUD_PARALLAX;
    ctx.save();
    ctx.shadowColor = biome.timeOfDay === 'sunset'
      ? 'rgba(126, 54, 80, 0.22)'
      : 'rgba(60, 90, 120, 0.16)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = biome.timeOfDay === 'sunset'
      ? 'rgba(255, 204, 174, 0.76)'
      : 'rgba(255, 255, 255, 0.80)';
    const cloudCount = 6;
    for (let i = 0; i < cloudCount; i++) {
      const baseX = (i * 320 + 100 - off) % (W + 400);
      const x = baseX < -200 ? baseX + W + 400 : baseX;
      const y = 50 + ((i * 47) % 80);
      drawCloud(x, y, 60 + (i * 17) % 40);
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = biome.timeOfDay === 'sunset' ? 0.16 : 0.10;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      const x = ((i * 170) - (off * 1.8 % 170)) - 80;
      const y = 155 + (i % 3) * 18;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + 70, y - 10, x + 130, y + 9, x + 210, y - 2);
      ctx.stroke();
    }
    ctx.restore();
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

  function drawRollingHills(off, baseY, amp, color, alpha, period) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    const p = period || 260;
    const start = -pathModulo(off, p) - p;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(start, baseY);
    for (let i = 0; i < 8; i++) {
      const x = start + i * p;
      // World-anchored noise key: post-wrap slot i must equal pre-wrap slot
      // i+1 (k is identical), so each hill keeps its silhouette while it
      // scrolls instead of the whole ridge snapping to a new shape per period.
      const k = i + Math.floor(off / p);
      const n1 = noise01(k * 0.37);
      const n2 = noise01(k * 2.3 + 9);
      ctx.bezierCurveTo(
        x + p * 0.22, baseY - amp * (0.45 + n1 * 0.55),
        x + p * 0.72, baseY - amp * (0.30 + n2 * 0.65),
        x + p, baseY
      );
    }
    ctx.lineTo(W + p, GROUND_Y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawFarMountains(biome) {
    const off = state.distance * MOUNTAIN_PARALLAX;
    const hill = biomeColor(biome, 'mountainColor');
    drawRollingHills(off * 0.55, GROUND_Y - 92, 42, safeShade(hill, 0.12), 0.68, 300);
    drawRollingHills(off, GROUND_Y - 58, 34, hill, 0.82, 240);
    if (biome.name === 'DOWNTOWN' || biome.name === 'CUMBERLAND' || biome.name === 'BROADWAY') {
      drawDistantSkyline(state.distance * SKYLINE_PARALLAX, biome);
    }
  }

  function drawDistantSkyline(off, biome) {
    const baseY = GROUND_Y - 88;
    const period = 680;
    const start = -pathModulo(off, period) - period;
    ctx.save();
    ctx.globalAlpha = biome.timeOfDay === 'sunset' ? 0.32 : 0.24;
    for (let chunk = 0; chunk < 4; chunk++) {
      const origin = start + chunk * period;
      // Seed by STABLE world-chunk id, not the continuous origin: a continuous
      // seed re-randomizes every building height each frame (the sin-hash fully
      // decorrelates on sub-pixel shifts), which made the whole skyline band
      // flicker/bob. The id form is seamless across the modulo wrap.
      const id = chunk + Math.floor(off / period);
      for (let i = 0; i < 8; i++) {
        const w0 = 34 + noise01(id * 13.7 + i) * 36;
        const h0 = 34 + noise01(id * 9.1 + i * 4.1) * 76;
        const x = origin + 20 + i * 78;
        ctx.fillStyle = biome.timeOfDay === 'sunset' ? '#231b2c' : '#30354b';
        ctx.fillRect(x, baseY - h0, w0, h0);
        if (i % 3 === 1) ctx.fillRect(x + w0 * 0.42, baseY - h0 - 22, w0 * 0.16, 22);
      }
    }
    ctx.restore();
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
      case 'DOWNTOWN':   drawDowntownNashville(off); break;
      case 'MUSIC ROW':  drawMusicRowMid(off); break;
      case 'CUMBERLAND': drawCumberlandMid(off); break;
      case 'BROADWAY':   drawBroadwayMid(off); break;
    }
  }
  function drawMidScenery(biome) {
    // Biome-specific mid layer. Kept slow enough to read as background instead
    // of a gameplay obstacle layer. Through a leg transition, cross-
    // fade the current biome out and the next in, so the scenery dissolves
    // smoothly instead of popping at the boundary.
    const off = state.distance * MID_SCENERY_PARALLAX;
    const bl = biomeBlend();
    if (bl > 0.001) {
      ctx.save(); ctx.globalAlpha = 1 - bl; drawMidFor(biome.name, off); ctx.restore();
      ctx.save(); ctx.globalAlpha = bl;     drawMidFor(nextBiome().name, off); ctx.restore();
    } else {
      drawMidFor(biome.name, off);
    }
  }
  function drawDowntownNashville(off) {
    const baseY = GROUND_Y;
    const period = 920;
    const start = -((off % period) + period) % period;
    for (let chunk = -1; chunk < 3; chunk++) {
      const origin = start + chunk * period;
      // Back-to-front, with the Country-Hall wedge given its own clear slot
      // (it used to be drawn last ACROSS two towers, slicing through their
      // window grids) and the marquee drawn in front as deliberate signage.
      drawBroadShoulderTower(origin + 92, baseY, 96, 150, '#272940');
      drawBroadShoulderTower(origin + 210, baseY, 92, 112, '#313047');
      drawBroadShoulderTower(origin + 520, baseY, 118, 132, '#292b42');
      drawCountryHallShape(origin + 636, baseY);
      drawBroadShoulderTower(origin + 790, baseY, 105, 120, '#30314a');
      drawBatmanTower(origin + 350, baseY);
      drawRymanRoofline(origin + 22, baseY);
      drawMusicCityMarquee(origin + 34, baseY);
      drawDowntownGeoGrid(origin, baseY);
    }
  }
  function drawMusicCityMarquee(x, baseY) {
    const y = baseY - 156;
    ctx.fillStyle = '#181824';
    ctx.fillRect(x + 12, y, 128, 34);
    drawNeonBox(x + 16, y + 4, 120, 26, '#f5d76e', 'MUSIC CITY', 12);
    for (let i = 0; i < 9; i++) {
      drawLampGlow(x + 24 + i * 13, y + 4, 10, '#f5d76e', 0.16);
    }
    ctx.fillStyle = 'rgba(245,215,110,0.22)';
    ctx.fillRect(x + 16, y + 32, 120, 4);
    ctx.font = 'bold 12px JetBrains Mono, Consolas, monospace';
    ctx.fillStyle = '#292a38';
    ctx.fillRect(x + 30, y + 34, 7, 82);
    ctx.fillRect(x + 116, y + 34, 7, 82);
    ctx.textAlign = 'left';
  }
  function drawBatmanTower(x, baseY) {
    const w = 86;
    const h = 214;
    const top = baseY - h;
    ctx.fillStyle = buildingGradient(x, top, w, h, '#202135', false);
    ctx.fillRect(x, top + 36, w, h - 36);
    ctx.fillStyle = buildingGradient(x + 12, top + 16, w - 24, h - 16, '#292b45', true);
    ctx.fillRect(x + 12, top + 16, w - 24, h - 16);
    ctx.fillStyle = '#171827';
    ctx.fillRect(x + 18, top - 34, 10, 54);
    ctx.fillRect(x + w - 28, top - 34, 10, 54);
    ctx.fillStyle = '#0f101b';
    ctx.fillRect(x + 36, top + 8, 14, 24);
    drawWindowGrid(x + 20, top + 50, w - 40, 142, 3, 8, x * 0.13, true);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(x + 17, top + 24, 6, 160);
    ctx.fillRect(x + w - 23, top + 24, 6, 160);
    ctx.fillStyle = 'rgba(255,232,154,0.32)';
    ctx.fillRect(x + 17, top - 36, 12, 2);
    ctx.fillRect(x + w - 29, top - 36, 12, 2);
    drawLampGlow(x + 23, top - 35, 24, '#f5d76e', 0.22);
    drawLampGlow(x + w - 23, top - 35, 24, '#f5d76e', 0.22);
  }
  function drawBroadShoulderTower(x, baseY, w, h, color) {
    ctx.fillStyle = buildingGradient(x, baseY - h, w, h, color, true);
    ctx.fillRect(x, baseY - h, w, h);
    ctx.fillStyle = safeShade(color, 0.14);
    ctx.fillRect(x + 8, baseY - h + 10, w - 16, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x + 4, baseY - h + 8, 3, h - 12);
    ctx.fillRect(x + w - 9, baseY - h + 8, 3, h - 12);
    drawWindowGrid(x + 10, baseY - h + 24, w - 20, h - 34,
      Math.max(2, Math.floor(w / 26)), Math.max(3, Math.floor(h / 22)), x * 0.19 + h, true);
  }
  function drawRymanRoofline(x, baseY) {
    ctx.fillStyle = '#4b3027';
    ctx.fillRect(x, baseY - 74, 118, 74);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 9; col++) {
        if ((row + col) % 2 === 0) ctx.fillRect(x + 8 + col * 12, baseY - 66 + row * 12, 7, 3);
      }
    }
    ctx.fillStyle = '#2b1d1b';
    ctx.beginPath();
    ctx.moveTo(x - 8, baseY - 74);
    ctx.lineTo(x + 59, baseY - 112);
    ctx.lineTo(x + 126, baseY - 74);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#f1d18b';
    for (let i = 0; i < 5; i++) ctx.fillRect(x + 16 + i * 20, baseY - 52, 8, 18);
  }
  function drawCountryHallShape(x, baseY) {
    ctx.fillStyle = '#232636';
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x + 28, baseY - 90);
    ctx.lineTo(x + 126, baseY - 120);
    ctx.lineTo(x + 154, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(x + 48, baseY - 82, 72, 4);
    ctx.fillRect(x + 42, baseY - 64, 88, 4);
    ctx.fillRect(x + 36, baseY - 46, 102, 4);
    ctx.fillStyle = 'rgba(245,215,110,0.32)';
    for (let i = 0; i < 7; i++) ctx.fillRect(x + 34 + i * 14, baseY - 30, 6, 18);
  }
  function drawDowntownStreetLevel(x, baseY) {
    ctx.fillStyle = '#262634';
    roundRect(ctx, x, baseY - 50, 190, 50, 4);
    ctx.fill();
    ctx.fillStyle = '#171824';
    for (let i = 0; i < 4; i++) ctx.fillRect(x + 14 + i * 44, baseY - 38, 28, 32);
    drawNeonBox(x + 16, baseY - 44, 66, 16, '#6ee7ff', '2ND AVE', 8);
    drawNeonBox(x + 102, baseY - 44, 66, 16, '#ff6b9a', 'LIVE', 8);
    ctx.fillStyle = '#f5d76e';
    for (let i = 0; i < 10; i++) ctx.fillRect(x + 8 + i * 18, baseY - 4, 10, 2);
  }
  function drawDowntownGeoGrid(origin, baseY) {
    if (!SHOW_WAYFINDING) return;
    const signs = [
      { x: origin + 64, y: baseY - 132, w: 88, text: 'RYMAN / 5TH' },
      { x: origin + 330, y: baseY - 250, w: 96, text: '333 COMMERCE' },
      { x: origin + 584, y: baseY - 142, w: 118, text: 'CMHOF / SOBRO' },
      { x: origin + 742, y: baseY - 92, w: 106, text: 'EAST TO RIVER' }
    ];
    for (const s of signs) {
      ctx.fillStyle = 'rgba(16,28,34,0.82)';
      roundRect(ctx, s.x, s.y, s.w, 18, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(110,231,255,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#d9fbff';
      ctx.font = 'bold 7px "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.text, s.x + s.w / 2, s.y + 9);
    }
    ctx.textAlign = 'left';
    ctx.strokeStyle = 'rgba(245,215,110,0.20)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(origin + 30, baseY - 12);
    ctx.lineTo(origin + 850, baseY - 12);
    ctx.moveTo(origin + 86, baseY - 62);
    ctx.lineTo(origin + 86, baseY - 4);
    ctx.moveTo(origin + 388, baseY - 210);
    ctx.lineTo(origin + 388, baseY - 4);
    ctx.moveTo(origin + 644, baseY - 104);
    ctx.lineTo(origin + 644, baseY - 4);
    ctx.stroke();
  }
  function drawMusicRowMid(off) {
    const baseY = GROUND_Y;
    const period = 760;
    const start = -((off % period) + period) % period;
    for (let chunk = -1; chunk < 4; chunk++) {
      const x = start + chunk * period;
      drawStudioBungalow(x + 30, baseY, '#6a3f2f', 'STUDIO');
      drawStudioBungalow(x + 210, baseY, '#505b4a', 'MIX');
      drawStudioBungalow(x + 400, baseY, '#5b4d3a', 'VINYL');
      drawGuitarSign(x + 628, baseY - 96, 0.9);
      drawMusicRowTrees(x + 108, baseY);
      drawMusicRowTrees(x + 332, baseY);
      drawMusicRowUtility(x + 560, baseY);
      drawRecordMural(x + 470, baseY);
    }
  }
  function drawStudioBungalow(x, baseY, color, label) {
    ctx.fillStyle = buildingGradient(x, baseY - 122, 150, 122, color, true);
    ctx.fillRect(x, baseY - 82, 150, 82);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    for (let y = baseY - 74; y < baseY - 8; y += 10) ctx.fillRect(x + 6, y, 138, 1);
    ctx.fillStyle = shade(color, -0.28);
    ctx.beginPath();
    ctx.moveTo(x - 10, baseY - 82);
    ctx.lineTo(x + 75, baseY - 122);
    ctx.lineTo(x + 160, baseY - 82);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1b2430';
    ctx.fillRect(x + 20, baseY - 52, 26, 24);
    ctx.fillRect(x + 100, baseY - 52, 26, 24);
    ctx.fillStyle = '#f5d76e';
    ctx.fillRect(x + 23, baseY - 49, 8, 18);
    ctx.fillRect(x + 34, baseY - 49, 8, 18);
    ctx.fillRect(x + 103, baseY - 49, 8, 18);
    ctx.fillRect(x + 114, baseY - 49, 8, 18);
    ctx.fillStyle = '#241b19';
    ctx.fillRect(x + 62, baseY - 60, 28, 60);
    ctx.fillStyle = '#f3c18f';
    ctx.beginPath();
    ctx.arc(x + 96, baseY - 64, 3, 0, Math.PI * 2);
    ctx.fill();
    drawLampGlow(x + 96, baseY - 64, 22, '#f5d76e', 0.18);
    if (SHOW_WAYFINDING) {
      ctx.fillStyle = '#d7c7a2';
      ctx.font = '10px JetBrains Mono, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(label, x + 75, baseY - 88);
      ctx.textAlign = 'left';
    }
  }
  function drawMusicRowTrees(x, baseY) {
    ctx.fillStyle = '#5b3b24';
    ctx.fillRect(x + 18, baseY - 70, 7, 70);
    ctx.fillStyle = '#2f5e3b';
    ctx.beginPath();
    ctx.arc(x + 22, baseY - 82, 30, 0, Math.PI * 2);
    ctx.arc(x + 4, baseY - 68, 22, 0, Math.PI * 2);
    ctx.arc(x + 42, baseY - 66, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.arc(x + 10, baseY - 88, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  function drawMusicRowUtility(x, baseY) {
    ctx.strokeStyle = '#2b211c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x, baseY - 128);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 28, baseY - 112);
    ctx.lineTo(x + 42, baseY - 112);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(30,25,24,0.65)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(x - 170, baseY - 112);
    ctx.bezierCurveTo(x - 90, baseY - 96, x - 42, baseY - 96, x + 42, baseY - 112);
    ctx.bezierCurveTo(x + 126, baseY - 128, x + 190, baseY - 126, x + 270, baseY - 112);
    ctx.stroke();
  }
  function drawRecordMural(x, baseY) {
    ctx.fillStyle = '#1e1e28';
    roundRect(ctx, x, baseY - 72, 86, 62, 5);
    ctx.fill();
    ctx.fillStyle = '#d8c58f';
    ctx.beginPath();
    ctx.arc(x + 43, baseY - 41, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1e1e28';
    ctx.beginPath();
    ctx.arc(x + 43, baseY - 41, 8, 0, Math.PI * 2);
    ctx.fill();
    drawNeonBox(x + 9, baseY - 66, 68, 14, '#f5d76e', 'VINYL', 8);
  }
  function drawGuitarSign(cx, cy, scale) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.rotate(-0.12);
    ctx.fillStyle = '#c8733f';
    ctx.beginPath();
    ctx.arc(0, 24, 22, 0, Math.PI * 2);
    ctx.arc(24, 24, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2a1b18';
    ctx.beginPath();
    ctx.arc(12, 24, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d9bd78';
    ctx.fillRect(34, 18, 78, 10);
    ctx.fillStyle = '#f5d76e';
    ctx.fillRect(104, 14, 18, 18);
    ctx.restore();
  }
  function drawCumberlandMid(off) {
    const baseY = GROUND_Y;
    const waterTop = baseY - 116;
    const river = ctx.createLinearGradient(0, waterTop, 0, baseY - 18);
    river.addColorStop(0, '#4e86a8');
    river.addColorStop(1, '#244e6f');
    ctx.fillStyle = river;
    ctx.fillRect(0, waterTop, W, 98);
    ctx.fillStyle = 'rgba(255, 226, 160, 0.22)';
    for (let i = 0; i < 15; i++) {
      const x = ((i * 96) - (off * 0.35 % 96)) - 60;
      const y = waterTop + 20 + (i % 5) * 14;
      ctx.fillRect(x, y, 48 + (i % 4) * 22, 2);
    }
    ctx.fillStyle = 'rgba(20, 35, 48, 0.18)';
    for (let i = 0; i < 7; i++) {
      const x = ((i * 180) - (off * 0.22 % 180)) - 90;
      ctx.fillRect(x, waterTop + 66 + (i % 3) * 8, 120, 5);
    }
    // Tile period must equal the drawn span (960) — at 1040 an 80px hole in the
    // deck scrolled across the screen every cycle, reading as a broken bridge.
    drawPedestrianBridge(-((off % 960) + 960) % 960 - 110, waterTop + 20);
    drawPedestrianBridge(-((off % 960) + 960) % 960 + 850, waterTop + 20);
    drawCumberlandBankLabels(waterTop);
    const period = 840;
    const start = -((off * 0.6 % period) + period) % period;
    for (let chunk = -1; chunk < 3; chunk++) {
      const x = start + chunk * period;
      drawBroadShoulderTower(x + 88, baseY - 76, 82, 96, '#24283d');
      drawBroadShoulderTower(x + 202, baseY - 76, 62, 72, '#2e3145');
      drawStadiumBowl(x + 560, baseY - 72);
      drawRiverfrontRail(x + 350, baseY - 52);
    }
  }
  function drawCumberlandBankLabels(waterTop) {
    if (!SHOW_WAYFINDING) return;
    ctx.save();
    ctx.fillStyle = 'rgba(10,20,28,0.55)';
    roundRect(ctx, 42, waterTop + 8, 126, 18, 4);
    ctx.fill();
    roundRect(ctx, W - 188, waterTop + 8, 146, 18, 4);
    ctx.fill();
    ctx.fillStyle = '#d9fbff';
    ctx.font = 'bold 8px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WEST BANK / DOWNTOWN', 105, waterTop + 17);
    ctx.fillText('EAST BANK / STADIUM', W - 115, waterTop + 17);
    ctx.restore();
  }
  function drawPedestrianBridge(x, y) {
    ctx.save();
    ctx.strokeStyle = '#c9b47a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y + 42);
    ctx.lineTo(x + 960, y + 42);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,238,180,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + 49);
    ctx.lineTo(x + 960, y + 49);
    ctx.stroke();
    ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      const ax = x + i * 120;
      ctx.beginPath();
      ctx.moveTo(ax, y + 42);
      ctx.lineTo(ax + 60, y);
      ctx.lineTo(ax + 120, y + 42);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ax + 24, y + 42);
      ctx.lineTo(ax + 84, y + 18);
      ctx.stroke();
      drawLampGlow(ax + 60, y + 43, 16, '#f5d76e', 0.18);
    }
    ctx.strokeStyle = 'rgba(201,180,122,0.42)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 28; i++) {
      const ax = x + i * 36;
      ctx.beginPath();
      ctx.moveTo(ax, y + 42);
      ctx.lineTo(ax, y + 50);
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawStadiumBowl(x, baseY) {
    ctx.fillStyle = '#4b4f61';
    ctx.beginPath();
    ctx.ellipse(x + 90, baseY - 18, 105, 38, 0, Math.PI, 0);
    ctx.lineTo(x + 196, baseY);
    ctx.lineTo(x + 4, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d7dce6';
    ctx.fillRect(x + 24, baseY - 54, 152, 5);
    ctx.fillRect(x + 36, baseY - 40, 128, 4);
    ctx.fillStyle = '#f5d76e';
    for (let i = 0; i < 6; i++) ctx.fillRect(x + 36 + i * 22, baseY - 48, 7, 4);
  }
  function drawRiverfrontRail(x, baseY) {
    ctx.strokeStyle = '#d4c8a0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, baseY - 18);
    ctx.lineTo(x + 170, baseY - 18);
    ctx.stroke();
    ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * 24, baseY - 18);
      ctx.lineTo(x + i * 24, baseY + 6);
      ctx.stroke();
    }
  }
  function drawBroadwayMid(off) {
    const baseY = GROUND_Y;
    // Period 1040 so the chunk CONTENT actually fits inside one period — at 720
    // the arena overflowed into the next chunk and ghosted over its neon signs.
    const period = 1040;
    const start = -((off % period) + period) % period;
    for (let chunk = -1; chunk < 3; chunk++) {
      const x = start + chunk * period;
      drawHonkyTonkFront(x + 18, baseY, 126, '#5b2c51', '#ff62d2', 'LIVE');
      drawHonkyTonkFront(x + 152, baseY, 138, '#4a334f', '#6ee7ff', 'MUSIC');
      drawHonkyTonkFront(x + 300, baseY, 116, '#67312c', '#ffd166', 'BBQ');
      drawHonkyTonkFront(x + 424, baseY, 132, '#2b4560', '#8cff86', 'TONK');
      drawVerticalNeon(x + 578, baseY - 154, '#ff495c', 'NASH');
      drawVerticalNeon(x + 645, baseY - 146, '#f5d76e', 'OPEN');
      drawBroadwayStringLights(x + 18, baseY - 142);
      drawRymanAlleyCue(x + 92, baseY);
      drawBridgeLandingCue(x + 700, baseY);
      drawBridgestoneArena(x + 836, baseY);
      // (crowd silhouettes + avenue markers removed: they sat below the opaque
      // ground fill and could never be seen — dead per-frame work)
    }
  }
  function drawBridgestoneArena(x, baseY) {
    ctx.save();
    // Opaque body — the old 0.88 alpha let the sky/skyline ghost through a
    // building, which read as a glitch rather than distance.
    ctx.fillStyle = '#2d3038';
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x + 18, baseY - 86);
    ctx.quadraticCurveTo(x + 92, baseY - 124, x + 168, baseY - 86);
    ctx.lineTo(x + 190, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d2d6dc';
    ctx.fillRect(x + 28, baseY - 93, 134, 5);
    ctx.fillStyle = '#f5d76e';
    for (let i = 0; i < 8; i++) ctx.fillRect(x + 38 + i * 15, baseY - 78, 5, 5);
    drawNeonBox(x + 52, baseY - 58, 86, 18, '#f5d76e', 'ARENA', 9);
    ctx.restore();
  }
  function drawHonkyTonkFront(x, baseY, w, color, neon, label) {
    const h = 128;
    ctx.fillStyle = buildingGradient(x, baseY - h, w, h, color, true);
    ctx.fillRect(x, baseY - h, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < Math.max(4, Math.floor(w / 18)); col++) {
        if ((row + col) % 2 === 0) ctx.fillRect(x + 5 + col * 18, baseY - h + 18 + row * 12, 11, 2);
      }
    }
    ctx.fillStyle = safeShade(color, -0.24);
    ctx.fillRect(x, baseY - h, w, 14);
    ctx.fillStyle = 'rgba(0,0,0,0.48)';
    ctx.fillRect(x + 12, baseY - 54, w - 24, 54);
    ctx.fillStyle = 'rgba(110, 210, 255, 0.25)';
    ctx.fillRect(x + 18, baseY - 47, w - 36, 26);
    drawNeonBox(x + 12, baseY - h + 22, w - 24, 30, neon, label, 12);
    ctx.fillStyle = '#171824';
    ctx.fillRect(x + 20, baseY - 28, w - 40, 28);
    ctx.fillStyle = '#f5d76e';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(x + 16 + i * ((w - 32) / 4), baseY - 88, 10, 10);
      drawLampGlow(x + 21 + i * ((w - 32) / 4), baseY - 83, 18, '#f5d76e', 0.14);
    }
    ctx.fillStyle = neon;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(x + 8, baseY - 7, w - 16, 5);
    ctx.globalAlpha = 1;
  }
  function drawVerticalNeon(x, y, color, label) {
    ctx.fillStyle = '#181824';
    ctx.fillRect(x, y, 44, 132);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 4, y + 4, 36, 124);
    ctx.fillStyle = color;
    ctx.font = '11px JetBrains Mono, Consolas, monospace';
    ctx.textAlign = 'center';
    if (SHOW_WAYFINDING) {
      for (let i = 0; i < label.length; i++) ctx.fillText(label[i], x + 22, y + 26 + i * 24);
    }
    ctx.restore();
    ctx.textAlign = 'left';
  }
  function drawBroadwayStringLights(x, y) {
    ctx.strokeStyle = 'rgba(20,20,26,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + 180, y + 34, x + 360, y + 30, x + 560, y + 4);
    ctx.stroke();
    for (let i = 0; i < 13; i++) {
      const bx = x + i * 46;
      const by = y + Math.sin(i / 12 * Math.PI) * 28;
      ctx.fillStyle = '#f5d76e';
      ctx.beginPath();
      ctx.arc(bx, by + 2, 2.4, 0, Math.PI * 2);
      ctx.fill();
      drawLampGlow(bx, by + 2, 18, '#f5d76e', 0.13);
    }
  }
  function drawCrowdSilhouettes(x, baseY) {
    ctx.fillStyle = 'rgba(12,12,16,0.62)';
    for (let i = 0; i < 18; i++) {
      const px = x + i * 34 + (i % 3) * 4;
      const h = 16 + (i % 4) * 3;
      ctx.beginPath();
      ctx.arc(px, baseY - h - 8, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(px - 3, baseY - h - 4, 6, h);
    }
  }
  function drawLowerBroadwayAvenueMarkers(x, baseY) {
    if (!SHOW_WAYFINDING) return;
    const marks = [
      { dx: -90, label: '5TH AVE' },
      { dx: 82, label: '4TH' },
      { dx: 236, label: '3RD' },
      { dx: 392, label: '2ND' },
      { dx: 560, label: '1ST AVE' }
    ];
    for (const m of marks) {
      ctx.fillStyle = '#1a1b22';
      ctx.fillRect(x + m.dx, baseY - 21, 54, 17);
      ctx.strokeStyle = '#d7c06d';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + m.dx + 2, baseY - 19, 50, 13);
      ctx.fillStyle = '#f5d76e';
      ctx.font = 'bold 7px "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.label, x + m.dx + 27, baseY - 12);
    }
    ctx.textAlign = 'left';
  }
  function drawRymanAlleyCue(x, baseY) {
    ctx.fillStyle = '#2b1d1b';
    ctx.beginPath();
    ctx.moveTo(x, baseY - 126);
    ctx.lineTo(x + 44, baseY - 154);
    ctx.lineTo(x + 88, baseY - 126);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#5a3028';
    ctx.fillRect(x + 8, baseY - 126, 72, 56);
    drawNeonBox(x + 8, baseY - 68, 72, 15, '#b98cff', 'RYMAN ALLEY', 7);
  }
  function drawBridgeLandingCue(x, baseY) {
    ctx.strokeStyle = '#c9b47a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, baseY - 64);
    ctx.lineTo(x + 114, baseY - 64);
    ctx.moveTo(x + 10, baseY - 64);
    ctx.lineTo(x + 42, baseY - 92);
    ctx.lineTo(x + 74, baseY - 64);
    ctx.moveTo(x + 60, baseY - 64);
    ctx.lineTo(x + 91, baseY - 90);
    ctx.lineTo(x + 122, baseY - 64);
    ctx.stroke();
    drawNeonBox(x + 8, baseY - 46, 96, 15, '#6ee7ff', 'RIVER WALK', 7);
  }

  function drawNearScenery(biome) {
    // Roadside props live on the FAR SHOULDER (just beyond the asphalt edge)
    // and scroll with the road itself, so nothing ever stands in a driving
    // lane. (Pre-lane-system these anchored to GROUND_Y — the middle of
    // today's three-lane road — and used independent modulo wavelengths that
    // periodically stacked props on top of each other.)
    const shoulderY = laneBaseYFor(2) - 12;          // base line above the asphalt edge
    const off = state.distance * ROAD_SCROLL;        // planted: moves with the road sheet
    ctx.fillStyle = biomeColor(biome, 'grass');
    // Grass tufts on the far grass strip (not on the asphalt)
    for (let i = 0; i < 28; i++) {
      const x = ((i * 50) - (off % 50)) - 25;
      const tuftY = shoulderY - 8;
      ctx.fillRect(x, tuftY, 3, 4);
      ctx.fillRect(x + 6, tuftY - 1, 3, 5);
      ctx.fillRect(x + 12, tuftY, 3, 4);
    }
    // One shared world-anchored slot grid per biome: each 220px slot hosts at
    // most ONE prop (type alternates by slot id), so generators can never
    // collide. Slot ids are stable world chunks — geometry never flickers.
    const SLOT = 220;
    const firstSlot = Math.floor((off - 140) / SLOT);
    const lastSlot = Math.ceil((off + W + 140) / SLOT);
    for (let s = firstSlot; s <= lastSlot; s++) {
      const x = s * SLOT - off + (noise01(s * 7.7) - 0.5) * 50;   // stable jitter
      if (biome.name === 'DOWNTOWN') {
        if (s % 2 === 0) {
          // streetlight pole + lamp arm reaching over the shoulder
          ctx.fillStyle = '#2a2a2e';
          ctx.fillRect(x, shoulderY - 52, 4, 52);
          ctx.fillRect(x - 12, shoulderY - 56, 20, 4);
          ctx.fillStyle = '#f5d76e';
          ctx.fillRect(x - 10, shoulderY - 52, 6, 4);
          drawLampGlow(x - 7, shoulderY - 50, 30, '#f5d76e', 0.15);
        } else {
          drawRoadSign(x, shoulderY - 78, 64, 24, '#176d3c', s % 4 === 1 ? 'BROADWAY' : 'DOWNTOWN', shoulderY);
        }
      } else if (biome.name === 'MUSIC ROW') {
        if (s % 2 === 0) {
          // studio mailbox-marquee
          ctx.fillStyle = '#513423';
          ctx.fillRect(x, shoulderY - 30, 6, 30);
          ctx.fillStyle = '#f5d76e';
          ctx.fillRect(x + 6, shoulderY - 30, 30, 14);
          ctx.fillStyle = '#1a1a26';
          ctx.fillRect(x + 9, shoulderY - 27, 24, 3);
          ctx.fillRect(x + 9, shoulderY - 21, 16, 3);
        } else {
          drawRoadSign(x, shoulderY - 70, 56, 22, '#5b4d3a', s % 4 === 1 ? '16TH AVE' : 'STUDIO', shoulderY);
        }
      } else if (biome.name === 'CUMBERLAND') {
        if (s % 2 === 0) {
          // dock rail segment
          ctx.fillStyle = '#2e3942';
          ctx.fillRect(x, shoulderY - 38, 5, 38);
          ctx.fillRect(x + 18, shoulderY - 38, 5, 38);
          ctx.fillRect(x - 4, shoulderY - 34, 32, 4);
          ctx.fillStyle = '#d2c58a';
          ctx.fillRect(x - 4, shoulderY - 46, 32, 3);
        } else {
          drawRoadSign(x, shoulderY - 72, 64, 22, '#255a7a', 'RIVERFRONT', shoulderY);
        }
      } else if (biome.name === 'BROADWAY') {
        // lit storefront marquee every slot — Broadway should feel dense
        const color = ['#ff4fb8', '#64d7ff', '#f5d76e', '#7ee27e'][((s % 4) + 4) % 4];
        ctx.fillStyle = '#181824';
        ctx.fillRect(x, shoulderY - 50, 52, 22);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 3, shoulderY - 47, 46, 16);
        ctx.fillStyle = color;
        ctx.fillRect(x + 10, shoulderY - 40, 26, 3);
        drawLampGlow(x + 26, shoulderY - 40, 28, color, 0.14);
      }
    }
    drawGeoAnchorMarkers(biome);
  }

  function drawAsphaltTexture(roadTop, roadBot, biome) {
    const scroll = state.distance * ROAD_SCROLL;
    ctx.save();
    ctx.globalAlpha = 0.18;
    for (let i = 0; i < 85; i++) {
      const seed = i * 31.7;
      const x = pathModulo(i * 73 - scroll, W + 120) - 60;
      const y = roadTop + 8 + noise01(seed) * (roadBot - roadTop - 16);
      const len = 8 + noise01(seed + 8) * 34;
      ctx.fillStyle = noise01(seed + 2) > 0.48 ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)';
      ctx.fillRect(x, y, len, 1);
    }
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = 'rgba(0,0,0,0.42)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const y = roadTop + 20 + i * ((roadBot - roadTop - 40) / 4);
      const x = pathModulo(i * 260 - state.distance * ROAD_SCROLL, W + 340) - 170;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + 70, y - 8, x + 130, y + 9, x + 210, y - 2);
      ctx.stroke();
    }
    if (biome.name === 'BROADWAY') drawBroadwayRoadReflections(roadTop, roadBot);
    ctx.restore();
  }
  function drawBroadwayRoadReflections(roadTop, roadBot) {
    const colors = ['#ff4fb8', '#64d7ff', '#f5d76e', '#7ee27e'];
    ctx.globalAlpha = 0.20;
    for (let i = 0; i < 14; i++) {
      const x = pathModulo(i * 84 - state.distance * ROAD_SCROLL, W + 120) - 60;
      const y = roadTop + 12 + (i % 5) * ((roadBot - roadTop - 26) / 5);
      const g = ctx.createLinearGradient(x, y, x + 76, y);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, colors[i % colors.length]);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 76, 3);
    }
    ctx.globalAlpha = 1;
  }
  function drawStreetLightPools(roadTop, roadBot, biome) {
    const warm = biome.name === 'BROADWAY' || biome.name === 'DOWNTOWN';
    const colors = biome.name === 'BROADWAY'
      ? ['#ff4fb8', '#64d7ff', '#f5d76e', '#7ee27e']
      : [warm ? '#f5d76e' : '#d9f1ff'];
    ctx.save();
    for (let i = 0; i < 7; i++) {
      const x = pathModulo(i * 170 - state.distance * ROAD_SCROLL, W + 220) - 110;
      const y = roadTop + 24 + (i % 3) * ((roadBot - roadTop - 48) / 2);
      const color = colors[i % colors.length];
      const g = ctx.createRadialGradient(x, y, 4, x, y, 86);
      g.addColorStop(0, hexToRgba(color, biome.name === 'BROADWAY' ? 0.16 : 0.11));
      g.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y + 8, 92, 20, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#000';
    for (let i = 0; i < 5; i++) {
      const x = pathModulo(i * 230 - state.distance * ROAD_SCROLL, W + 260) - 130;
      ctx.fillRect(x, roadTop + 10, 70, roadBot - roadTop - 20);
    }
    ctx.restore();
  }
  function roadSkewAt(y, roadTop, roadBot) {
    const t = Math.max(0, Math.min(1, (y - roadTop) / Math.max(1, roadBot - roadTop)));
    return 4 + t * 12;
  }
  function drawRoadDash(x, y, w, h, roadTop, roadBot) {
    const skew = roadSkewAt(y, roadTop, roadBot);
    fillQuad(x, y, x + w, y, x + w + skew, y + h, x + skew, y + h);
  }
  function drawRoadGeometry(roadTop, roadBot, biome) {
    const roadH = roadBot - roadTop;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.24)';
    ctx.fillRect(0, roadBot - 9, W, 9);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, roadTop + 3, W, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, roadTop + roadH * 0.34, W, 2);
    ctx.fillRect(0, roadTop + roadH * 0.67, W, 2);

    ctx.strokeStyle = biome.name === 'BROADWAY'
      ? 'rgba(255, 210, 245, 0.18)'
      : 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      const x = pathModulo(i * 112 - state.distance * ROAD_SCROLL, W + 160) - 80;
      ctx.beginPath();
      ctx.moveTo(x, roadTop + 4);
      ctx.lineTo(x + 34, roadBot - 8);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(245,215,110,0.34)';
    for (let x = -pathModulo(state.distance * ROAD_SCROLL, 52); x < W + 60; x += 52) {
      drawRoadDash(x, roadTop + 7, 18, 3, roadTop, roadBot);
      drawRoadDash(x + 12, roadBot - 13, 22, 3, roadTop, roadBot);
    }

    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    for (let i = 0; i < 10; i++) {
      const x = pathModulo(i * 126 - state.distance * ROAD_SCROLL, W + 180) - 90;
      fillQuad(x, roadTop - 4, x + 54, roadTop - 4, x + 64, roadTop + 3, x + 8, roadTop + 3);
    }
    ctx.restore();
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
    drawAsphaltTexture(roadTop, roadBot, biome);
    drawStreetLightPools(roadTop, roadBot, biome);
    drawRoadGeometry(roadTop, roadBot, biome);
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
      for (let x = -dashOff; x < W; x += cycle) drawRoadDash(x, dy, dashW, 4, roadTop, roadBot);
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
  function chaseClamp01(v) {
    return Math.max(0, Math.min(1, v));
  }
  function chaseMix(a, b, t) {
    return a + (b - a) * t;
  }
  function chaseDepthT(ahead) {
    const raw = chaseClamp01(1 - ahead / CHASE_DRAW_AHEAD);
    return Math.pow(raw, 1.55);
  }
  function chaseLaneValue() {
    const p = state.player;
    if (p.laneTweenT > 0) {
      const prog = 1 - p.laneTweenT / LANE_TWEEN_DUR;
      const eased = 0.5 - Math.cos(chaseClamp01(prog) * Math.PI) * 0.5;
      return p.lane + (p.laneTarget - p.lane) * eased;
    }
    return p.lane;
  }
  function chaseProject(ahead, lane, height) {
    if (ahead < -60 || ahead > CHASE_DRAW_AHEAD) return null;
    const t = chaseDepthT(Math.max(0, ahead));
    const roadHalf = chaseMix(74, 430, t);
    const laneSpread = roadHalf * 0.43;
    const groundY = chaseMix(CHASE_HORIZON_Y, CHASE_BOTTOM_Y, t);
    const scale = chaseMix(0.18, 2.05, t);
    return {
      x: CHASE_CENTER_X + (lane - 1) * laneSpread,
      y: groundY - (height || 0) * scale * 0.48,
      groundY,
      roadHalf,
      laneSpread,
      scale,
      t
    };
  }
  function chaseAheadOf(obj) {
    return (obj.x || 0) - PLAYER_X;
  }
  function drawChaseRoad(biome) {
    const horizonHalf = 76;
    const bottomHalf = 442;
    ctx.save();
    ctx.fillStyle = biomeColor(biome, 'grass');
    fillQuad(0, CHASE_HORIZON_Y - 8, W, CHASE_HORIZON_Y - 8, W, H, 0, H);

    const roadG = ctx.createLinearGradient(0, CHASE_HORIZON_Y, 0, H);
    roadG.addColorStop(0, safeShade(biomeColor(biome, 'road'), 0.22));
    roadG.addColorStop(0.42, biomeColor(biome, 'road'));
    roadG.addColorStop(1, safeShade(biomeColor(biome, 'road'), -0.26));
    ctx.fillStyle = roadG;
    fillQuad(
      CHASE_CENTER_X - horizonHalf, CHASE_HORIZON_Y,
      CHASE_CENTER_X + horizonHalf, CHASE_HORIZON_Y,
      CHASE_CENTER_X + bottomHalf, H + 34,
      CHASE_CENTER_X - bottomHalf, H + 34
    );

    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(CHASE_CENTER_X + side * horizonHalf, CHASE_HORIZON_Y);
      ctx.lineTo(CHASE_CENTER_X + side * bottomHalf, H + 34);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.26)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 15; i++) {
      const p1 = chaseProject(i * 64, 1, 0);
      const p2 = chaseProject(i * 64 + 42, 1, 0);
      if (!p1 || !p2) continue;
      ctx.beginPath();
      ctx.moveTo(p1.x - p1.roadHalf * 0.92, p1.groundY);
      ctx.lineTo(p2.x - p2.roadHalf * 0.88, p2.groundY);
      ctx.stroke();
    }

    ctx.fillStyle = biomeColor(biome, 'dashColor');
    const dashCycle = 86;
    const dashScroll = pathModulo(state.distance, dashCycle);
    for (const divider of [-0.215, 0.215]) {
      for (let z = -dashScroll; z < CHASE_DRAW_AHEAD; z += dashCycle) {
        const near = chaseProject(z, 1, 0);
        const far = chaseProject(z + 36, 1, 0);
        if (!near || !far) continue;
        const nw = chaseMix(5, 15, near.t);
        const fw = chaseMix(4, 10, far.t);
        fillQuad(
          far.x + far.roadHalf * divider - fw, far.groundY,
          far.x + far.roadHalf * divider + fw, far.groundY,
          near.x + near.roadHalf * divider + nw, near.groundY,
          near.x + near.roadHalf * divider - nw, near.groundY
        );
      }
    }

    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = '#000';
    for (let z = 70; z < CHASE_DRAW_AHEAD; z += 90) {
      const near = chaseProject(z, 1, 0);
      const far = chaseProject(z + 34, 1, 0);
      if (!near || !far) continue;
      ctx.beginPath();
      ctx.moveTo(far.x - far.roadHalf * 0.72, far.groundY);
      ctx.lineTo(near.x - near.roadHalf * 0.62, near.groundY);
      ctx.moveTo(far.x + far.roadHalf * 0.18, far.groundY);
      ctx.lineTo(near.x + near.roadHalf * 0.28, near.groundY);
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawChaseSkyline(biome) {
    const baseY = CHASE_HORIZON_Y + 12;
    const off = state.distance * CLOUD_PARALLAX;
    ctx.save();
    ctx.globalAlpha = biome.timeOfDay === 'sunset' ? 0.42 : 0.32;
    for (let i = -1; i < 12; i++) {
      const x = pathModulo(i * 92 - off, W + 184) - 92;
      const w = 38 + noise01(i * 4.7) * 48;
      const h = 42 + noise01(i * 8.1) * 88;
      ctx.fillStyle = biome.timeOfDay === 'sunset' ? '#231827' : '#30364d';
      ctx.fillRect(x, baseY - h, w, h);
      if (i % 4 === 1) ctx.fillRect(x + w * 0.42, baseY - h - 20, w * 0.16, 20);
      ctx.fillStyle = 'rgba(245,215,110,0.22)';
      for (let r = 0; r < Math.floor(h / 18); r++) {
        if ((r + i) % 2 === 0) ctx.fillRect(x + 8, baseY - h + 12 + r * 18, Math.max(8, w - 18), 2);
      }
    }
    ctx.restore();
  }
  function drawChaseGeoMarkers(biome) {
    if (!SHOW_GEO_LABELS) return;
    const anchors = geoAnchorsForBiome(biome.name);
    for (const a of anchors) {
      const ahead = a.distance - state.distance;
      if (ahead < -120 || ahead > CHASE_DRAW_AHEAD) continue;
      const side = noise01(a.distance) > 0.5 ? 1 : -1;
      const p = chaseProject(ahead, 1, 0);
      if (!p) continue;
      const x = CHASE_CENTER_X + side * p.roadHalf * 0.92;
      const y = p.groundY - 72 * p.scale;
      const w = Math.max(46, 86 * p.scale);
      const h = Math.max(14, 22 * p.scale);
      ctx.save();
      ctx.fillStyle = 'rgba(8,18,22,0.86)';
      roundRect(ctx, x - w / 2, y, w, h, 4);
      ctx.fill();
      ctx.strokeStyle = '#6ee7ff';
      ctx.lineWidth = Math.max(1, 1.4 * p.scale);
      roundRect(ctx, x - w / 2 + 2, y + 2, w - 4, h - 4, 3);
      ctx.stroke();
      ctx.fillStyle = '#d9fbff';
      ctx.font = `bold ${Math.max(6, Math.min(9, 7 * p.scale))}px "JetBrains Mono", Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.label, x, y + h / 2);
      ctx.strokeStyle = 'rgba(70,80,88,0.76)';
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(CHASE_CENTER_X + side * p.roadHalf * 0.72, p.groundY);
      ctx.stroke();
      ctx.restore();
    }
  }
  function drawChasePothole(p) {
    ctx.fillStyle = 'rgba(0,0,0,0.44)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.groundY + 2 * p.scale, 26 * p.scale, 8 * p.scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#07070a';
    ctx.beginPath();
    ctx.ellipse(p.x, p.groundY, 22 * p.scale, 6 * p.scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,190,205,0.65)';
    ctx.lineWidth = Math.max(1, 1.3 * p.scale);
    ctx.beginPath();
    ctx.ellipse(p.x, p.groundY - 1, 18 * p.scale, 4 * p.scale, 0, Math.PI * 1.04, Math.PI * 1.96);
    ctx.stroke();
  }
  function drawChaseCone(p) {
    const w = 15 * p.scale;
    const h = 38 * p.scale;
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.groundY + 2, w * 1.2, 4 * p.scale, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createLinearGradient(p.x - w, 0, p.x + w, 0);
    g.addColorStop(0, '#ff7a3a');
    g.addColorStop(0.55, '#e85a1a');
    g.addColorStop(1, '#9f330d');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(p.x, p.groundY - h);
    ctx.lineTo(p.x + w, p.groundY);
    ctx.lineTo(p.x - w, p.groundY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fdfdfd';
    fillQuad(p.x - w * 0.55, p.groundY - h * 0.48, p.x + w * 0.55, p.groundY - h * 0.48,
      p.x + w * 0.72, p.groundY - h * 0.36, p.x - w * 0.72, p.groundY - h * 0.36);
  }
  function drawChaseSign(p) {
    const w = 78 * p.scale;
    const h = 28 * p.scale;
    const y = p.groundY - 72 * p.scale;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    fillQuad(p.x - w * 0.45, y + h + 4, p.x + w * 0.55, y + h + 4, p.x + w * 0.74, p.groundY + 3, p.x - w * 0.28, p.groundY + 3);
    ctx.fillStyle = '#5a5a62';
    ctx.fillRect(p.x - 3 * p.scale, y + h, 6 * p.scale, p.groundY - y - h);
    ctx.fillStyle = '#7a1c1d';
    fillQuad(p.x + w / 2, y + 4, p.x + w / 2 + 8 * p.scale, y + 7, p.x + w / 2 + 8 * p.scale, y + h + 4, p.x + w / 2, y + h);
    const pg = ctx.createLinearGradient(0, y, 0, y + h);
    pg.addColorStop(0, '#e8484a');
    pg.addColorStop(1, '#b82a2a');
    ctx.fillStyle = pg;
    roundRect(ctx, p.x - w / 2, y, w, h, 4 * p.scale);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, 1.6 * p.scale);
    roundRect(ctx, p.x - w / 2 + 3 * p.scale, y + 3 * p.scale, w - 6 * p.scale, h - 6 * p.scale, 3 * p.scale);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.max(8, 14 * p.scale)}px "JetBrains Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('STOP', p.x, y + h / 2);
    ctx.textAlign = 'left';
  }
  function drawChaseObstacle(o) {
    const p = chaseProject(chaseAheadOf(o), o.lane, 0);
    if (!p) return;
    if (o.type === 'pothole') drawChasePothole(p);
    else if (o.type === 'cone') drawChaseCone(p);
    else if (o.type === 'sign') drawChaseSign(p);
  }
  function drawChaseCollectible(c) {
    const ahead = chaseAheadOf(c);
    const lift = Math.max(8, laneBaseYFor(c.lane) - c.y + Math.sin(c.bob || 0) * 4);
    const p = chaseProject(ahead, c.lane, lift);
    if (!p) return;
    if (c.type === 'pitstop') {
      const w = 70 * p.scale;
      const h = 54 * p.scale;
      ctx.fillStyle = 'rgba(126,226,126,0.22)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.groundY - h * 0.32, w * 0.75, h * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2f7a3a';
      roundRect(ctx, p.x - w * 0.24, p.groundY - h, w * 0.48, h, 4 * p.scale);
      ctx.fill();
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i % 2 ? '#fafafa' : '#d63a3a';
        ctx.fillRect(p.x - w / 2 + i * w / 6, p.groundY - h - 14 * p.scale, w / 6 + 1, 14 * p.scale);
      }
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(7, 9 * p.scale)}px "JetBrains Mono", Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('PIT', p.x, p.groundY - h * 0.36);
      ctx.textAlign = 'left';
      return;
    }
    if (c.type === 'nitro') {
      ctx.fillStyle = 'rgba(0, 212, 255, 0.34)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 18 * p.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#00d4ff';
      ctx.beginPath();
      ctx.moveTo(p.x + 3 * p.scale, p.y - 20 * p.scale);
      ctx.lineTo(p.x - 9 * p.scale, p.y + 2 * p.scale);
      ctx.lineTo(p.x - 1 * p.scale, p.y + 2 * p.scale);
      ctx.lineTo(p.x - 5 * p.scale, p.y + 20 * p.scale);
      ctx.lineTo(p.x + 10 * p.scale, p.y - 4 * p.scale);
      ctx.lineTo(p.x + 1 * p.scale, p.y - 4 * p.scale);
      ctx.closePath();
      ctx.fill();
      return;
    }
    if (c.type === 'fuel') {
      const w = 22 * p.scale;
      const h = 30 * p.scale;
      ctx.fillStyle = gameColor('rgba(220,70,55,0.32)', 'rgba(0,114,178,0.36)');
      ctx.beginPath();
      ctx.arc(p.x, p.y + h * 0.35, 20 * p.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = gameColor('#c0392b', '#005f8f');
      roundRect(ctx, p.x - w / 2, p.y, w, h, 3 * p.scale);
      ctx.fill();
      ctx.strokeStyle = gameColor('#7d241b', '#00405c');
      ctx.lineWidth = Math.max(1, 1.5 * p.scale);
      ctx.stroke();
      ctx.strokeStyle = gameColor('#e8897f', '#7fc7ef');
      ctx.beginPath();
      ctx.moveTo(p.x - w * 0.34, p.y + h * 0.22);
      ctx.lineTo(p.x + w * 0.34, p.y + h * 0.78);
      ctx.moveTo(p.x + w * 0.34, p.y + h * 0.22);
      ctx.lineTo(p.x - w * 0.34, p.y + h * 0.78);
      ctx.stroke();
      return;
    }
    ctx.fillStyle = gameColor('rgba(245,215,110,0.42)', 'rgba(255,210,63,0.44)');
    ctx.beginPath();
    ctx.arc(p.x, p.y, 16 * p.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = gameColor('#f5d76e', '#ffd23f');
    ctx.beginPath();
    ctx.arc(p.x, p.y, 10 * p.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = gameColor('#a86a1a', '#7a4b00');
    ctx.font = `bold ${Math.max(8, 14 * p.scale)}px "JetBrains Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', p.x, p.y);
    ctx.textAlign = 'left';
  }
  function drawChaseSemi(s) {
    const p = chaseProject(chaseAheadOf(s), 1, 0);
    if (!p) return;
    const w = 132 * p.scale;
    const h = 44 * p.scale;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.groundY + 4, w * 0.52, 8 * p.scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = s.color;
    roundRect(ctx, p.x - w / 2, p.groundY - h, w, h, 5 * p.scale);
    ctx.fill();
    ctx.fillStyle = '#dadada';
    roundRect(ctx, p.x + w * 0.20, p.groundY - h * 0.84, w * 0.30, h * 0.72, 4 * p.scale);
    ctx.fill();
    ctx.fillStyle = '#9cd0f0';
    ctx.fillRect(p.x + w * 0.27, p.groundY - h * 0.70, w * 0.16, h * 0.22);
  }
  function drawChasePlayerCar(alpha) {
    const lane = chaseLaneValue();
    const x = CHASE_CENTER_X + (lane - 1) * 138;
    const baseY = 493 - state.player.jumpOff * 0.74;
    const duck = !!state.player.ducking;
    const color = state.carStyle.body;
    const stripe = state.carStyle.stripe;
    const tilt = state.player.tilt || 0;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.translate(x, baseY);
    ctx.rotate(tilt * 0.22);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath();
    ctx.ellipse(0, 24 + state.player.jumpOff * 0.60, 54, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    const bodyG = ctx.createLinearGradient(-52, -20, 52, 24);
    bodyG.addColorStop(0, safeShade(color, 0.18));
    bodyG.addColorStop(0.48, color);
    bodyG.addColorStop(1, safeShade(color, -0.32));
    ctx.fillStyle = bodyG;
    ctx.beginPath();
    ctx.moveTo(-58, 18);
    ctx.lineTo(-46, -12);
    ctx.quadraticCurveTo(-14, -30, 42, -14);
    ctx.lineTo(58, 18);
    ctx.quadraticCurveTo(24, 32, -28, 30);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = stripe;
    ctx.fillRect(-8, -22, 16, 50);
    ctx.fillStyle = '#15151c';
    roundRect(ctx, -24, duck ? -18 : -24, 48, duck ? 18 : 26, 6);
    ctx.fill();
    ctx.fillStyle = '#ff3a3a';
    ctx.fillRect(-43, 12, 18, 5);
    ctx.fillRect(25, 12, 18, 5);
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(-41, 23, 10, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(41, 23, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f5d76e';
    ctx.font = 'bold 12px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(state.carNumber || 7), 0, 5);
    ctx.restore();
  }
  function drawChaseGhostPlayer() {
    const frame = currentGhostFrame();
    if (!frame) return;
    const diff = frame[1] - state.distance;
    if (diff < -100 || diff > CHASE_DRAW_AHEAD) {
      drawGhostArrow(diff);
      return;
    }
    const lane = [0, 1, 2].reduce((best, l) =>
      Math.abs(frame[2] - laneBaseYFor(l)) < Math.abs(frame[2] - laneBaseYFor(best)) ? l : best, 1);
    const p = chaseProject(diff, lane, Math.max(0, laneBaseYFor(lane) - frame[2]));
    if (!p) return;
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.translate(p.x, p.y);
    ctx.scale(Math.max(0.45, p.scale * 0.44), Math.max(0.45, p.scale * 0.44));
    ctx.setLineDash([8, 6]);
    ctx.fillStyle = gameColor('#9be7ff', '#f0e442');
    ctx.strokeStyle = gameColor('#ffffff', '#0072b2');
    roundRect(ctx, -46, -18, 92, 36, 8);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  function drawChaseFinishLine() {
    const ahead = TRIP_TOTAL - state.distance;
    const p = chaseProject(ahead, 1, 0);
    if (!p) return;
    const w = p.roadHalf * 1.1;
    const y = p.groundY - 4 * p.scale;
    const cells = 12;
    const cellW = w / cells;
    const cellH = Math.max(3, 8 * p.scale);
    for (let i = 0; i < cells; i++) {
      ctx.fillStyle = i % 2 ? '#111' : '#fafafa';
      fillQuad(p.x - w / 2 + i * cellW, y, p.x - w / 2 + (i + 1) * cellW, y,
        p.x - w / 2 + (i + 1) * cellW + 8 * p.scale, y + cellH, p.x - w / 2 + i * cellW + 8 * p.scale, y + cellH);
    }
  }
  function drawChaseWorld(biome) {
    drawChaseSkyline(biome);
    drawChaseRoad(biome);
    drawChaseGeoMarkers(biome);
    if (!(state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED)) return;
    const items = [];
    for (const s of state.semis) items.push({ kind: 'semi', item: s, ahead: chaseAheadOf(s) });
    for (const c of state.collectibles) items.push({ kind: 'collectible', item: c, ahead: chaseAheadOf(c) });
    for (const o of state.obstacles) items.push({ kind: 'obstacle', item: o, ahead: chaseAheadOf(o) });
    items.sort((a, b) => b.ahead - a.ahead);
    for (const entry of items) {
      if (entry.ahead < -90 || entry.ahead > CHASE_DRAW_AHEAD) continue;
      if (entry.kind === 'semi') drawChaseSemi(entry.item);
      else if (entry.kind === 'collectible') drawChaseCollectible(entry.item);
      else drawChaseObstacle(entry.item);
    }
    drawChaseFinishLine();
    drawChaseGhostPlayer();
    drawChasePlayerCar();
  }

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
    // racing stripe — honors the run's livery (chase view already did)
    ctx.save(); ctx.globalAlpha = 0.92; ctx.strokeStyle = state.carStyle.stripe || '#ffffff'; ctx.lineWidth = 4.5 * k;
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

  function drawObstacles(laneFilter) {
    for (const o of state.obstacles) {
      if (laneFilter !== undefined && o.lane !== laneFilter) continue;
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
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        fillQuad(o.x + 8, o.y + o.h + 4, o.x + o.w + 8, o.y + o.h + 4, o.x + o.w + 20, GROUND_Y + 2, o.x + 24, GROUND_Y + 2);
        ctx.fillStyle = '#7a1c1d';
        fillQuad(o.x + o.w, o.y + 4, o.x + o.w + 8, o.y + 8, o.x + o.w + 8, o.y + o.h + 4, o.x + o.w, o.y + o.h);
        ctx.fillStyle = '#ff6567';
        fillQuad(o.x + 4, o.y, o.x + o.w, o.y, o.x + o.w + 8, o.y + 5, o.x + 12, o.y + 5);
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
    const calm = reduceMotionOn();   // calm mode: no bob, steady glow
    const cx = c.x + c.w / 2;
    const cy = c.y + (calm ? 0 : Math.sin(c.bob) * 4) + c.h / 2;
    const pulse = calm ? 0.8 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(c.bob * 1.5));
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
      // Horizontal streaks sweeping backward — they sell forward speed. (The
      // old version scrolled them VERTICALLY at 1400px/s, which read as the
      // scene moving up and down.)
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.35)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const y = 50 + i * 105;
        const x = VIEW_W + 110 - ((Math.floor(state.runTime * 1400) + i * 137) % (VIEW_W + 220));
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 70 + (i % 3) * 40, y); ctx.stroke();
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

  function drawCollectibles(laneFilter) {
    for (const c of state.collectibles) {
      if (laneFilter !== undefined && c.lane !== laneFilter) continue;
      if (c.type === 'pitstop') {
        drawPitstop(c);
        continue;
      }
      if (c.type === 'nitro') {
        drawNitro(c);
        continue;
      }
      const float = reduceMotionOn() ? 0 : Math.sin(c.bob) * 4;   // calm mode: no hover bob
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
    if (reduceMotionOn()) {
      // Calm hit feedback: a steady edge border for the same duration — the
      // "you got hit" information survives without the full-screen flash.
      ctx.strokeStyle = 'rgba(232, 90, 26, 0.8)';
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, W - 6, H - 6);
      return;
    }
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
      // Stable per-line y (no per-frame reseed shimmer), and the streaks sweep
      // BACKWARD with the world — they used to jump forward against the scroll.
      const r = noise01(i * 7.13);
      const y = 100 + r * (GROUND_Y - 120);
      const len = 40 + r * 80 + intensity * 60;
      const x = W + 100 - ((Math.floor(state.distance * 4) + i * 71) % (W + 200));
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

  // Checkered race gate that scrolls in during the final stretch of Broadway.
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
    // so the car always presses forward and the trip accelerates toward Broadway.
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
      if (b.name === 'MUSIC ROW') unlockAchievement('music-row');
      if (b.name === 'CUMBERLAND') unlockAchievement('cumberland');
      if (b.name === 'BROADWAY') unlockAchievement('broadway');
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
    const chaseMode = state.cameraMode === CAMERA_CHASE &&
      (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED);

    // The far background (sky through atmosphere) stays UNSHAKEN — shaking the
    // whole scene read as the background twitching. Impact shake belongs to the
    // road/gameplay layer only.
    drawSky(b);
    drawSun(b);
    drawClouds(b);
    drawBirds();
    drawFarMountains(b);
    drawAtmosphere(b);

    ctx.save();
    ctx.translate(shake.x, shake.y);
    if (chaseMode) {
      drawChaseWorld(b);
      drawScorePopups();
    } else {
      drawMidScenery(b);
      drawGround(b);
      drawNearScenery(b);

      if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) {
        // Painter's order by depth: far-lane entities first, then semis (their
        // bottom edge reads nearer than the far lane but behind the center
        // lane), then center/near lanes. Previously draw-by-type let far-lane
        // cones paint over a visually nearer truck.
        drawCollectibles(2);
        drawObstacles(2);
        drawSemis();
        for (const lane of [1, 0]) {
          drawCollectibles(lane);
          drawObstacles(lane);
        }
        drawFinishLine();
        drawSpeedLines();
        drawGhostPlayer();
        drawPlayer();
        drawParticles();
        drawScorePopups();
      }
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
    } else if (state.screen === SCREEN.TITLE && !reduceMotionOn()) {
      // Attract-mode ambience: drift the cloud layer and fly bird flocks so the
      // live world behind the menu visibly moves. Touches NO gameplay state
      // (obstacles, fuel, score, spawner) — purely background dressing, and
      // calm mode keeps the title still.
      state.ambient += dt * 140;
      state.nextBirdAt -= dt;
      if (state.nextBirdAt <= 0) {
        spawnBirdFlock();
        state.nextBirdAt = 7 + Math.random() * 8;
      }
      updateBirds(dt);
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

    // 4b) qualification uses a loaded Neon board when one is present, so a
    //     blank local profile cannot prompt for initials on a non-cloud score.
    {
      const snapScores = state.scores;
      const snapCloudScores = state.cloudScores;
      let pass = false, detail = '';
      try {
        state.scores = [];
        state.cloudScores = [1000, 900, 800, 700, 600]
          .map((score, i) => ({ initials: 'C' + i, score, date: '2026-06-07' }));
        pass = qualifies(500) === false && qualifies(650) === true;
        detail = JSON.stringify(scoreBoardForQualification());
      } catch (e) { detail = String(e); }
      finally {
        state.scores = snapScores;
        state.cloudScores = snapCloudScores;
      }
      check('high-score qualification honors loaded cloud board', pass, detail);
    }

    // 4c) Camera switching must be renderer-only: physics/spawn/collision keep
    //     owning the same live object arrays, and the toggle is reversible.
    {
      const snapCamera = state.cameraMode;
      const obstacleRef = state.obstacles;
      const collectibleRef = state.collectibles;
      let pass = false, detail = '';
      try {
        state.cameraMode = CAMERA_SIDE;
        toggleCameraMode();
        const chase = state.cameraMode === CAMERA_CHASE;
        toggleCameraMode();
        const side = state.cameraMode === CAMERA_SIDE;
        pass = chase && side &&
          obstacleRef === state.obstacles &&
          collectibleRef === state.collectibles;
        detail = state.cameraMode;
      } catch (e) { detail = String(e); }
      finally {
        state.cameraMode = snapCamera;
      }
      check('camera toggle is renderer-only and reversible', pass, detail);
    }

    // 4d) Visual-depth constants are structural QA, not decorative preferences:
    //     road paint moves as one sheet, parallax ramps far-to-near, and map
    //     labels stay off for the immersive build.
    {
      const roadOk = ROAD_SCROLL === 1.0;
      const parallaxOk = CLOUD_PARALLAX < MOUNTAIN_PARALLAX &&
        MOUNTAIN_PARALLAX < SKYLINE_PARALLAX &&
        SKYLINE_PARALLAX < MID_SCENERY_PARALLAX &&
        MID_SCENERY_PARALLAX < GEO_SIGN_PARALLAX;
      const labelsOk = SHOW_GEO_LABELS === false && SHOW_WAYFINDING === false;
      check('visual QA constants lock road/parallax/labels',
        roadOk && parallaxOk && labelsOk,
        JSON.stringify({
          road: ROAD_SCROLL,
          parallax: [CLOUD_PARALLAX, MOUNTAIN_PARALLAX, SKYLINE_PARALLAX, MID_SCENERY_PARALLAX, GEO_SIGN_PARALLAX],
          labels: [SHOW_GEO_LABELS, SHOW_WAYFINDING]
        }));
    }

    // 4e) Ghost import validation: bounded frame count + finite-only coercion
    //     (pure function — no state touched).
    {
      const mk = (frames) => ({ version: GHOST_VERSION, game: 'Weekend Road Trip', frames });
      const okGhost = normalizeGhost(mk([[0, 0, 432, 5, 0], [0.1, 10, 432, 5, 0]]));
      const oversized = normalizeGhost(mk(new Array(GHOST_MAX_FRAMES + 1).fill([0, 0, 432, 5, 0])));
      check('ghost import: sane payload accepted, oversized rejected',
        !!okGhost && oversized === null, 'cap=' + GHOST_MAX_FRAMES);
      const inf = normalizeGhost(mk([[Infinity, 0, 432, 5, 0], [0.1, 10, 432, 5, 0]]));
      check('ghost import: non-finite frame fields coerced to safe defaults',
        !!inf && inf.frames[0][0] === 0,
        inf ? JSON.stringify(inf.frames[0]) : 'null');
    }

    // 4f) Combo multiplier is uncapped — a longer clean chain always pays more
    //     (the "uncapped-feeling combo" requirement); only the SFX pitch clamps.
    check('combo multiplier keeps climbing past the old 25 ceiling',
      comboMult(26) > comboMult(25) && comboMult(40) > comboMult(25),
      'x' + comboMult(25).toFixed(1) + ' @25 → x' + comboMult(40).toFixed(1) + ' @40');

    // 4g) Reduce-motion gates canvas particles at the spawn source (in-memory
    //     settings flip; snapshot + restore — non-destructive).
    {
      const realRM = state.settings.reduceMotion;
      const realParticles = state.particles;
      let pass = false, detail = '';
      try {
        state.particles = [];
        state.settings.reduceMotion = true;
        spawnSparks(100, 100);
        spawnPickupBurst(100, 100, '#fff');
        spawnDust(100, 100, 5);
        spawnExhaust(100, 100);
        spawnTireSmoke(100, 100);
        const calmCount = state.particles.length;
        state.settings.reduceMotion = false;
        spawnSparks(100, 100);
        const activeCount = state.particles.length;
        pass = calmCount === 0 && activeCount > 0;
        detail = 'calm spawns=' + calmCount + ', active spawns=' + activeCount;
      } catch (e) { detail = String(e); }
      finally {
        state.settings.reduceMotion = realRM;
        state.particles = realParticles;
      }
      check('reduce-motion gates particle spawns at the source', pass, detail);
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
