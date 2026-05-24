/*
 * Indy 500 — Weekend Road Trip
 * Three.js 3D racing build. ENGR 5513, Lipscomb MSAI, Summer 2026.
 *
 * Phases of the build (matches task list 3D-1 → 3D-6):
 *   1) Scaffold: Three.js scene + HTML overlay state machine (this file)
 *   2) Speedway scene: oval track, grandstands, infield
 *   3) IndyCar model + chase camera
 *   4) Driving physics + lap detection
 *   5) HUD wiring
 *   6) Visual polish
 */

import * as THREE from 'three';

// ============================================================
// CONFIG
// ============================================================
const STORAGE_KEY = 'wrt.highscores.v1';
const MAX_SCORES = 5;
const LAPS_TO_WIN = 5;
const FUEL_MAX = 100;

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
const state = {
  screen: SCREEN.TITLE,
  prevScreen: SCREEN.TITLE,
  keys: new Set(),
  // gameplay state — populated when a run starts
  lap: 1,
  lapStartTime: 0,
  lastLapTime: 0,
  bestLapTime: Infinity,
  score: 0,
  fuel: FUEL_MAX,
  speed: 0,
  // initials entry
  initials: ['A', 'A', 'A'],
  initialsIdx: 0,
  pendingScore: 0,
  // scores
  scores: [],
  // animation
  clock: null
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
    // localStorage unavailable — skip
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

// ============================================================
// THREE.JS SCENE
// ============================================================
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x88b8d8);
scene.fog = new THREE.Fog(0xa8c4d4, 200, 800);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.5, 2000);
camera.position.set(0, 8, 20);
camera.lookAt(0, 2, 0);

// Lights
const ambient = new THREE.HemisphereLight(0xffffff, 0x445566, 0.6);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff4dc, 1.3);
sun.position.set(80, 140, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -200;
sun.shadow.camera.right = 200;
sun.shadow.camera.top = 200;
sun.shadow.camera.bottom = -200;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 500;
scene.add(sun);

// Placeholder ground until 3D-2 builds the real track
const groundGeo = new THREE.PlaneGeometry(2000, 2000);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x3a6b3a, roughness: 0.95 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

state.clock = new THREE.Clock();

// ============================================================
// INPUT
// ============================================================
const KEYMAP = {
  throttle: ['Space', 'KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  boost: ['ShiftLeft', 'ShiftRight'],
  pause: ['KeyP', 'Escape'],
  help: ['Slash'],
  confirm: ['Enter']
};

function isAction(action, code) {
  return KEYMAP[action] && KEYMAP[action].includes(code);
}

window.addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
    e.preventDefault();
  }
  state.keys.add(e.code);
  handleKey(e.code);
});

window.addEventListener('keyup', (e) => {
  state.keys.delete(e.code);
});

function handleKey(code) {
  switch (state.screen) {
    case SCREEN.TITLE:
      if (isAction('confirm', code)) startRun();
      else if (code === 'KeyH') show(SCREEN.SCORES);
      else if (isAction('help', code)) showHelp();
      break;
    case SCREEN.PLAYING:
      if (isAction('pause', code)) show(SCREEN.PAUSED);
      else if (isAction('help', code)) showHelp();
      break;
    case SCREEN.PAUSED:
      if (isAction('pause', code) || isAction('confirm', code)) show(SCREEN.PLAYING);
      else if (code === 'KeyQ') show(SCREEN.TITLE);
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
  const code = c.charCodeAt(0);
  let next = code + dir;
  if (next > 90) next = 65;
  if (next < 65) next = 90;
  return String.fromCharCode(next);
}

// ============================================================
// SCREEN MACHINE — HTML overlay
// ============================================================
const overlayEl = document.getElementById('overlay');
const hudEl = document.getElementById('hud');
const screenEls = {
  [SCREEN.TITLE]: document.getElementById('screen-title'),
  [SCREEN.PAUSED]: document.getElementById('screen-paused'),
  [SCREEN.GAMEOVER]: document.getElementById('screen-gameover'),
  [SCREEN.WIN]: document.getElementById('screen-win'),
  [SCREEN.INITIALS]: document.getElementById('screen-initials'),
  [SCREEN.SCORES]: document.getElementById('screen-scores'),
  [SCREEN.HELP]: document.getElementById('screen-help')
};

function show(target) {
  if (state.screen !== SCREEN.HELP) state.prevScreen = state.screen;
  state.screen = target;
  applyScreen();
}

function applyScreen() {
  const inGame = state.screen === SCREEN.PLAYING;
  const overlayVisible = !inGame;

  // hide every screen, then show the right one
  for (const key in screenEls) {
    screenEls[key].classList.add('hidden');
  }
  if (screenEls[state.screen]) {
    screenEls[state.screen].classList.remove('hidden');
  }

  // overlay backdrop
  overlayEl.style.display = overlayVisible ? 'grid' : 'none';
  // HUD only during gameplay (and paused, so player sees their stats)
  if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) {
    hudEl.classList.remove('hidden');
  } else {
    hudEl.classList.add('hidden');
  }

  if (state.screen === SCREEN.SCORES) renderScoresList();
  if (state.screen === SCREEN.INITIALS) renderInitials();
}

function showHelp() {
  state.prevScreen = state.screen;
  state.screen = SCREEN.HELP;
  applyScreen();
}

// Button wiring (mouse/touch parity with keyboard)
document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    switch (action) {
      case 'start': startRun(); break;
      case 'scores': show(SCREEN.SCORES); break;
      case 'help': showHelp(); break;
      case 'resume': show(SCREEN.PLAYING); break;
      case 'quit': show(SCREEN.TITLE); break;
      case 'continue': afterRun(); break;
      case 'return': show(SCREEN.TITLE); break;
    }
  });
});

// ============================================================
// RUN LIFECYCLE
// ============================================================
function startRun() {
  state.lap = 1;
  state.lapStartTime = performance.now() / 1000;
  state.lastLapTime = 0;
  state.bestLapTime = Infinity;
  state.score = 0;
  state.fuel = FUEL_MAX;
  state.speed = 0;
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
    const li = document.createElement('li');
    li.className = 'empty';
    li.innerHTML = '<span class="empty">NO SCORES YET — HIT THE BRICKYARD.</span>';
    ol.appendChild(li);
    return;
  }
  state.scores.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="rank">${i + 1}.</span>` +
      `<span class="initials">${s.initials}</span>` +
      `<span class="score">${pad(s.score, 6)}</span>` +
      `<span class="date">${s.date}</span>`;
    ol.appendChild(li);
  });
}

function renderInitials() {
  const el = document.getElementById('initials-display');
  el.innerHTML = state.initials.map((c, i) => {
    const cls = i === state.initialsIdx ? 'initial active' : 'initial';
    return `<span class="${cls}">${c}</span>`;
  }).join('');
  document.getElementById('initials-score').textContent = pad(state.pendingScore, 6);
}

function pad(n, w) {
  const s = String(Math.floor(n));
  return s.length >= w ? s : '0'.repeat(w - s.length) + s;
}

// ============================================================
// MAIN LOOP
// ============================================================
function tick() {
  const dt = Math.min(0.05, state.clock.getDelta());

  if (state.screen === SCREEN.PLAYING) {
    // Driving update will go here in 3D-4
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// Window resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================
// BOOT
// ============================================================
state.scores = loadScores();
applyScreen();
requestAnimationFrame(tick);
