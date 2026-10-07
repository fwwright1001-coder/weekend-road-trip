# Vercel + Neon Assignment Proof

Weekend Road Trip runs in production on Vercel
(https://weekend-road-trip-forrestw200.vercel.app) with Neon Postgres behind it;
GitHub Pages remains a static localStorage fallback. This doc covers the
Vercel/Neon backend path for the class deployment/database assignment.

## What the backend does

- `api/highscores.js` is a Vercel serverless function for cloud game high scores
  (`GET` the top five, `POST` a finished run).
- It creates the Neon `game_high_scores` table automatically on first use. The
  same table is documented in `database/schema.sql`.
- Finished game runs still save local high scores, then sync to Neon on Vercel.
- Raw IP addresses are not stored; the API stores a short hash for light abuse
  protection.
- GitHub Pages falls back to localStorage because static Pages cannot run
  serverless API routes.
- The game collects no visitor data. An email signup form that was part of the
  original submission was removed in October 2026 (see `CHANGELOG.md`).

## Vercel Setup

1. Import `https://github.com/fwwright1001-coder/weekend-road-trip` into Vercel.
2. Add the Neon integration from Vercel Storage/Marketplace and connect it to
   this project.
3. In Vercel project settings, confirm one of these env vars exists:
   `DATABASE_URL`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, or
   `POSTGRES_URL_NON_POOLING`.
4. Add `IP_HASH_SECRET` with any long random string.
5. Deploy the branch, then open the Vercel preview URL.
6. Finish a game run, enter initials, and open the high-score screen.
7. Open Neon, inspect tables, and verify that `game_high_scores` has the
   submitted initials/score row.

## Local Checks

```bash
npm test
```

Individual gates:

```bash
node sim/balance-sim.js
node qa/run-selftests.js
node qa/smoke-dom.js
node qa/highscores-contract.js
node qa/highscores-client-contract.js
```

## Submission Evidence

Use these proof points in Canvas:

- Vercel production URL.
- GitHub repository URL.
- Screenshot of the high-score screen on Vercel showing the cloud leaderboard.
- Screenshot of Neon table `game_high_scores` after a completed run.
- Test result: balance sim, self-tests, DOM smoke, and the cloud high-score
  API/client contracts all passing.

## API Contract

- `GET /api/highscores` returns `{ ok: true, scores }`.
- `POST /api/highscores` accepts:

```json
{
  "initials": "FW",
  "score": 9001,
  "source": "weekend-road-trip-game"
}
```

- Successful writes return `{ ok: true, initials, score, scores }`.
- Missing Neon env vars return `503` with a clear setup message.
