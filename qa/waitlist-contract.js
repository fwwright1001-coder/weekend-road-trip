/* ============================================================
 * Road Crew API contract test
 * Exercises the Vercel/Neon signup layer without requiring DATABASE_URL.
 * ============================================================ */
'use strict';

const handler = require('../api/waitlist.js');
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
  let count = 0;
  const sql = async (strings, ...values) => {
    const text = Array.from(strings).join('?');
    calls.push({ text, values });
    if (/INSERT INTO email_signups/.test(text)) count = Math.max(1, count);
    if (/SELECT COUNT/.test(text)) return [{ count }];
    return [];
  };
  return { calls, sql };
}

(async () => {
  const normalized = api.normalizeSignup({
    email: '  FORREST@Example.COM ',
    name: '  Forrest   Wright  ',
    interest: 'gta-sandbox',
    source: ' class demo ',
    score: '42.4'
  });
  check('normalizes email to lowercase', normalized.email === 'forrest@example.com', normalized.email);
  check('collapses name whitespace', normalized.name === 'Forrest Wright', normalized.name);
  check('keeps allowed interest', normalized.interest === 'gta-sandbox', normalized.interest);
  check('rounds numeric score', normalized.score === 42, String(normalized.score));

  const fallback = api.normalizeSignup({ email: 'a@b.com', interest: 'bogus' });
  check('unknown interest falls back safely', fallback.interest === 'road-crew', fallback.interest);
  check('valid email accepted', api.isValidEmail('driver@example.com'));
  check('invalid email rejected', !api.isValidEmail('driver.example.com'));

  const ip = api.clientIp({ headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.2' } });
  const hash = api.hashIp(ip);
  check('client IP reads first forwarded address', ip === '203.0.113.10', ip);
  check('IP hash does not expose raw IP', typeof hash === 'string' && hash.length === 32 && !hash.includes('203'), hash);

  const parsed = api.parseBody({ body: '{"email":"road@example.com"}' });
  check('parses JSON string body', parsed.email === 'road@example.com', JSON.stringify(parsed));
  check('bad JSON body becomes empty object', Object.keys(api.parseBody({ body: '{bad' })).length === 0);

  const methodRes = await call({ method: 'PUT' });
  check('unsupported methods return 405', methodRes.statusCode === 405, String(methodRes.statusCode));

  const invalidPostRes = await call({ method: 'POST', body: { email: 'bad-email' } });
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
      email: ' Road.Driver@Example.com ',
      name: ' Road   Driver ',
      interest: 'road-crew',
      source: 'contract'
    }
  });
  check('successful POST returns 200', successRes.statusCode === 200, String(successRes.statusCode));
  check('successful POST normalizes returned email', successRes.body.email === 'road.driver@example.com', JSON.stringify(successRes.body));
  check('successful POST returns live count', successRes.body.count === 1, JSON.stringify(successRes.body));
  check('schema bootstrap runs before write', fake.calls.some((c) => /CREATE TABLE IF NOT EXISTS email_signups/.test(c.text)));
  check('insert uses email_signups table', fake.calls.some((c) => /INSERT INTO email_signups/.test(c.text)));
  check('insert values include normalized email', fake.calls.some((c) => c.values.includes('road.driver@example.com')));
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
  console.log('\nRoad Crew API contract: ' + (checks.length - fail) + '/' + checks.length + ' passed.');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
