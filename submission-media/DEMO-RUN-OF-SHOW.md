# Final Boss — Live Demo Run of Show (5:00)

**Audience intel (from the 6/4 class recording):** tonight is the last class, format is show-and-tell, and Dr. Nordstrom invited guests **including prospective applicants to the program** — he wants to show them what students can build. His exact words: "I want to be able to open up my browser and play your game." Use that — see the 2:15 beat.

**Pre-flight (before class):** production, `/waitlist`, Vercel dashboard (Deployments tab), Neon console (Tables view), and GitHub Pages each open in their own pinned browser tab, in that order. Play 2–3 runs on desktop and 1–2 on your phone under distinct initials so the projected board is a multi-device field, not a monologue — and open HIGH SCORES once right before presenting to warm the Neon connection (first hit is ~1.5s cold, ~0.1s warm). Phone hotspot charged as Wi-Fi backup.

---

**0:00 — Open production.**
Tab 1: `https://weekend-road-trip-forrestw200.vercel.app`
SAY: "Weekend Road Trip — vanilla JS and Canvas, no engine, no build step. But it's deployed like a product: this is Vercel production, serving serverless APIs backed by Neon Postgres. Everything you're about to see is live."
*If it breaks:* flip to GitHub Pages tab — "same code, static fallback" — and continue; move step 4 (dashboard) earlier while it loads.

**0:30 — Road Crew signup, live counter.**
Tab 2: `/waitlist`. Point at the counter. SAY: "This landing page writes emails into Neon through a serverless function. Counter says N." Type a name + email, click **JOIN**. "Now N+1 — that row just landed in Postgres. Emails are validated, lowercased, and upserted, so resubmitting can't inflate the counter. And no raw IPs — only a short salted hash."
*If the POST fails:* refresh once; if still down, point at the title-screen form note instead and show the Neon table later in step 5 — the count of 2 already proves the path.

**1:15 — Play (~60 seconds).**
Back to Tab 1, START THE TRIP. Narrate while weaving: "Three lanes, jump, duck — throttle's automatic, so it's all positioning. Near-misses build an uncapped combo." Take a couple of deliberate near-misses, then let a crash happen (or finish).
*If you choke:* a crash IS the demo — it goes straight to score entry. Nothing to recover.

**2:15 — Initials → cloud leaderboard.**
Enter initials, open HIGH SCORES. SAY: "Saved locally first, then synced to Neon — a failed cloud write can never strand the player on a saving screen. This board is rendering from Postgres right now."
**Then the move nobody else has:** "Dr. Nordstrom — you said you wanted to open your browser and play. `weekend-road-trip-forrestw200.vercel.app` — your run will land on this same leaderboard, from your machine, through the same Neon table." (If he plays even 20 seconds, refresh HIGH SCORES and point at his row arriving. If he defers, carry on — the offer itself lands.)
*If sync fails:* the local board still shows the run — "that's the fallback design working as intended" — and verify the cloud row in Neon at step 5.

**3:00 — Vercel dashboard.**
Tab 3. Show Deployments: production from `main`, plus preview deployments. SAY: "Every PR gets its own preview URL before merge — PRs #29 and #30 were each playable on their own preview before they touched production. And nothing merges until 7 CI gates pass — including a balance simulation that constructively proves no obstacle layout is unavoidable, plus 500 seeded runs validating the fuel economy."
*If login/session breaks:* skip — the preview URLs are linked from the PRs on GitHub, show the PR checks tab instead.

**3:45 — Neon console.**
Tab 4. Show `email_signups` — "there's the signup from three minutes ago" — then `game_high_scores` — "and there's my run."
*If the console hangs:* `GET /api/waitlist` and `GET /api/highscores` in a new tab return the same data as JSON — show that.

**4:30 — GitHub Pages, one sentence.**
Tab 5. SAY: "Same repo also deploys to GitHub Pages — no serverless there, so the same client detects that and degrades to localStorage. Three deployments, one codebase, and both paths are contract-tested in CI."

**4:45 — Close.**
SAY: "Repo, docs, and the fairness proof are linked on the last slide — every claim is checkable tonight. Questions — or export a ghost JSON and race me."

---

**Nuclear fallback:** Wi-Fi dies entirely → GitHub Pages is already cached in Tab 5 (or serve locally: `python -m http.server 8090` in the repo). Full game, localStorage scores — demo the gameplay and narrate the cloud path over the architecture slide (slide 5).

**GTA sandbox (optional flex — use the RIGHT URL):** the only live build is `https://fwwright1001-coder.github.io/weekend-road-trip-gta/` (pin as Tab 6 if you want the beat). The old `…/weekend-road-trip/gta-sandbox/` path is **404** — main was rebuilt for the Vercel submission and the deployed game no longer has the "EXPLORE THE CITY" button. Don't promise it from the win screen and don't type the old URL on stage.

---

## Q&A pocket answers (from what Dr. Nordstrom emphasized on 6/4)

- **"Do you have separate databases for production and preview?"** — "One Neon database for the class demo, linked to both — and that's a known shortcut. Neon supports a database branch per deployment (it's a checkbox in the Vercel connect dialog), so production gets its own isolated data the moment this has real users. The APIs already read whichever connection string the environment provides, so nothing in the code changes."
- **App Router vs pages:** the Stage 1–4 app uses the App Router — the choice he called "the safer one" in class.
- **"Why JavaScript and not TypeScript?"** — "The game is deliberately zero-build vanilla JS, and the Stage 1–4 app stayed JS for one language across the whole submission. Correctness is enforced by 7 CI gates and 4 contract suites instead of compile-time types — and TS is a mechanical migration if it grows." (He said on 6/4 the choice doesn't matter for this class; just don't claim TS.)
- **If another road-trip game comes up** (a classmate submitted "Road Trip Rampage" by video): one line, no names — "You may see another road-trip game tonight; ours is the one with the open-world city, the CI pipeline, and the leaderboard you're already on."
- **If agent-fleet stories come up** (per the 6/4 close, a classmate's project had "124 agents making code and committing it to his repo"): no contest, just altitude — "I orchestrate agent fleets too: this afternoon a 10-agent adversarial audit fact-checked every claim in my submission post before it went up, and one agent's finding got refuted by the verifier agents. Agent count isn't the metric — what stops wrong code from shipping is. Here that's 7 CI gates and 4 contract suites that every line, human- or agent-written, has to pass."
- **Closing callback (optional, for the 4:45 close):** his exact 6/4 words — "show up with an AI-authored application that lives in the cloud, deployed automatically… you will look like a king or a queen. Everyone will be shocked at how capable your production pipeline is." Land it: "You told us a production-grade pipeline would make us look like kings and queens. Mine is strict enough that it wouldn't let *me* merge until the fairness proof passed."
- **"What did Claude do vs you?"** — honest answer is the strongest: orchestration, lane ownership, adversarial review passes, and a CI gate that machine-checks fairness. No ML claims — it's an AI-orchestration + software-engineering showcase.
