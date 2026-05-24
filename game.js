/*
 * Weekend Road Trip — a single-player 2D side-scroller.
 * ENGR 5513 Applied AI in Engineering, Lipscomb MSAI, Summer 2026.
 *
 * Architecture (single-file, intentional):
 *   - State machine over SCREENS (title, playing, paused, gameover, win, initials, scores)
 *   - Per-tick update + render driven by requestAnimationFrame
 *   - Procedural scenery (no image assets — all canvas primitives)
 *   - High scores persisted to localStorage under STORAGE_KEY
 */

(() => {
  'use strict';

  // ============================================================
  // CONFIG
  // ============================================================
  const W = 960;
  const H = 540;
  const GROUND_Y = 430;
  const GRAVITY = 0.7;
  const JUMP_V = -13;
  const PLAYER_X = 140;
  const BASE_SPEED = 5;
  const MAX_SPEED = 9;
  const SPEED_ACCEL = 0.08;
  const SPEED_BRAKE = 0.15;
  const FUEL_MAX = 100;
  const FUEL_DRAIN_PER_SEC = 1.8;
  const HIT_FUEL_PENALTY = 18;
  const STORAGE_KEY = 'wrt.highscores.v1';
  const MAX_SCORES = 5;

  // Biome plan: each is a stretch of distance. Total trip = ~6000 distance units.
  const BIOMES = [
    { name: 'CITY',   end: 1500, sky: ['#7ec3e8', '#b8e0f0'], ground: '#3a3a3a', accent: '#5c5c70' },
    { name: 'FOREST', end: 3000, sky: ['#9bd0a8', '#e0f0d0'], ground: '#2d4a2d', accent: '#1f3a1f' },
    { name: 'DESERT', end: 4500, sky: ['#f5b27a', '#f9d6a0'], ground: '#c69065', accent: '#8a5a3a' },
    { name: 'COAST',  end: 6000, sky: ['#ffb37a', '#ffd9a8'], ground: '#e8c890', accent: '#d4a96a' }
  ];
  const TRIP_TOTAL = BIOMES[BIOMES.length - 1].end;

  const SCREEN = {
    TITLE: 'title',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAMEOVER: 'gameover',
    WIN: 'win',
    INITIALS: 'initials',
    SCORES: 'scores',
    HELP: 'help'
  };

  // ============================================================
  // STATE
  // ============================================================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const state = {
    screen: SCREEN.TITLE,
    prevScreen: SCREEN.TITLE,
    keys: new Set(),
    lastTime: 0,
    // gameplay
    distance: 0,
    score: 0,
    speed: BASE_SPEED,
    fuel: FUEL_MAX,
    biomeIdx: 0,
    obstacles: [],
    collectibles: [],
    particles: [],
    spawnTimer: 0,
    flashTimer: 0,
    // player
    player: { y: GROUND_Y, vy: 0, ducking: false, jumping: false },
    // initials entry
    initials: ['A', 'A', 'A'],
    initialsIdx: 0,
    pendingScore: 0,
    // scores
    scores: []
  };

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
      // localStorage unavailable; silently skip — game still playable per session
    }
  }

  function qualifies(score) {
    const list = state.scores;
    if (list.length < MAX_SCORES) return true;
    return score > list[list.length - 1].score;
  }

  function insertScore(initials, score) {
    const entry = { initials: initials.join(''), score, date: new Date().toISOString().slice(0, 10) };
    state.scores.push(entry);
    state.scores.sort((a, b) => b.score - a.score);
    state.scores = state.scores.slice(0, MAX_SCORES);
    saveScores(state.scores);
  }

  // ============================================================
  // INPUT
  // ============================================================
  const KEYMAP = {
    jump: ['Space', 'KeyW', 'ArrowUp'],
    duck: ['KeyS', 'ArrowDown'],
    accel: ['KeyD', 'ArrowRight'],
    brake: ['KeyA', 'ArrowLeft'],
    confirm: ['Enter'],
    pause: ['KeyP', 'Escape'],
    help: ['Slash']
  };

  function isAction(action, code) {
    return KEYMAP[action] && KEYMAP[action].includes(code);
  }

  window.addEventListener('keydown', (e) => {
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    state.keys.add(e.code);
    handleKeyPress(e.code, e.key);
  });

  window.addEventListener('keyup', (e) => {
    state.keys.delete(e.code);
    if (isAction('duck', e.code)) state.player.ducking = false;
  });

  function handleKeyPress(code, key) {
    switch (state.screen) {
      case SCREEN.TITLE:
        if (isAction('confirm', code)) startRun();
        else if (code === 'KeyH') showScores();
        else if (isAction('help', code)) openHelp();
        break;
      case SCREEN.PLAYING:
        if (isAction('jump', code)) tryJump();
        if (isAction('duck', code)) state.player.ducking = true;
        if (isAction('pause', code)) state.screen = SCREEN.PAUSED;
        if (isAction('help', code)) openHelp();
        break;
      case SCREEN.PAUSED:
        if (isAction('pause', code) || isAction('confirm', code)) state.screen = SCREEN.PLAYING;
        if (code === 'KeyQ') state.screen = SCREEN.TITLE;
        break;
      case SCREEN.GAMEOVER:
      case SCREEN.WIN:
        if (isAction('confirm', code)) {
          if (qualifies(state.score)) startInitialsEntry();
          else showScores();
        }
        break;
      case SCREEN.INITIALS:
        handleInitialsKey(code, key);
        break;
      case SCREEN.SCORES:
        if (isAction('confirm', code) || code === 'KeyR') state.screen = SCREEN.TITLE;
        break;
      case SCREEN.HELP:
        if (isAction('help', code) || isAction('confirm', code) || isAction('pause', code)) {
          state.screen = state.prevScreen;
        }
        break;
    }
  }

  function openHelp() {
    state.prevScreen = state.screen;
    state.screen = SCREEN.HELP;
  }

  function handleInitialsKey(code, key) {
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
      showScores();
    } else if (/^Key[A-Z]$/.test(code)) {
      state.initials[state.initialsIdx] = code.slice(3);
      state.initialsIdx = Math.min(2, state.initialsIdx + 1);
    } else if (code === 'Backspace') {
      state.initialsIdx = Math.max(0, state.initialsIdx - 1);
      state.initials[state.initialsIdx] = 'A';
    }
  }

  function cycleChar(c, dir) {
    const code = c.charCodeAt(0);
    let next = code + dir;
    if (next > 90) next = 65;
    if (next < 65) next = 90;
    return String.fromCharCode(next);
  }

  // ============================================================
  // SCREEN TRANSITIONS
  // ============================================================
  function startRun() {
    state.distance = 0;
    state.score = 0;
    state.speed = BASE_SPEED;
    state.fuel = FUEL_MAX;
    state.biomeIdx = 0;
    state.obstacles = [];
    state.collectibles = [];
    state.particles = [];
    state.spawnTimer = 0;
    state.player.y = GROUND_Y;
    state.player.vy = 0;
    state.player.jumping = false;
    state.player.ducking = false;
    state.screen = SCREEN.PLAYING;
  }

  function startInitialsEntry() {
    state.pendingScore = state.score;
    state.initials = ['A', 'A', 'A'];
    state.initialsIdx = 0;
    state.screen = SCREEN.INITIALS;
  }

  function showScores() {
    state.scores = loadScores();
    state.screen = SCREEN.SCORES;
  }

  // ============================================================
  // PLAYER
  // ============================================================
  function tryJump() {
    if (!state.player.jumping) {
      state.player.vy = JUMP_V;
      state.player.jumping = true;
    }
  }

  function updatePlayer(dt) {
    state.player.vy += GRAVITY;
    state.player.y += state.player.vy;
    if (state.player.y >= GROUND_Y) {
      state.player.y = GROUND_Y;
      state.player.vy = 0;
      state.player.jumping = false;
    }
  }

  function playerBox() {
    const h = state.player.ducking ? 30 : 50;
    const w = 70;
    const y = state.player.y - h + 10; // offset so duck flattens shape
    return { x: PLAYER_X, y, w, h };
  }

  // ============================================================
  // OBSTACLES & COLLECTIBLES
  // ============================================================
  // Obstacle types: 'pothole' (low, jump), 'sign' (high, duck), 'cone' (low, jump)
  // Collectible types: 'fuel' (+fuel), 'snack' (+score)

  function spawn() {
    const r = Math.random();
    if (r < 0.55) {
      const type = Math.random() < 0.5 ? 'pothole' : 'cone';
      state.obstacles.push(makeObstacle(type));
    } else if (r < 0.78) {
      state.obstacles.push(makeObstacle('sign'));
    } else if (r < 0.92) {
      state.collectibles.push(makeCollectible('snack'));
    } else {
      state.collectibles.push(makeCollectible('fuel'));
    }
  }

  function makeObstacle(type) {
    const o = { type, x: W + 40, hit: false };
    if (type === 'pothole') { o.w = 60; o.h = 18; o.y = GROUND_Y + 2; }
    else if (type === 'cone') { o.w = 22; o.h = 34; o.y = GROUND_Y - o.h + 8; }
    else if (type === 'sign') { o.w = 18; o.h = 100; o.y = GROUND_Y - 130; }
    return o;
  }

  function makeCollectible(type) {
    const yHigh = GROUND_Y - 80; // forces a jump
    const yLow = GROUND_Y - 30;
    const o = {
      type,
      x: W + 40,
      w: 26,
      h: 26,
      y: Math.random() < 0.4 ? yHigh : yLow,
      taken: false
    };
    return o;
  }

  function updateWorld(dt) {
    const move = state.speed * dt * 60;

    state.spawnTimer -= dt;
    if (state.spawnTimer <= 0) {
      spawn();
      state.spawnTimer = 0.7 + Math.random() * 0.9 - state.speed * 0.04;
      if (state.spawnTimer < 0.4) state.spawnTimer = 0.4;
    }

    for (const o of state.obstacles) o.x -= move;
    for (const c of state.collectibles) c.x -= move;

    state.obstacles = state.obstacles.filter((o) => o.x + o.w > -20);
    state.collectibles = state.collectibles.filter((c) => c.x + c.w > -20);

    // collisions
    const pb = playerBox();
    for (const o of state.obstacles) {
      if (o.hit) continue;
      if (rectsOverlap(pb, o)) {
        o.hit = true;
        state.fuel -= HIT_FUEL_PENALTY;
        state.flashTimer = 0.25;
        burst(o.x + o.w / 2, o.y + o.h / 2, '#ff5252');
      }
    }
    for (const c of state.collectibles) {
      if (c.taken) continue;
      if (rectsOverlap(pb, c)) {
        c.taken = true;
        if (c.type === 'fuel') {
          state.fuel = Math.min(FUEL_MAX, state.fuel + 25);
          state.score += 25;
          burst(c.x + c.w / 2, c.y + c.h / 2, '#7ee27e');
        } else {
          state.score += 50;
          burst(c.x + c.w / 2, c.y + c.h / 2, '#f5d76e');
        }
      }
    }
    state.collectibles = state.collectibles.filter((c) => !c.taken);
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function burst(x, y, color) {
    for (let i = 0; i < 10; i++) {
      state.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 6,
        vy: (Math.random() - 0.5) * 6 - 2,
        life: 0.5,
        color
      });
    }
  }

  function updateParticles(dt) {
    for (const p of state.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.3;
      p.life -= dt;
    }
    state.particles = state.particles.filter((p) => p.life > 0);
  }

  // ============================================================
  // RENDER — scenery
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

  function drawSky(biome) {
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, biome.sky[0]);
    g.addColorStop(1, biome.sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, GROUND_Y);
    // sun
    ctx.fillStyle = 'rgba(255, 240, 200, 0.8)';
    ctx.beginPath();
    ctx.arc(W - 140, 110, 38, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawParallax(biome) {
    const d = state.distance;
    // far layer
    drawFarLayer(biome, d * 0.15);
    // mid layer (biome-specific)
    drawMidLayer(biome, d * 0.4);
    // near scenery (ground details handled below)
  }

  function drawFarLayer(biome, off) {
    ctx.fillStyle = shade(biome.accent, -0.25);
    const baseY = GROUND_Y - 80;
    for (let i = 0; i < 6; i++) {
      const x = ((i * 220) - (off % 220)) - 110;
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.lineTo(x + 110, baseY - 90);
      ctx.lineTo(x + 220, baseY);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawMidLayer(biome, off) {
    if (biome.name === 'CITY') drawCityMid(off);
    else if (biome.name === 'FOREST') drawForestMid(off);
    else if (biome.name === 'DESERT') drawDesertMid(off);
    else drawCoastMid(off);
  }

  function drawCityMid(off) {
    const baseY = GROUND_Y;
    for (let i = 0; i < 10; i++) {
      const x = ((i * 130) - (off % 130)) - 60;
      const h = 80 + ((i * 53) % 90);
      ctx.fillStyle = '#3d3d52';
      ctx.fillRect(x, baseY - h, 110, h);
      // windows
      ctx.fillStyle = '#f5d76e';
      for (let row = 0; row < Math.floor(h / 20) - 1; row++) {
        for (let col = 0; col < 4; col++) {
          if (((i + row + col) % 3) !== 0) continue;
          ctx.fillRect(x + 12 + col * 22, baseY - h + 12 + row * 20, 12, 10);
        }
      }
    }
  }

  function drawForestMid(off) {
    const baseY = GROUND_Y;
    for (let i = 0; i < 16; i++) {
      const x = ((i * 80) - (off % 80)) - 40;
      const h = 110 + ((i * 37) % 40);
      ctx.fillStyle = '#5a3a1f';
      ctx.fillRect(x + 18, baseY - 30, 8, 30);
      ctx.fillStyle = '#1f3a1f';
      ctx.beginPath();
      ctx.moveTo(x, baseY - 30);
      ctx.lineTo(x + 22, baseY - 30 - h);
      ctx.lineTo(x + 44, baseY - 30);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawDesertMid(off) {
    const baseY = GROUND_Y;
    for (let i = 0; i < 14; i++) {
      const x = ((i * 100) - (off % 100)) - 50;
      const h = 70 + ((i * 41) % 40);
      ctx.fillStyle = '#5a8a3a';
      // cactus trunk
      ctx.fillRect(x + 16, baseY - h, 14, h);
      // arms
      ctx.fillRect(x + 8, baseY - h + 18, 8, 24);
      ctx.fillRect(x + 30, baseY - h + 28, 8, 20);
      ctx.fillRect(x + 8, baseY - h + 18, 4, 4); // arm cap (decorative)
    }
  }

  function drawCoastMid(off) {
    const baseY = GROUND_Y;
    // ocean strip on the horizon
    ctx.fillStyle = '#3a8ec8';
    ctx.fillRect(0, baseY - 60, W, 30);
    // sun reflection
    ctx.fillStyle = 'rgba(255, 200, 130, 0.5)';
    ctx.fillRect(W - 200, baseY - 50, 60, 8);
    // palms
    for (let i = 0; i < 8; i++) {
      const x = ((i * 160) - (off % 160)) - 80;
      ctx.fillStyle = '#5a3a1f';
      ctx.fillRect(x + 20, baseY - 90, 6, 90);
      ctx.fillStyle = '#2d7a3a';
      ctx.beginPath();
      ctx.ellipse(x + 23, baseY - 90, 40, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x + 23, baseY - 80, 30, 8, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawGround(biome) {
    ctx.fillStyle = biome.ground;
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    // road
    ctx.fillStyle = '#222';
    ctx.fillRect(0, GROUND_Y + 10, W, 60);
    // dashed center line, scrolls with distance
    ctx.fillStyle = '#f5d76e';
    const dashW = 50;
    const gap = 30;
    const cycle = dashW + gap;
    const offset = state.distance % cycle;
    for (let x = -offset; x < W; x += cycle) {
      ctx.fillRect(x, GROUND_Y + 38, dashW, 5);
    }
  }

  // ============================================================
  // RENDER — entities
  // ============================================================
  function drawPlayer() {
    const { y, ducking, jumping } = state.player;
    const w = 70;
    const h = ducking ? 30 : 50;
    const x = PLAYER_X;
    const top = y - h + 10;

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    const shadowScale = jumping ? 0.6 : 1.0;
    ctx.ellipse(x + w / 2, GROUND_Y + 15, w / 2 * shadowScale, 6 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();

    // car body (red convertible)
    ctx.fillStyle = '#d63a3a';
    ctx.fillRect(x, top + 12, w, h - 12);
    // hood slope
    ctx.beginPath();
    ctx.moveTo(x + w - 14, top + 12);
    ctx.lineTo(x + w, top + 12);
    ctx.lineTo(x + w, top + 20);
    ctx.closePath();
    ctx.fill();
    // windshield
    ctx.fillStyle = '#7ec0e8';
    ctx.fillRect(x + 18, top, 32, 14);
    // driver (head)
    ctx.fillStyle = '#f4c891';
    ctx.beginPath();
    ctx.arc(x + 34, top + 6, 5, 0, Math.PI * 2);
    ctx.fill();
    // wheels
    ctx.fillStyle = '#111';
    const wheelY = top + h - 4;
    ctx.beginPath();
    ctx.arc(x + 14, wheelY, 9, 0, Math.PI * 2);
    ctx.arc(x + w - 14, wheelY, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#999';
    ctx.beginPath();
    ctx.arc(x + 14, wheelY, 3, 0, Math.PI * 2);
    ctx.arc(x + w - 14, wheelY, 3, 0, Math.PI * 2);
    ctx.fill();
    // headlight
    ctx.fillStyle = '#fff8a8';
    ctx.fillRect(x + w - 6, top + 18, 6, 6);
  }

  function drawObstacles() {
    for (const o of state.obstacles) {
      if (o.type === 'pothole') {
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath();
        ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (o.type === 'cone') {
        ctx.fillStyle = '#e85a1a';
        ctx.beginPath();
        ctx.moveTo(o.x + o.w / 2, o.y);
        ctx.lineTo(o.x + o.w + 4, o.y + o.h);
        ctx.lineTo(o.x - 4, o.y + o.h);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillRect(o.x - 2, o.y + o.h - 12, o.w + 4, 4);
      } else if (o.type === 'sign') {
        // post
        ctx.fillStyle = '#666';
        ctx.fillRect(o.x + o.w / 2 - 2, o.y + 40, 4, o.h - 40);
        // sign
        ctx.fillStyle = '#d63a3a';
        ctx.fillRect(o.x - 30, o.y, 78, 40);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('STOP', o.x + 9, o.y + 20);
      }
    }
  }

  function drawCollectibles() {
    for (const c of state.collectibles) {
      if (c.type === 'fuel') {
        ctx.fillStyle = '#3a7a3a';
        ctx.fillRect(c.x, c.y, c.w, c.h);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('F', c.x + c.w / 2, c.y + c.h / 2);
      } else {
        ctx.fillStyle = '#f5d76e';
        ctx.fillRect(c.x, c.y, c.w, c.h);
        ctx.fillStyle = '#a86a1a';
        ctx.font = 'bold 14px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('$', c.x + c.w / 2, c.y + c.h / 2);
      }
    }
  }

  function drawParticles() {
    for (const p of state.particles) {
      ctx.globalAlpha = Math.max(0, p.life / 0.5);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }

  // ============================================================
  // RENDER — HUD
  // ============================================================
  function drawHUD(biome) {
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, W, 36);
    ctx.fillStyle = '#f5d76e';
    ctx.fillText(`SCORE  ${pad(state.score, 6)}`, 16, 10);
    ctx.fillText(`BIOME  ${biome.name}`, 220, 10);
    ctx.fillText(`MPH    ${Math.round(state.speed * 12)}`, 420, 10);

    // fuel bar
    ctx.fillStyle = '#e8e8e8';
    ctx.fillText('FUEL', 580, 10);
    ctx.strokeStyle = '#e8e8e8';
    ctx.lineWidth = 2;
    ctx.strokeRect(630, 10, 160, 16);
    const f = Math.max(0, state.fuel) / FUEL_MAX;
    ctx.fillStyle = f > 0.5 ? '#7ee27e' : f > 0.25 ? '#f5d76e' : '#e85a1a';
    ctx.fillRect(632, 12, 156 * f, 12);

    // trip progress bar
    ctx.fillStyle = '#e8e8e8';
    ctx.fillText('TRIP', 810, 10);
    ctx.strokeRect(810, 28, 140, 6);
    ctx.fillStyle = '#7ec3e8';
    ctx.fillRect(812, 30, 136 * Math.min(1, state.distance / TRIP_TOTAL), 2);

    if (state.flashTimer > 0) {
      ctx.fillStyle = `rgba(255, 80, 80, ${state.flashTimer * 1.5})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function pad(n, w) {
    const s = String(Math.floor(n));
    return s.length >= w ? s : '0'.repeat(w - s.length) + s;
  }

  // ============================================================
  // RENDER — overlay screens
  // ============================================================
  function drawTitle() {
    drawSceneIdle();
    drawCenterPanel(560, 360);
    ctx.fillStyle = '#f5d76e';
    ctx.font = 'bold 44px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WEEKEND ROAD TRIP', W / 2, 130);

    ctx.fillStyle = '#e8e8e8';
    ctx.font = '16px "Courier New", monospace';
    wrap(
      "Marty's been heads-down shipping for 11 months. Today his PTO finally cleared. " +
      "Pile in the convertible, dodge potholes and stop signs, grab fuel & roadside snacks — " +
      "city, forest, desert, coast. Don't run out of gas before the ocean.",
      W / 2, 190, 460, 20
    );

    ctx.fillStyle = '#7ec3e8';
    ctx.font = 'bold 18px "Courier New", monospace';
    ctx.fillText('PRESS  ENTER  TO  DRIVE', W / 2, 360);
    ctx.fillStyle = '#a0a0c0';
    ctx.font = '14px "Courier New", monospace';
    ctx.fillText('[H] HIGH SCORES    [?] CONTROLS', W / 2, 395);
  }

  function drawPaused() {
    drawCenterPanel(420, 220);
    ctx.fillStyle = '#f5d76e';
    ctx.font = 'bold 36px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PAUSED', W / 2, 230);
    ctx.fillStyle = '#e8e8e8';
    ctx.font = '16px "Courier New", monospace';
    ctx.fillText('PRESS P OR ENTER TO RESUME', W / 2, 290);
    ctx.fillStyle = '#a0a0c0';
    ctx.fillText('[Q] QUIT TO TITLE', W / 2, 320);
  }

  function drawGameOver() {
    drawCenterPanel(480, 280);
    ctx.fillStyle = '#e85a1a';
    ctx.font = 'bold 36px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('OUT OF GAS', W / 2, 200);
    ctx.fillStyle = '#e8e8e8';
    ctx.font = '16px "Courier New", monospace';
    const pct = Math.round((state.distance / TRIP_TOTAL) * 100);
    ctx.fillText(`You made it ${pct}% of the way.`, W / 2, 250);
    ctx.fillStyle = '#f5d76e';
    ctx.font = 'bold 22px "Courier New", monospace';
    ctx.fillText(`FINAL SCORE  ${pad(state.score, 6)}`, W / 2, 290);
    ctx.fillStyle = '#7ec3e8';
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.fillText('PRESS ENTER TO CONTINUE', W / 2, 340);
  }

  function drawWin() {
    drawCenterPanel(560, 320);
    ctx.fillStyle = '#7ee27e';
    ctx.font = 'bold 36px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('YOU MADE IT!', W / 2, 180);
    ctx.fillStyle = '#e8e8e8';
    ctx.font = '16px "Courier New", monospace';
    wrap(
      "Marty pulls the convertible up to the boardwalk. The Atlantic stretches out in front of him. " +
      "He turns off the engine, takes a breath, and reaches for his sunglasses.",
      W / 2, 220, 460, 20
    );
    ctx.fillStyle = '#f5d76e';
    ctx.font = 'bold 22px "Courier New", monospace';
    ctx.fillText(`FINAL SCORE  ${pad(state.score, 6)}`, W / 2, 320);
    ctx.fillStyle = '#7ec3e8';
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.fillText('PRESS ENTER TO CONTINUE', W / 2, 360);
  }

  function drawInitials() {
    drawCenterPanel(480, 280);
    ctx.fillStyle = '#f5d76e';
    ctx.font = 'bold 28px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NEW HIGH SCORE!', W / 2, 180);

    ctx.fillStyle = '#e8e8e8';
    ctx.font = '14px "Courier New", monospace';
    ctx.fillText(`SCORE  ${pad(state.pendingScore, 6)}`, W / 2, 215);
    ctx.fillText('ENTER YOUR INITIALS', W / 2, 240);

    ctx.font = 'bold 56px "Courier New", monospace';
    for (let i = 0; i < 3; i++) {
      const x = W / 2 - 80 + i * 80;
      ctx.fillStyle = i === state.initialsIdx ? '#f5d76e' : '#e8e8e8';
      ctx.fillText(state.initials[i], x, 310);
      if (i === state.initialsIdx) {
        ctx.fillStyle = '#f5d76e';
        ctx.fillRect(x - 22, 350, 44, 3);
      }
    }
    ctx.fillStyle = '#a0a0c0';
    ctx.font = '12px "Courier New", monospace';
    ctx.fillText('← → SELECT    ↑ ↓ CHANGE    A-Z TYPE    ENTER SUBMIT', W / 2, 380);
  }

  function drawScores() {
    drawCenterPanel(560, 380);
    ctx.fillStyle = '#f5d76e';
    ctx.font = 'bold 32px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HIGH SCORES', W / 2, 140);

    ctx.font = '18px "Courier New", monospace';
    if (state.scores.length === 0) {
      ctx.fillStyle = '#a0a0c0';
      ctx.fillText('NO SCORES YET — HIT THE ROAD.', W / 2, 240);
    } else {
      ctx.textAlign = 'left';
      for (let i = 0; i < state.scores.length; i++) {
        const s = state.scores[i];
        const y = 200 + i * 36;
        ctx.fillStyle = '#e8e8e8';
        ctx.fillText(`${i + 1}.`, W / 2 - 180, y);
        ctx.fillStyle = '#f5d76e';
        ctx.fillText(s.initials, W / 2 - 130, y);
        ctx.fillStyle = '#e8e8e8';
        ctx.fillText(pad(s.score, 6), W / 2 - 30, y);
        ctx.fillStyle = '#a0a0c0';
        ctx.font = '14px "Courier New", monospace';
        ctx.fillText(s.date, W / 2 + 90, y);
        ctx.font = '18px "Courier New", monospace';
      }
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7ec3e8';
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.fillText('PRESS ENTER TO RETURN', W / 2, 460);
  }

  function drawHelp() {
    drawCenterPanel(520, 340);
    ctx.fillStyle = '#f5d76e';
    ctx.font = 'bold 28px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CONTROLS', W / 2, 150);

    const lines = [
      ['SPACE / W / ↑', 'JUMP'],
      ['S / ↓', 'DUCK (hold to slide under signs)'],
      ['D / →', 'ACCELERATE'],
      ['A / ←', 'BRAKE'],
      ['P / ESC', 'PAUSE'],
      ['ENTER', 'CONFIRM / CONTINUE'],
      ['?', 'TOGGLE THIS HELP']
    ];
    ctx.font = '14px "Courier New", monospace';
    ctx.textAlign = 'left';
    for (let i = 0; i < lines.length; i++) {
      const y = 200 + i * 28;
      ctx.fillStyle = '#f5d76e';
      ctx.fillText(lines[i][0], W / 2 - 160, y);
      ctx.fillStyle = '#e8e8e8';
      ctx.fillText(lines[i][1], W / 2 - 20, y);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7ec3e8';
    ctx.fillText('PRESS ? OR ENTER TO CLOSE', W / 2, 440);
  }

  function drawCenterPanel(w, h) {
    const x = (W - w) / 2;
    const y = (H - h) / 2;
    ctx.fillStyle = 'rgba(20, 20, 40, 0.92)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#f5d76e';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
  }

  function drawSceneIdle() {
    const biome = BIOMES[0];
    drawSky(biome);
    drawFarLayer(biome, 0);
    drawCityMid(0);
    drawGround(biome);
  }

  function wrap(text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';
    for (const word of words) {
      const test = line + word + ' ';
      if (ctx.measureText(test).width > maxWidth && line.length > 0) {
        ctx.fillText(line.trim(), x, y);
        line = word + ' ';
        y += lineHeight;
      } else {
        line = test;
      }
    }
    ctx.fillText(line.trim(), x, y);
  }

  // ============================================================
  // UTIL
  // ============================================================
  function shade(hex, amt) {
    // amt in [-1, 1]; -1 = black, +1 = white
    const c = hex.replace('#', '');
    let r = parseInt(c.slice(0, 2), 16);
    let g = parseInt(c.slice(2, 4), 16);
    let b = parseInt(c.slice(4, 6), 16);
    if (amt < 0) {
      r = Math.round(r * (1 + amt));
      g = Math.round(g * (1 + amt));
      b = Math.round(b * (1 + amt));
    } else {
      r = Math.round(r + (255 - r) * amt);
      g = Math.round(g + (255 - g) * amt);
      b = Math.round(b + (255 - b) * amt);
    }
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ============================================================
  // MAIN LOOP
  // ============================================================
  function tick(time) {
    const dt = Math.min(0.05, (time - state.lastTime) / 1000 || 0);
    state.lastTime = time;

    if (state.screen === SCREEN.PLAYING) {
      // input affecting speed
      if (state.keys.has('KeyD') || state.keys.has('ArrowRight')) {
        state.speed = Math.min(MAX_SPEED, state.speed + SPEED_ACCEL);
      } else if (state.keys.has('KeyA') || state.keys.has('ArrowLeft')) {
        state.speed = Math.max(BASE_SPEED * 0.6, state.speed - SPEED_BRAKE);
      } else {
        // drift toward base speed
        if (state.speed > BASE_SPEED) state.speed -= 0.02;
        else if (state.speed < BASE_SPEED) state.speed += 0.02;
      }

      updatePlayer(dt);
      updateWorld(dt);
      updateParticles(dt);

      state.distance += state.speed * dt * 60;
      state.score += Math.round(state.speed * dt * 10);
      state.fuel -= FUEL_DRAIN_PER_SEC * dt;
      state.flashTimer = Math.max(0, state.flashTimer - dt);

      // win
      if (state.distance >= TRIP_TOTAL) {
        state.screen = SCREEN.WIN;
      }
      // lose
      if (state.fuel <= 0) {
        state.fuel = 0;
        state.screen = SCREEN.GAMEOVER;
      }
    }

    render();
    requestAnimationFrame(tick);
  }

  function render() {
    const biome = currentBiome();
    drawSky(biome);
    drawParallax(biome);
    drawGround(biome);

    if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) {
      drawCollectibles();
      drawObstacles();
      drawPlayer();
      drawParticles();
      drawHUD(biome);
    }

    if (state.screen === SCREEN.TITLE) drawTitle();
    else if (state.screen === SCREEN.PAUSED) drawPaused();
    else if (state.screen === SCREEN.GAMEOVER) drawGameOver();
    else if (state.screen === SCREEN.WIN) drawWin();
    else if (state.screen === SCREEN.INITIALS) drawInitials();
    else if (state.screen === SCREEN.SCORES) drawScores();
    else if (state.screen === SCREEN.HELP) drawHelp();
  }

  // ============================================================
  // BOOT
  // ============================================================
  state.scores = loadScores();
  requestAnimationFrame(tick);
})();
