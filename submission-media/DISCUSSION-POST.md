# Final Boss discussion post (paste-ready draft)

> **Weekend Road Trip — Final Boss complete**
>
> 🏁 Play (Vercel production): https://weekend-road-trip-forrestw200.vercel.app
>
> 📋 Road Crew landing page + live Neon signup counter: https://weekend-road-trip-forrestw200.vercel.app/waitlist
>
> 🔀 Real preview-deployment workflow: PR #29 (a full game-feel rework) and PR #30 (the landing page) each got their own Vercel preview URL before merging — https://github.com/fwwright1001-coder/weekend-road-trip/pulls?q=is%3Apr
>
> 🧪 Stages 1–4 warm-up app (Next.js + Vercel + Neon): **Neon Spur Tours** — https://final-boss-next.vercel.app — landing page stores leads in a Neon `neon_spur_leads` table and shows a live signup counter; the `feature/preview-colorway` branch demos the preview-deployment flow with an alternate colorway. Repo: https://github.com/fwwright1001-coder/final-boss-next
>
> 🗄️ Neon Postgres holds both tables: `email_signups` (validated + upserted, live counter) and `game_high_scores` (cloud leaderboard — scores save locally first, then sync, so a failed cloud write can never strand the player)
>
> ⚙️ Every push and PR runs 7 CI gates: a balance simulation that *constructively proves* no obstacle layout is unavoidable (and validates the fuel economy across 500 seeded runs), 19 self-tests, a DOM contract, and 4 API/client contract suites covering the Neon paths and the GitHub Pages fallback — which is still live as a third deployment: https://fwwright1001-coder.github.io/weekend-road-trip/
>
> How it deploys, start to finish: https://github.com/fwwright1001-coder/weekend-road-trip/blob/main/DEPLOYMENT.md

## Screenshots — CAPTURED 2026-06-11, ready at `C:\Users\User\CoworkProjects\final-boss-submission\screenshots\`

Use the `-cropped.png` versions (browser chrome with personal tabs removed):

1. `01-…-cropped` — final-boss-next Vercel deployments (2 Production + 2 Preview, all Ready)
2. `02-…-cropped` — weekend-road-trip Vercel deployments (production + PR preview history)
3. `03/04/05-…-cropped` — Neon tables: `email_signups`, `game_high_scores`, `neon_spur_leads`
4. `06-…-cropped` — preview deployment rendering the teal colorway (Stage 3 proof)
5. `07-game-highscores-cloud` — in-game HIGH SCORES screen, "Showing Neon cloud high scores"

## Pre-post to-dos

- DONE 2026-06-11: 3 real runs on the board (FWW 15223 / 13914 / 13207); reply drafted in Canvas with 5 embedded screenshots — click Reply to post
- Optional: more runs from desktop + phone under distinct initials (board depth for the projector)
- Optional: re-screenshot 04 (game_high_scores) — live API already proves 3 scores
