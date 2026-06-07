/* ============================================================
 * Cloud high-score API contract test
 * Exercises the Vercel/Neon score layer without requiring DATABASE_URL.
 * ============================================================ */
'use strict';

const handler = require('../api/highscores.js');
const api = handler._test;

const checks = [];
let fail = 0;
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail: detail || '' });
  if (!pass) fail++;
};

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end(text) {
      try { this.body = text ? JSON.parse(text) : null; }
      catch (e) { this.body = text; }
      return this;
    }
  };
}

async function call(req) {
  const res = makeRes();
  await handler({ headers: {}, ...req }, res);
  return res;
}

function makeFakeSql() {
  const calls = [];
  const rows = [];
  const sql = async (strings, ...values) => {
    const text = Array.from(strings).join('?');
    calls.push({ text, values });
    if (/INSERT INTO game_high_scores/.test(text)) {
      rows.push({ initials: values[0], score: values[1], created_at: '2026-06-06T00:00:00.000Z' });
    }
    if (/SELECT initials, score, created_at/.test(text)) {
      return rows.slice().sort((a, b) => b.score - a.score).slice(0, 5);
    }
    return [];
  };
  return { calls, sql };
}

(async () => {
  check('normalizes initials', api.normalizeInitials(' f-w ') === 'FWA', api.normalizeInitials(' f-w '));
  const normalized = api.normalizeScore({ initials: ' fw ', score: '1234.8', source: ' class demo ' });
  check('normalizes score initials', normalized.initials === 'FWA', normalized.initials);
  check('floors numeric score', normalized.score === 1234, String(normalized.score));
  check('keeps source', normalized.source === 'class demo', normalized.source);
  check('bad score becomes null', api.normalizeScore({ score: 'nope' }).score === null);

  const ip = api.clientIp({ headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.2' } });
  const hash = api.hashIp(ip);
  check('client IP reads first forwarded address', ip === '203.0.113.10', ip);
  check('IP hash does not expose raw IP', typeof hash === 'string' && hash.length === 32 && !hash.includes('203'), hash);

  const parsed = api.parseBody({ body: '{"initials":"FW","score":9001}' });
  check('parses JSON string body', parsed.score === 9001, JSON.stringify(parsed));
  check('bad JSON body becomes empty object', Object.keys(api.parseBody({ body: '{bad' })).length === 0);

  const methodRes = await call({ method: 'PUT' });
  check('unsupported methods return 405', methodRes.statusCode === 405, String(methodRes.statusCode));

  const invalidPostRes = await call({ method: 'POST', body: { initials: 'FW', score: 'bad' } });
  check('invalid POST returns 400 before database work', invalidPostRes.statusCode === 400, String(invalidPostRes.statusCode));

  const fake = makeFakeSql();
  api.setSqlForTest(fake.sql);
  const successRes = await call({
    method: 'POST',
    headers: {
      'x-forwarded-for': '203.0.113.44',
      'user-agent': 'contract-test'
    },
    body: {
      initials: 'FW',
      score: 9001,
      source: 'contract'
    }
  });
  check('successful POST returns 200', successRes.statusCode === 200, String(successRes.statusCode));
  check('successful POST normalizes returned initials', successRes.body.initials === 'FWA', JSON.stringify(successRes.body));
  check('successful POST returns top scores', Array.isArray(successRes.body.scores) && successRes.body.scores[0].score === 9001, JSON.stringify(successRes.body));
  check('schema bootstrap runs before write', fake.calls.some((c) => /CREATE TABLE IF NOT EXISTS game_high_scores/.test(c.text)));
  check('insert uses game_high_scores table', fake.calls.some((c) => /INSERT INTO game_high_scores/.test(c.text)));
  check('insert values include normalized initials', fake.calls.some((c) => c.values.includes('FWA')));

  const getRes = await call({ method: 'GET' });
  check('GET returns high-score list', getRes.statusCode === 200 && getRes.body.scores.length === 1, JSON.stringify(getRes.body));
  api.setSqlForTest(null);

  const savedEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    POSTGRES_URL: process.env.POSTGRES_URL,
    POSTGRES_PRISMA_URL: process.env.POSTGRES_PRISMA_URL,
    POSTGRES_URL_NON_POOLING: process.env.POSTGRES_URL_NON_POOLING
  };
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.POSTGRES_URL_NON_POOLING;
  const noDbRes = await call({ method: 'GET' });
  check('missing Neon env returns 503', noDbRes.statusCode === 503, String(noDbRes.statusCode));
  Object.entries(savedEnv).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });

  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? '  - ' + c.detail : ''));
  }
  console.log('\nCloud high-score API contract: ' + (checks.length - fail) + '/' + checks.length + ' passed.');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
