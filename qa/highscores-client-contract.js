/* ============================================================
 * Cloud high-score client contract
 * Exercises the game.js client helpers without booting the canvas loop.
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');

function extractFunction(name) {
  let start = source.indexOf(`async function ${name}`);
  if (start < 0) start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract function ${name}`);
}

function jsonResponse(status, body, delayMs) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        ok: status >= 200 && status < 300,
        status,
        async json() { return body; }
      });
    }, delayMs || 0);
  });
}

function createHarness({ hostname, protocol, fetchImpl }) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: { location: { hostname, protocol } },
    location: { hostname, protocol },
    fetch: fetchImpl
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`
    const MAX_SCORES = 5;
    const SCREEN = { SCORES: 'scores' };
    const state = {
      screen: SCREEN.SCORES,
      scores: [],
      cloudScores: null,
      cloudScoreStatus: '',
      cloudScoreWritePending: false
    };
    const renderCalls = [];
    function renderScoresList(options) { renderCalls.push(options || {}); }
    ${extractFunction('normalizeScoreEntry')}
    ${extractFunction('canUseCloudScores')}
    ${extractFunction('refreshCloudScores')}
    ${extractFunction('submitCloudScore')}
    globalThis.api = {
      state,
      renderCalls,
      canUseCloudScores,
      refreshCloudScores,
      submitCloudScore
    };
  `, sandbox, { filename: 'highscores-client-harness.js' });
  return sandbox.api;
}

const checks = [];
let fail = 0;
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail: detail || '' });
  if (!pass) fail++;
};

(async () => {
  {
    const calls = [];
    const h = createHarness({
      hostname: 'fwwright1001-coder.github.io',
      protocol: 'https:',
      fetchImpl: async (...args) => { calls.push(args); throw new Error('should not fetch on Pages'); }
    });
    check('GitHub Pages disables cloud scores', h.canUseCloudScores() === false);
    await h.submitCloudScore({ initials: 'FW', score: 1000, date: '2026-06-06' });
    check('GitHub Pages score save does not call fetch', calls.length === 0, `calls=${calls.length}`);
  }

  {
    const calls = [];
    const h = createHarness({
      hostname: 'weekend-road-trip.vercel.app',
      protocol: 'https:',
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts });
        return jsonResponse(200, {
          ok: true,
          scores: [{ initials: 'FW', score: 9001, date: '2026-06-06' }]
        });
      }
    });
    await h.submitCloudScore({ initials: 'fw', score: 9001.9, date: '2026-06-06' });
    const post = calls.find((call) => call.opts && call.opts.method === 'POST');
    check('Vercel score save posts to API', !!post && post.url === '/api/highscores', JSON.stringify(post));
    check('Vercel score save sends JSON body', !!post && JSON.parse(post.opts.body).source === 'weekend-road-trip-game', post && post.opts.body);
    check('Vercel score save renders returned Neon leaderboard', h.state.cloudScores[0].score === 9001, JSON.stringify(h.state.cloudScores));
    check('Vercel score save re-renders scores screen', h.renderCalls.some((call) => call.skipCloudRefresh === true), JSON.stringify(h.renderCalls));
  }

  {
    const h = createHarness({
      hostname: 'weekend-road-trip.vercel.app',
      protocol: 'https:',
      fetchImpl: async () => jsonResponse(503, { ok: false, error: 'Neon DATABASE_URL is not configured.' })
    });
    await h.submitCloudScore({ initials: 'DB', score: 100 });
    check('503 score save explains Neon setup', /DATABASE_URL/.test(h.state.cloudScoreStatus), h.state.cloudScoreStatus);
  }

  {
    const calls = [];
    const h = createHarness({
      hostname: 'weekend-road-trip.vercel.app',
      protocol: 'https:',
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts });
        if (opts && opts.method === 'POST') {
          return jsonResponse(200, {
            ok: true,
            scores: [{ initials: 'NEW', score: 5000, date: '2026-06-06' }]
          }, 5);
        }
        return jsonResponse(200, {
          ok: true,
          scores: [{ initials: 'OLD', score: 100, date: '2026-06-06' }]
        }, 20);
      }
    });
    const save = h.submitCloudScore({ initials: 'NEW', score: 5000, date: '2026-06-06' });
    const refresh = h.refreshCloudScores();
    await Promise.all([save, refresh]);
    check('GET refresh during POST does not overwrite saved score',
      h.state.cloudScores[0].initials === 'NEW',
      JSON.stringify({ scores: h.state.cloudScores, calls }));
  }

  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? '  - ' + c.detail : ''));
  }
  console.log('\nCloud high-score client contract: ' + (checks.length - fail) + '/' + checks.length + ' passed.');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
