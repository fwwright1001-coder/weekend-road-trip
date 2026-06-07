# Vercel + Neon Assignment Proof

Weekend Road Trip remains playable on GitHub Pages, but this branch adds
Vercel-ready backend paths for the class deployment/database assignment.

## What Changed

- Title screen includes a compact **Road Crew** signup form.
- `api/waitlist.js` is a Vercel serverless function for `GET` count and `POST`
  signup writes.
- `api/highscores.js` is a Vercel serverless function for cloud game high scores.
- The API creates the Neon `email_signups` table automatically on first use.
- The high-score API creates the Neon `game_high_scores` table automatically on
  first use.
- Emails are validated, lowercased, and upserted so duplicate submissions update
  one row instead of creating junk records.
- Finished game runs still save local high scores, then sync to Neon on Vercel.
- Raw IP addresses are not stored; the API stores a short hash for light abuse
  protection.
- GitHub Pages falls back to localStorage because static Pages cannot run
  serverless API routes.

## Vercel Setup

1. Import `https://github.com/fwwright1001-coder/weekend-road-trip` into Vercel.
2. Add the Neon integration from Vercel Storage/Marketplace and connect it to
   this project.
3. In Vercel project settings, confirm one of these env vars exists:
   `DATABASE_URL`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, or
   `POSTGRES_URL_NON_POOLING`.
4. Add `IP_HASH_SECRET` with any long random string.
5. Deploy the branch, then open the Vercel preview URL.
6. Submit the Road Crew form once.
7. Finish a game run, enter initials, and open the high-score screen.
8. Open Neon, inspect tables, and verify:
   - `email_signups` has the submitted email row.
   - `game_high_scores` has the submitted initials/score row.

## Local Checks

```bash
npm test
```

Individual gates:

```bash
node sim/balance-sim.js
node qa/run-selftests.js
node qa/smoke-dom.js
node qa/waitlist-contract.js
node qa/highscores-contract.js
node qa/highscores-client-contract.js
node qa/launch-contract.js
npm run stress
```

## Submission Evidence

Use these proof points in Canvas:

- Vercel production URL.
- GitHub repository URL.
- Screenshot of the Weekend Road Trip title screen with Road Crew signup.
- Screenshot of Neon table `email_signups` after a test submission.
- Screenshot of the high-score screen on Vercel showing the cloud leaderboard.
- Screenshot of Neon table `game_high_scores` after a completed run.
- Test result: balance sim, self-tests, DOM smoke, Road Crew API contract, cloud
  high-score API/client contracts, and Road Crew client contract all passing.

## API Contract

- `GET /api/waitlist` returns `{ ok: true, count }`.
- `POST /api/waitlist` accepts:

```json
{
  "name": "Forrest Wright",
  "email": "forrest@example.com",
  "interest": "road-crew",
  "source": "weekend-road-trip-title"
}
```

- Successful writes return `{ ok: true, email, count }`.
- Missing Neon env vars return `503` with a clear setup message.

High scores:

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
