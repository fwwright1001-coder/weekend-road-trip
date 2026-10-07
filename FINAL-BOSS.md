# Final Boss Submission Checklist

This repo covers Stage 5 of the final assignment: deploy the previous game to
Vercel and store game data in Neon.

## What to Show

1. Vercel project screen with production and preview deployments for the game.
2. Weekend Road Trip running from the Vercel production URL.
3. Completed game run with initials entered.
4. High-score screen showing cloud scores on Vercel.
5. Neon `game_high_scores` table after the run.
6. Local `npm test` output passing all gates.

## Required Environment

Set these in Vercel Project Settings:

```text
DATABASE_URL=<Neon pooled connection string>
IP_HASH_SECRET=<any long random string>
```

The API also accepts Vercel/Neon's common `POSTGRES_URL`,
`POSTGRES_PRISMA_URL`, and `POSTGRES_URL_NON_POOLING` names.

## Local Verification

```bash
npm test
```

That runs the balance proof, self-tests, HTML/JS wiring smoke test, and the
cloud high-score API/client contracts.

## Safety Note

The former experimental 3D prototype has been removed from the current
submission branch. The graded game is the 2D Nashville cruise driver with Ghost
Race and cloud high scores. The email signup form that was part of the original
submission was removed in October 2026.
