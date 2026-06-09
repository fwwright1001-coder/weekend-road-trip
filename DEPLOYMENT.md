# Deployment — how this repo ships

Weekend Road Trip deploys three ways from one codebase, and every byte of the
deployed site lives in this repo — production can always be audited against
source control.

| Surface | URL | What it proves |
|---|---|---|
| **Vercel production** | https://weekend-road-trip-forrestw200.vercel.app | main branch, serverless APIs + Neon Postgres live |
| **Vercel previews** | one URL per open PR (see the PR checks tab) | feature branches are publicly testable before merge |
| **GitHub Pages** | https://fwwright1001-coder.github.io/weekend-road-trip/ | the same game degrades gracefully to localStorage when no API exists |
| **Road Crew landing** | https://weekend-road-trip-forrestw200.vercel.app/waitlist | standalone signup page with a live Neon-backed counter |

## The workflow, as actually lived

1. **Branch per feature.** Real examples: `feat/feel-rework`
   ([PR #29](https://github.com/fwwright1001-coder/weekend-road-trip/pull/29) —
   a full game-feel overhaul) and `feat/road-crew-landing`
   ([PR #30](https://github.com/fwwright1001-coder/weekend-road-trip/pull/30) —
   this landing page).
2. **Push → Vercel builds a preview deployment automatically** and comments the
   URL on the PR. The feature is playable by anyone, on its own URL, without
   touching production.
3. **CI gates the merge.** Every push and PR runs the same seven deterministic
   checks as `npm test`:
   balance simulation (10 fairness/economy acceptance criteria), the in-game
   self-test harness run headlessly (19 checks), a DOM contract smoke, and four
   API/client contract suites covering the Neon waitlist and cloud high-score
   paths — including the static-hosting fallbacks.
4. **Merge to main → Vercel promotes to production** and GitHub Pages redeploys
   the static fallback. No manual steps, no Friday fear.

## Database (Neon Serverless Postgres)

Two tables, both written through Vercel serverless functions in
[`api/`](api/), schema in [`database/schema.sql`](database/schema.sql)
(also auto-bootstrapped on first use):

- `email_signups` — Road Crew signups from the landing page and the in-game
  form. Validated, lowercased, **upserted** (duplicate emails update one row —
  the live counter cannot be inflated, and a returning signup is never locked
  out). Only a short IP hash is stored, never the raw address.
- `game_high_scores` — the cloud leaderboard. Finished runs save locally FIRST,
  then sync to Neon; a failed cloud write can never trap the player on a saving
  screen. The high-scores screen renders the live Neon board on Vercel.

On GitHub Pages or a local static server, both paths fall back to localStorage
and say so explicitly — tested by `qa/launch-contract.js` and
`qa/highscores-client-contract.js`.

## Reproduce the proof

```bash
npm test          # all seven gates, exit 0 = shippable
node sim/balance-sim.js   # the fairness proof on its own
```

Env vars on Vercel: `DATABASE_URL` (Neon integration) and `IP_HASH_SECRET`.
Setup steps and submission evidence checklist: [VERCEL-NEON.md](VERCEL-NEON.md).
