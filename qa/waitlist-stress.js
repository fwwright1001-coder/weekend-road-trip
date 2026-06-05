/* ============================================================
 * Road Crew API stress test
 * Runs the real Vercel handler with an in-memory SQL-tag fake so load behavior,
 * schema bootstrap, inserts/upserts, validation, and rate limiting are tested
 * without a Neon credential.
 * ============================================================ */
'use strict';

const handler = require('../api/waitlist.js');
const api = handler._test;

const TOTAL_VALID = Number(process.env.WRT_STRESS_VALID || 1200);
const TOTAL_INVALID = Number(process.env.WRT_STRESS_INVALID || 120);
const CONCURRENCY = Number(process.env.WRT_STRESS_CONCURRENCY || 40);

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

function fakeTableSql() {
  const rows = new Map();
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = Array.from(strings).join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });

    if (/INSERT INTO email_signups/.test(text)) {
      const [email, name, interest, source, score, userAgent, ipHash] = values;
      const now = new Date().toISOString();
      const existing = rows.get(email);
      rows.set(email, {
        id: existing ? existing.id : rows.size + 1,
        email,
        name: name || (existing && existing.name) || null,
        interest,
        source,
        score: score == null && existing ? existing.score : score,
        user_agent: userAgent,
        ip_hash: ipHash,
        created_at: existing ? existing.created_at : now,
        updated_at: now
      });
      return [];
    }

    if (/SELECT COUNT/.test(text)) return [{ count: rows.size }];
    return [];
  };
  return { sql, rows, calls };
}

async function pool(items, concurrency, worker) {
  let idx = 0;
  const results = [];
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

function summarize(statuses) {
  return statuses.reduce((acc, status) => {
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

(async () => {
  const fake = fakeTableSql();
  api.setSqlForTest(fake.sql);

  const validPayloads = Array.from({ length: TOTAL_VALID }, (_, i) => ({
    method: 'POST',
    headers: {
      'x-forwarded-for': `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`,
      'user-agent': 'waitlist-stress'
    },
    body: {
      email: `driver-${i}@example.com`,
      name: `Driver ${i}`,
      interest: i % 4 === 0 ? 'ghost-race' : 'road-crew',
      source: 'stress-test',
      score: i
    }
  }));

  const started = Date.now();
  const validResults = await pool(validPayloads, CONCURRENCY, call);
  const validMs = Date.now() - started;
  const validStatuses = validResults.map((res) => res.statusCode);
  const validSummary = summarize(validStatuses);

  const countRes = await call({ method: 'GET' });

  const duplicateResults = await pool(validPayloads.slice(0, 50).map((req, i) => ({
    ...req,
    headers: {
      ...req.headers,
      'x-forwarded-for': `203.0.113.${i + 1}`
    },
    body: { ...req.body, name: `Updated Driver ${i}`, source: 'stress-upsert' }
  })), 10, call);
  const rowsAfterDuplicate = fake.rows.size;

  const invalidResults = await pool(Array.from({ length: TOTAL_INVALID }, (_, i) => ({
    method: 'POST',
    headers: { 'x-forwarded-for': `192.0.2.${(i % 250) + 1}` },
    body: { email: `not-an-email-${i}` }
  })), 20, call);

  const rateLimitResults = [];
  for (let i = 0; i < 12; i++) {
    rateLimitResults.push(await call({
      method: 'POST',
      headers: { 'x-forwarded-for': '10.10.10.10' },
      body: { email: `rate-${i}@example.com`, source: 'rate-test' }
    }));
  }

  const schemaCreates = fake.calls.filter((c) => /CREATE TABLE IF NOT EXISTS email_signups/.test(c.text)).length;
  const insertCalls = fake.calls.filter((c) => /INSERT INTO email_signups/.test(c.text)).length;
  const countCalls = fake.calls.filter((c) => /SELECT COUNT/.test(c.text)).length;

  const checks = [
    ['all valid writes returned 200', validStatuses.every((s) => s === 200), JSON.stringify(validSummary)],
    ['GET count matches unique rows', countRes.statusCode === 200 && countRes.body.count === TOTAL_VALID,
      `status=${countRes.statusCode}, count=${countRes.body && countRes.body.count}`],
    ['upserts did not increase row count', duplicateResults.every((res) => res.statusCode === 200) && rowsAfterDuplicate === TOTAL_VALID,
      `rowsAfterDuplicate=${rowsAfterDuplicate}`],
    ['invalid emails returned 400', invalidResults.every((res) => res.statusCode === 400),
      JSON.stringify(summarize(invalidResults.map((res) => res.statusCode)))],
    ['rate limiter allows first 8 and blocks next 4',
      rateLimitResults.slice(0, 8).every((res) => res.statusCode === 200) &&
        rateLimitResults.slice(8).every((res) => res.statusCode === 429),
      JSON.stringify(rateLimitResults.map((res) => res.statusCode))],
    ['schema created once per warm handler', schemaCreates === 1, `schemaCreates=${schemaCreates}`],
    ['insert/upsert calls match accepted writes', insertCalls === TOTAL_VALID + 50 + 8,
      `insertCalls=${insertCalls}`],
    ['count queries ran for accepted writes plus explicit GET', countCalls === TOTAL_VALID + 50 + 8 + 1,
      `countCalls=${countCalls}`]
  ];

  let fail = 0;
  for (const [name, pass, detail] of checks) {
    if (!pass) fail++;
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + '  - ' + detail);
  }
  console.log(`\nRoad Crew stress: ${checks.length - fail}/${checks.length} passed.`);
  console.log(`Valid write load: ${TOTAL_VALID} requests at concurrency ${CONCURRENCY} in ${validMs}ms.`);
  console.log(`Final fake Neon rows: ${fake.rows.size}.`);

  api.setSqlForTest(null);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  api.setSqlForTest(null);
  console.error(err);
  process.exit(2);
});
