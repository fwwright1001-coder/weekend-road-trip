/* smoke-3d.cjs — headless visual proof for the T-key 3D chase mode (fx/3d).
   Serves THIS worktree on :8021 (start `python -m http.server 8021` first, or
   let this script spawn it), boots the title (2D), starts a run, captures a
   2D screenshot, presses T, asserts the #game3d canvas crossfades in with the
   Three.js renderer live, captures the 3D screenshot, presses T again and
   asserts a clean return to 2D — with ZERO hard console errors throughout. */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) {
  try { ({ chromium } = require('playwright')); }
  catch (e2) { ({ chromium } = require('C:\\Users\\User\\CoworkProjects\\_wrt-shots\\node_modules\\playwright-core')); }
}

const PORT = 8021;
const URL = `http://localhost:${PORT}/index.html`;
const SHOTS = 'C:\\Users\\User\\CoworkProjects\\_wrt-fx-shots';

(async () => {
  // serve the worktree (idempotent: dies with this process)
  const server = spawn('python', ['-m', 'http.server', String(PORT)], {
    cwd: path.resolve(__dirname), stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 1500));

  let browser, lastErr;
  for (const opt of [{ headless: true }, { headless: true, channel: 'msedge' }]) {
    try { browser = await chromium.launch(opt); break; } catch (e) { lastErr = e; }
  }
  if (!browser) { console.error('LAUNCH FAIL:', lastErr && lastErr.message); server.kill(); process.exit(3); }
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));

  const fail = (msg) => { console.error('FAIL:', msg); console.error('errors:', errors); process.exitCode = 1; };

  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500); // let game.js boot + render3d.js import THREE + pre-warm

  // 1) title screen is 2D
  const boot = await page.evaluate(() => ({
    rt3d: !!window.RT3D, ready: !!(window.RT3D && window.RT3D.ready),
    enabled: !!(window.RT3D && window.RT3D.enabled),
    screen: window.__roadtrip && window.__roadtrip.state.screen,
  }));
  console.log('boot:', JSON.stringify(boot));
  if (!boot.rt3d || !boot.ready) fail('RT3D did not initialize (CDN/WebGL?)');
  if (boot.enabled) fail('3D must NOT be enabled on the title screen');

  // 2) start a run (still 2D side camera)
  await page.click('button[data-action="start"]');
  await page.waitForTimeout(1800); // a bit of driving so the road is populated
  const playing = await page.evaluate(() => ({
    screen: window.__roadtrip.state.screen,
    cam: window.__roadtrip.state.cameraMode,
    enabled: window.RT3D.enabled,
  }));
  console.log('playing:', JSON.stringify(playing));
  if (playing.screen !== 'playing') fail('run did not start');
  if (playing.cam !== 'side' || playing.enabled) fail('side camera should be 2D');
  await page.screenshot({ path: SHOTS + '\\3d-toggle-before.png' });

  // 3) press T -> chase camera -> 3D crossfades in
  await page.keyboard.press('t');
  await page.waitForTimeout(500);
  const chase = await page.evaluate(() => {
    const c3d = document.getElementById('game3d');
    const cs = getComputedStyle(c3d);
    return {
      cam: window.__roadtrip.state.cameraMode,
      enabled: window.RT3D.enabled,
      active: c3d.classList.contains('rt3d-active'),
      opacity: cs.opacity, display: cs.display,
    };
  });
  console.log('chase:', JSON.stringify(chase));
  if (chase.cam !== 'chase') fail('T did not switch to chase camera');
  if (!chase.enabled || !chase.active) fail('3D renderer not enabled in chase mode');
  if (chase.display === 'none' || Number(chase.opacity) < 0.99) fail('#game3d not fully visible after crossfade');
  await page.waitForTimeout(900); // drive a little in 3D (obstacles/semis populate)
  await page.screenshot({ path: SHOTS + '\\3d-mode.png' });

  // 4) press T again -> seamless return to 2D
  await page.keyboard.press('t');
  await page.waitForTimeout(450);
  const back = await page.evaluate(() => {
    const c3d = document.getElementById('game3d');
    return {
      cam: window.__roadtrip.state.cameraMode,
      enabled: window.RT3D.enabled,
      active: c3d.classList.contains('rt3d-active'),
      opacity: getComputedStyle(c3d).opacity,
      screen: window.__roadtrip.state.screen,
    };
  });
  console.log('back:', JSON.stringify(back));
  if (back.cam !== 'side' || back.enabled || back.active) fail('did not return to 2D side camera');
  if (Number(back.opacity) > 0.01) fail('#game3d still visible after switching back');
  if (back.screen !== 'playing') fail('game stopped playing during toggles');
  await page.screenshot({ path: SHOTS + '\\2d-after.png' });

  // 5) toggle back to 3D once more and hold — stability + biome blend check
  await page.keyboard.press('t');
  await page.waitForTimeout(2200);
  const hold = await page.evaluate(() => ({
    enabled: window.RT3D.enabled,
    screen: window.__roadtrip.state.screen,
    dist: Math.round(window.__roadtrip.state.distance),
  }));
  console.log('hold:', JSON.stringify(hold));
  if (!hold.enabled && hold.screen === 'playing') fail('3D renderer crashed while driving (fell back to 2D)');
  await page.screenshot({ path: SHOTS + '\\3d-chase-hold.png' });

  console.log('hard errors:', errors.length ? errors : 'none');
  if (errors.length) process.exitCode = 1;
  console.log('\nSMOKE-3D:', process.exitCode ? 'FAIL' : 'PASS');
  await browser.close();
  server.kill();
})();
