/* ============================================================
 * DOM-contract smoke test  —  ENGR 5513 Weekend Road Trip
 * ============================================================
 * The physics sim (sim/balance-sim.js) proves the game is fair, and the
 * self-test harness (qa/run-selftests.js) proves persistence/settings/a11y
 * round-trip. Neither catches HTML/JS DRIFT: a screen id renamed in markup
 * but not in code (or vice-versa) boots fine in the Node shim yet renders a
 * blank screen in a real browser.
 *
 * This gate closes that gap with zero dependencies: every STATIC element id
 * that game.js looks up via getElementById / querySelector('#...') must exist
 * in index.html, and the structural anchors the engine cannot run without
 * (canvas, overlay, hud) must be present.
 *
 *   node qa/smoke-dom.js      // exit 0 = pass, 1 = a wiring contract is broken
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'game.js'), 'utf8');

// 1) Every id declared in the markup.
const htmlIds = new Set();
for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) htmlIds.add(m[1]);

// 2) Every STATIC id the game code looks up (string literals only; dynamically
//    built ids like 'screen-' + name can't be statically verified and are skipped).
const refs = new Set();
for (const m of js.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) refs.add(m[1]);
for (const m of js.matchAll(/querySelector(?:All)?\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/g)) refs.add(m[1]);

// 3) Structural anchors the engine cannot run without.
const required = ['game', 'overlay', 'hud'];

const checks = [];
let fail = 0;
const check = (name, pass, detail) => { checks.push({ name, pass, detail }); if (!pass) fail++; };

for (const id of required) {
  check('required element #' + id + ' present', htmlIds.has(id), htmlIds.has(id) ? '' : 'MISSING in index.html');
}

const missing = [...refs].filter((id) => !htmlIds.has(id));
check('every static element reference in game.js resolves to index.html',
      missing.length === 0,
      missing.length ? 'MISSING ids: ' + missing.join(', ') : refs.size + ' references resolve');

for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? '  — ' + c.detail : ''));
}
console.log('\nDOM-contract smoke: ' + (checks.length - fail) + '/' + checks.length +
            ' passed, ' + refs.size + ' element references checked.');
process.exit(fail === 0 ? 0 : 1);
