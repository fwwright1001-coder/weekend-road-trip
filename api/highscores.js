'use strict';

const crypto = require('crypto');

const MAX_SCORE = 999999999;
const LIMIT = 5;

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
        CREATE TABLE IF NOT EXISTS game_high_scores (
          id bigserial PRIMARY KEY,
          initials text NOT NULL,
          score integer NOT NULL,
          source text NOT NULL DEFAULT 'weekend-road-trip',
          user_agent text,
          ip_hash text,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS game_high_scores_score_idx ON game_high_scores (score DESC, created_at ASC)`;
      await sql`CREATE INDEX IF NOT EXISTS game_high_scores_created_at_idx ON game_high_scores (created_at DESC)`;
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

function normalizeInitials(value) {
  const letters = clean(value, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (letters || 'AAA').slice(0, 3).padEnd(3, 'A');
}

function normalizeScore(body) {
  const input = body && typeof body === 'object' ? body : {};
  const numericScore = Number(input.score);
  const score = Number.isFinite(numericScore)
    ? Math.max(0, Math.min(MAX_SCORE, Math.floor(numericScore)))
    : null;
  return {
    initials: normalizeInitials(input.initials),
    score,
    source: clean(input.source, 80) || 'weekend-road-trip'
  };
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
  const pepper = process.env.IP_HASH_SECRET || 'weekend-road-trip-highscores';
  return crypto.createHash('sha256').update(`${pepper}:${ip}`).digest('hex').slice(0, 32);
}

function rateLimitOk(key) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = 20;
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
  if (typeof res.status === 'function') return res.status(statusCode).json(body);
  res.statusCode = statusCode;
  return res.end(JSON.stringify(body));
}

function formatRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    initials: normalizeInitials(row.initials),
    score: Math.max(0, Math.floor(Number(row.score) || 0)),
    date: String(row.created_at || row.date || new Date().toISOString()).slice(0, 10)
  })).slice(0, LIMIT);
}

async function topScores(sql) {
  const rows = await sql`
    SELECT initials, score, created_at
    FROM game_high_scores
    ORDER BY score DESC, created_at ASC
    LIMIT ${LIMIT}
  `;
  return formatRows(rows);
}

async function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') return send(res, 204, {});
  if (method !== 'GET' && method !== 'POST') {
    return send(res, 405, { ok: false, error: 'Method not allowed.' });
  }

  let payload = null;
  let ipHash = null;
  if (method === 'POST') {
    payload = normalizeScore(parseBody(req));
    if (payload.score == null) return send(res, 400, { ok: false, error: 'A numeric score is required.' });
    ipHash = hashIp(clientIp(req)) || hashIp(payload.initials);
    if (!rateLimitOk(ipHash || payload.initials)) {
      return send(res, 429, { ok: false, error: 'Too many score submissions. Try again shortly.' });
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
      return send(res, 200, { ok: true, scores: await topScores(sql) });
    } catch (e) {
      return send(res, 500, { ok: false, error: 'Database read failed.' });
    }
  }

  const userAgent = clean(header(req, 'user-agent'), 240);
  try {
    await sql`
      INSERT INTO game_high_scores (initials, score, source, user_agent, ip_hash)
      VALUES (${payload.initials}, ${payload.score}, ${payload.source}, ${userAgent || null}, ${ipHash})
    `;
    return send(res, 200, { ok: true, score: payload.score, initials: payload.initials, scores: await topScores(sql) });
  } catch (e) {
    return send(res, 500, { ok: false, error: 'Database write failed.' });
  }
}

module.exports = handler;
module.exports._test = {
  clean,
  clientIp,
  formatRows,
  hashIp,
  normalizeInitials,
  normalizeScore,
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
