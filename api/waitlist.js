'use strict';

const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ALLOWED_INTERESTS = new Set([
  'road-crew',
  'ghost-race',
  'gta-sandbox',
  'daily-challenge',
  'class-demo'
]);

let cachedSql = null;
let schemaReady = false;
let schemaReadyPromise = null;
let testSql = null;
const rateBuckets = new Map();

function databaseUrl() {
  return process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    '';
}

async function getSql() {
  if (testSql) return testSql;
  const url = databaseUrl();
  if (!url) {
    const err = new Error('DATABASE_URL is not configured.');
    err.code = 'NO_DATABASE_URL';
    throw err;
  }
  if (!cachedSql) {
    const mod = await import('@neondatabase/serverless');
    cachedSql = mod.neon(url);
  }
  return cachedSql;
}

async function ensureSchema(sql) {
  if (schemaReady) return;
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS email_signups (
          id bigserial PRIMARY KEY,
          email text NOT NULL UNIQUE,
          name text,
          interest text NOT NULL DEFAULT 'road-crew',
          source text NOT NULL DEFAULT 'weekend-road-trip',
          score integer,
          user_agent text,
          ip_hash text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS email_signups_created_at_idx ON email_signups (created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS email_signups_interest_idx ON email_signups (interest)`;
      schemaReady = true;
    })().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  await schemaReadyPromise;
}

function clean(value, max) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

function normalizeSignup(body) {
  const input = body && typeof body === 'object' ? body : {};
  const email = clean(input.email, 120).toLowerCase();
  const name = clean(input.name, 80);
  const source = clean(input.source, 80) || 'weekend-road-trip';
  const requestedInterest = clean(input.interest, 40);
  const interest = ALLOWED_INTERESTS.has(requestedInterest) ? requestedInterest : 'road-crew';
  const numericScore = Number(input.score);
  const score = Number.isFinite(numericScore) ? Math.max(0, Math.round(numericScore)) : null;

  return { email, name, source, interest, score };
}

function parseBody(req) {
  if (!req || req.body == null) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return req.body;
}

function header(req, name) {
  if (!req || !req.headers) return '';
  return req.headers[name] || req.headers[name.toLowerCase()] || req.headers[name.toUpperCase()] || '';
}

function clientIp(req) {
  const forwarded = String(header(req, 'x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || String(header(req, 'x-real-ip') || '').trim();
}

function hashIp(ip) {
  if (!ip) return null;
  const pepper = process.env.IP_HASH_SECRET || 'weekend-road-trip-road-crew';
  return crypto.createHash('sha256').update(`${pepper}:${ip}`).digest('hex').slice(0, 32);
}

function rateLimitOk(key) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = 8;
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);

  for (const [bucketKey, value] of rateBuckets) {
    if (now > value.resetAt + windowMs) rateBuckets.delete(bucketKey);
  }

  return bucket.count <= limit;
}

function send(res, statusCode, body) {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
  }
  if (statusCode === 204) {
    if (typeof res.status === 'function') res.status(statusCode);
    else res.statusCode = statusCode;
    return typeof res.end === 'function' ? res.end() : res;
  }
  if (typeof res.status === 'function') {
    return res.status(statusCode).json(body);
  }
  res.statusCode = statusCode;
  return res.end(JSON.stringify(body));
}

async function countSignups(sql) {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM email_signups`;
  return Number(rows[0] && rows[0].count) || 0;
}

async function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') return send(res, 204, {});
  if (method !== 'GET' && method !== 'POST') {
    return send(res, 405, { ok: false, error: 'Method not allowed.' });
  }

  let signup = null;
  let ipHash = null;
  if (method === 'POST') {
    signup = normalizeSignup(parseBody(req));
    if (!isValidEmail(signup.email)) {
      return send(res, 400, { ok: false, error: 'A valid email address is required.' });
    }
    ipHash = hashIp(clientIp(req)) || hashIp(signup.email);
    if (!rateLimitOk(ipHash || signup.email)) {
      return send(res, 429, { ok: false, error: 'Too many signup attempts. Try again shortly.' });
    }
  }

  let sql;
  try {
    sql = await getSql();
    await ensureSchema(sql);
  } catch (e) {
    const status = e && e.code === 'NO_DATABASE_URL' ? 503 : 500;
    return send(res, status, {
      ok: false,
      error: status === 503 ? 'Neon DATABASE_URL is not configured.' : 'Database is unavailable.'
    });
  }

  if (method === 'GET') {
    try {
      const count = await countSignups(sql);
      return send(res, 200, { ok: true, count });
    } catch (e) {
      return send(res, 500, { ok: false, error: 'Database read failed.' });
    }
  }

  const userAgent = clean(header(req, 'user-agent'), 240);
  try {
    await sql`
      INSERT INTO email_signups (email, name, interest, source, score, user_agent, ip_hash)
      VALUES (${signup.email}, ${signup.name || null}, ${signup.interest}, ${signup.source},
              ${signup.score}, ${userAgent || null}, ${ipHash})
      ON CONFLICT (email) DO UPDATE SET
        name = COALESCE(NULLIF(EXCLUDED.name, ''), email_signups.name),
        interest = EXCLUDED.interest,
        source = EXCLUDED.source,
        score = COALESCE(EXCLUDED.score, email_signups.score),
        user_agent = EXCLUDED.user_agent,
        ip_hash = EXCLUDED.ip_hash,
        updated_at = now()
    `;
    const count = await countSignups(sql);
    return send(res, 200, { ok: true, email: signup.email, count });
  } catch (e) {
    return send(res, 500, { ok: false, error: 'Database write failed.' });
  }
}

module.exports = handler;
module.exports._test = {
  clean,
  clientIp,
  hashIp,
  isValidEmail,
  normalizeSignup,
  parseBody,
  rateLimitOk,
  setSqlForTest(sql) {
    testSql = sql || null;
    cachedSql = null;
    schemaReady = false;
    schemaReadyPromise = null;
    rateBuckets.clear();
  }
};
