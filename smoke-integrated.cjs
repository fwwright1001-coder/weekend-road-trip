/* smoke-integrated.cjs — integrator's headless visual proof (feat/visual-fidelity-3d).
   Serves THIS worktree on :8023 and walks the full integrated path:
   title boots clean -> START THE TRIP -> 5s of 2D play (screenshot) ->
   T => 3D chase active (#game3d visible, screenshot) -> T => seamless 2D ->
   P pause / P resume -> hands-off until the crash path reaches GAMEOVER ->
   Enter => score entry (INITIALS or SCORES). ZERO hard console errors required. */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) {
  try { ({ chromium } = require('playwright')); }
  catch (e2) { ({ chromium } = require('C:\\Users\\User\\CoworkProjects\\_wrt-shots\\node_modules\\playwright-core')); }
}

const PORT = 8023;
const URL = `http://localhost:${PORT}/index.html`;
const SHOTS = 'C:\\Users\\User\\CoworkProjects\\_wrt-fx-shots';

(async () => {
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

  const fail = (msg) => { console.error('FAIL:', msg); console.error('errors so far:', errors); process.exitCode = 1; };

  // 1) title boots clean (2D, RT3D pre-warmed but NOT enabled)
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500); // game.js boot + render3d.js CDN import + pre-warm
  const boot = await page.evaluate(() => ({
    rt3d: !!window.RT3D, ready: !!(window.RT3D && window.RT3D.ready),
    enabled: !!(window.RT3D && window.RT3D.enabled),
    screen: window.__roadtrip && window.__roadtrip.state.screen,
  }));
  console.log('boot   :', JSON.stringify(boot));
  if (boot.screen !== 'title') fail('did not boot to the title screen');
  if (!boot.rt3d || !boot.ready) fail('RT3D did not initialize (CDN/WebGL?)');
  if (boot.enabled) fail('3D must NOT be enabled on the title screen');

  // 2) start the run, 5s of 2D play (jump a couple of times to stay alive-ish)
  await page.click('button[data-action="start"]');
  await page.waitForTimeout(1700);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1700);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1600);
  const p2d = await page.evaluate(() => ({
    screen: window.__roadtrip.state.screen,
    cam: window.__roadtrip.state.cameraMode,
    enabled: window.RT3D.enabled,
    dist: Math.round(window.__roadtrip.state.distance),
  }));
  console.log('2d play:', JSON.stringify(p2d));
  if (p2d.screen !== 'playing') fail('run did not start / did not survive 5s of 2D');
  if (p2d.cam !== 'side' || p2d.enabled) fail('side camera should be the 2D renderer');
  await page.screenshot({ path: SHOTS + '\\integrated-2d.png' });

  // 3) T -> 3D chase crossfades in; 3s of play
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
  console.log('chase  :', JSON.stringify(chase));
  if (chase.cam !== 'chase') fail('T did not switch to the chase camera');
  if (!chase.enabled || !chase.active) fail('3D renderer not enabled in chase mode');
  if (chase.display === 'none' || Number(chase.opacity) < 0.99) fail('#game3d not fully visible after crossfade');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  const hold3d = await page.evaluate(() => ({
    enabled: window.RT3D.enabled, screen: window.__roadtrip.state.screen,
  }));
  console.log('3d hold:', JSON.stringify(hold3d));
  if (!hold3d.enabled && hold3d.screen === 'playing') fail('3D renderer crashed mid-drive (auto-fallback fired)');
  await page.screenshot({ path: SHOTS + '\\integrated-3d.png' });

  // 4) T -> seamless return to 2D
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
  console.log('back2d :', JSON.stringify(back));
  if (back.cam !== 'side' || back.enabled || back.active) fail('did not return cleanly to the 2D side camera');
  if (Number(back.opacity) > 0.01) fail('#game3d still visible after switching back');
  if (back.screen !== 'playing') fail('game stopped playing across the camera toggles');

  // 5) pause / resume still works (KeyP both ways)
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  const paused = await page.evaluate(() => window.__roadtrip.state.screen);
  console.log('paused :', paused);
  if (paused !== 'paused') fail('P did not pause');
  await page.screenshot({ path: SHOTS + '\\integrated-paused.png' });
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  const resumed = await page.evaluate(() => window.__roadtrip.state.screen);
  console.log('resumed:', resumed);
  if (resumed !== 'playing') fail('P did not resume');

  // 6) hands off -> crash path reaches GAMEOVER, Enter -> score entry
  let end = null;
  for (let i = 0; i < 60; i++) {            // up to ~90s of hands-off driving
    await page.waitForTimeout(1500);
    end = await page.evaluate(() => ({
      screen: window.__roadtrip.state.screen,
      score: Math.round(window.__roadtrip.state.score),
    }));
    if (end.screen !== 'playing') break;
  }
  console.log('end    :', JSON.stringify(end));
  if (end.screen !== 'gameover' && end.screen !== 'win') fail('run never reached gameover/win hands-off');
  await page.screenshot({ path: SHOTS + '\\integrated-gameover.png' });
  await page.keyboard.press('Enter');       // confirm -> afterRun() -> initials or scores
  await page.waitForTimeout(600);
  const entry = await page.evaluate(() => window.__roadtrip.state.screen);
  console.log('entry  :', entry);
  if (entry !== 'initials' && entry !== 'scores') fail('confirm did not reach score entry (initials/scores)');
  await page.screenshot({ path: SHOTS + '\\integrated-score-entry.png' });

  console.log('hard errors:', errors.length ? errors : 'none');
  if (errors.length) process.exitCode = 1;
  console.log('\nSMOKE-INTEGRATED:', process.exitCode ? 'FAIL' : 'PASS');
  await browser.close();
  server.kill();
})();
