# Deployment — how this repo ships

Weekend Road Trip deploys three ways from one codebase, and every byte of the
deployed site lives in this repo — production can always be audited against
source control.

| Surface | URL | What it proves |
|---|---|---|
| **Vercel production** | https://weekend-road-trip-forrestw200.vercel.app | main branch, serverless APIs + Neon Postgres live |
| **Vercel previews** | one URL per open PR (see the PR checks tab) | feature branches are publicly testable before merge |
| **GitHub Pages** | https://fwwright1001-coder.github.io/weekend-road-trip/ | the same game degrades gracefully to localStorage when no API exists |

## The workflow, as actually lived

1. **Branch per feature.** Real example: `feat/feel-rework`
   ([PR #29](https://github.com/fwwright1001-coder/weekend-road-trip/pull/29) —
   a full game-feel overhaul).
2. **Push → Vercel builds a preview deployment automatically** and comments the
   URL on the PR. The feature is playable by anyone, on its own URL, without
   touching production.
3. **CI gates the merge.** Every push to `main` and every PR runs the same five
   deterministic checks as `npm test`:
   balance simulation (10 fairness/economy acceptance criteria), the in-game
   self-test harness run headlessly (19 checks), a DOM contract smoke, and two
   API/client contract suites covering the Neon cloud high-score path —
   including the static-hosting fallback.
4. **Merge to main → Vercel promotes to production** and GitHub Pages redeploys
   the static fallback. No manual steps, no Friday fear.

## Database (Neon Serverless Postgres)

One table, written through the Vercel serverless function in
[`api/highscores.js`](api/highscores.js), schema in
[`database/schema.sql`](database/schema.sql) (also auto-bootstrapped on first
use):

- `game_high_scores` — the cloud leaderboard. Only a short IP hash is stored,
  never the raw address. Finished runs save locally FIRST,
  then sync to Neon; a failed cloud write can never trap the player on a saving
  screen. The high-scores screen renders the live Neon board on Vercel.

On GitHub Pages or a local static server, high scores fall back to localStorage
and say so explicitly — tested by `qa/highscores-client-contract.js`.

The game collects no visitor data. An email signup form that was part of the
original class submission was removed in October 2026 (see
[CHANGELOG.md](CHANGELOG.md)).

## Reproduce the proof

```bash
npm test          # all five gates, exit 0 = shippable
node sim/balance-sim.js   # the fairness proof on its own
```

Env vars on Vercel: `DATABASE_URL` (Neon integration) and `IP_HASH_SECRET`.
Setup steps and submission evidence checklist: [VERCEL-NEON.md](VERCEL-NEON.md).
