# Final Boss discussion post (paste-ready draft)

> **Weekend Road Trip — Final Boss complete**
>
> 🏁 Play (Vercel production): https://weekend-road-trip-forrestw200.vercel.app
>
> 📋 Road Crew landing page + live Neon signup counter: https://weekend-road-trip-forrestw200.vercel.app/waitlist
>
> 🔀 Real preview-deployment workflow: PR #29 (a full game-feel rework) and PR #30 (the landing page) each got their own public Vercel preview URL before merging — https://github.com/fwwright1001-coder/weekend-road-trip/pulls?q=is%3Apr
>
> 🗄️ Neon Postgres holds both tables: `email_signups` (validated + upserted, live counter) and `game_high_scores` (cloud leaderboard — scores save locally first, then sync, so a failed cloud write can never strand the player)
>
> ⚙️ Every push and PR runs 7 CI gates: a balance simulation that *proves* no obstacle layout is unavoidable across 500 seeded runs, 19 self-tests, a DOM contract, and 4 API/client contract suites covering the Neon paths and the GitHub Pages fallback — which is still live as a third deployment: https://fwwright1001-coder.github.io/weekend-road-trip/
>
> How it deploys, start to finish: https://github.com/fwwright1001-coder/weekend-road-trip/blob/main/DEPLOYMENT.md

## Screenshot checklist before posting

1. Vercel deployments page (production + the two PR previews)
2. The /waitlist landing page with the live counter
3. Neon tables: `email_signups` and `game_high_scores` (play runs first so scores exist!)
4. In-game HIGH SCORES screen showing the cloud board

## Pre-post to-dos

- Play 3-4 real runs on production and save scores (leaderboard is empty until you do)
- Share /waitlist with the cohort to push the counter past 1
- One run on your phone (touch + rotate gate)
