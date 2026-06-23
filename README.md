# Weekend Road Trip

[![CI](https://github.com/fwwright1001-coder/weekend-road-trip/actions/workflows/ci.yml/badge.svg)](https://github.com/fwwright1001-coder/weekend-road-trip/actions/workflows/ci.yml)
Vanilla JS frontend | Vercel API | Neon-ready

A three-lane arcade driver where balance and fairness are **proven by a headless
simulation**, not eyeballed, and built under a process with deterministic,
machine-checked gates.

**Play (Vercel production):** https://weekend-road-trip-forrestw200.vercel.app
**Join the Road Crew (landing + live Neon counter):** https://weekend-road-trip-forrestw200.vercel.app/waitlist
**Static fallback (GitHub Pages, localStorage mode):** https://fwwright1001-coder.github.io/weekend-road-trip/
**How this deploys (branch → PR → preview → CI → prod):** [DEPLOYMENT.md](DEPLOYMENT.md)

![Weekend Road Trip - three-lane gameplay](submission-media/hero-lanes.png)

> Drive Marty's GT through a Nashville, Tennessee night cruise on one tank of gas:
> weave three lanes, jump potholes, duck low signs, skim hazards for near-miss
> combos, and outrun a difficulty curve that peaks under the Lower Broadway
> neon.

---

## Assignment Rubric

The grad-course brief, mapped to the exact artifact that satisfies each line:

| Rubric expectation | Where it lives |
|---|---|
| Playable game + title / gameplay / high-score screens, 3-char initials, persistent | `index.html` screens + `game.js` state machine; scores in `localStorage` (`wrt.highscores.v2`) and Neon on Vercel |
| Game feel and polish | 5-layer parallax, particles, screen shake, procedural Web Audio, mute, achievements |
| Difficulty and fairness | Proven by [`sim/balance-sim.js`](sim/balance-sim.js); rationale in [`BALANCE.md`](BALANCE.md) |
| Git / PR workflow | Feature-branch-per-change, conventional commits, reviewed PRs into `main` |
| Documentation | this README + [`ARCHITECTURE.md`](ARCHITECTURE.md), [`BALANCE.md`](BALANCE.md), [`CHANGELOG.md`](CHANGELOG.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Tests / CI | [`sim/balance-sim.js`](sim/balance-sim.js), [`qa/run-selftests.js`](qa/run-selftests.js), [`qa/smoke-dom.js`](qa/smoke-dom.js), [`qa/waitlist-contract.js`](qa/waitlist-contract.js), [`qa/highscores-contract.js`](qa/highscores-contract.js), [`qa/highscores-client-contract.js`](qa/highscores-client-contract.js) |
| Edge-case handling | tab-blur `dt` clamp, `localStorage` try/catch fallbacks, focus management |
| Accessibility | OS-seeded reduce-motion, colorblind palette, ARIA live region, keyboard + gamepad + touch parity |
| AI vs. personal contribution | [`AI-CONTRIBUTIONS.md`](AI-CONTRIBUTIONS.md) |
| Beyond spec | Ghost Race shareable replay JSON, deterministic balance proof, accessibility settings, Vercel API layer |
| Vercel + Neon deployment/database | Road Crew signup form, cloud high scores, Vercel functions [`api/waitlist.js`](api/waitlist.js) + [`api/highscores.js`](api/highscores.js), Neon schema [`database/schema.sql`](database/schema.sql), setup proof in [`VERCEL-NEON.md`](VERCEL-NEON.md) |

---

## Why This Repo Is Interesting

- **A fairness invariant a machine proves.** Three lanes + jump + duck makes
  "is every layout survivable?" a real question. The spawner enforces a
  reachable-set invariant, and [`sim/balance-sim.js`](sim/balance-sim.js) proves
  an optimal controller clears the densest legal obstacle streams with zero
  collisions across the acceptance criteria.
- **AI-orchestrated, gate-verified development.** Features were built by agents
  running under written contracts, but every commit had to leave the simulation
  and self-tests green. Agents propose; deterministic checks dispose.
- **Production hygiene in a course game.** DPR-aware rendering,
  keyboard/gamepad/touch parity, accessibility settings, CI, and a QC audit trail
  in [`qc/`](qc/).

---

## Play

Open `index.html` in any modern browser. For best results serve locally:

```bash
python -m http.server 8090
```

Then open `http://localhost:8090`.

### Vercel + Neon

The title screen includes a Road Crew signup form for the Vercel/Neon assignment,
and completed runs can sync high scores to Neon when deployed on Vercel.
On GitHub Pages it stores a local fallback because Pages cannot run serverless
functions. On Vercel, the same form posts to `api/waitlist.js`, which validates
and upserts email signups into Neon table `email_signups`. High scores post to
`api/highscores.js` and are stored in `game_high_scores`.

See [`VERCEL-NEON.md`](VERCEL-NEON.md) for deployment steps, env vars, and
submission proof screenshots.

### Controls

| Key | Action |
|---|---|
| `A` / left, `D` / right | Change lanes |
| `Space` / `W` / up | Jump over potholes and cones |
| `S` / down | Duck under low signs |
| `P` / `Esc` | Pause |
| `M` | Mute |
| `T` | Switch side / chase camera |
| `?` | Controls |
| Gamepad | A jump, B duck, D-pad/stick lanes & menus, Y camera, X mute |
| Touch | Lane / jump / duck buttons + CAM and pause up top |

The throttle is automatic. Speed escalates each leg, so Broadway is the fastest
stretch. Your inputs are about positioning.

---

## Game Systems

- Three lanes with buffered hops; dodge by lane, jump, or duck.
- Cross-lane obstacle patterns with a fair line through.
- Four Nashville legs: downtown skyline, Music Row studios, Cumberland
  riverfront, and Lower Broadway neon.
- Nashville route detail uses approximate WGS84 anchors and landmark geometry
  for the Ryman, AT&T/333 Commerce, Country Music Hall of Fame, Music Row
  studios, Seigenthaler bridge, Nissan Stadium, Bridgestone Arena, Riverfront,
  and Lower Broadway. Map-like coordinate placards are disabled by default.
- Skill-dominant scoring with an uncapped combo multiplier, near-miss bonuses,
  and lane-risk bonuses.
- Semis are deliberate non-colliding ambience: they overtake faster than the
  world scrolls, so a hitboxed semi could be unavoidable — which would break
  the fairness invariant the sim proves.
- Ghost Race records replay telemetry and exports/imports shareable JSON.
- Side and chase camera renderers read the same live obstacles, pickups, pit
  stops, lane state, and collision model.
- Procedural art and audio, particles, screen shake, achievements, high scores,
  and local persistence.
- Keyboard + gamepad + touch; DPR-aware rendering; accessibility settings.

![Ghost Race - async head-to-head replay](submission-media/weekend-road-trip-ghost-race.gif)

---

## Testing & CI

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

These run on every push to `main` and every PR via [GitHub Actions](.github/workflows/ci.yml).
`npm run stress` is an on-demand load check for the Road Crew signup API path.

## Tech

Vanilla HTML5 + Canvas 2D + JavaScript; HTML/CSS overlays for menus and HUD. The
game has no build step. The optional Vercel API uses `@neondatabase/serverless`
for Neon Postgres writes. MIT licensed.

## Author

Forrest Wright - Lipscomb MSAI - ENGR 5513 Applied AI in Engineering, Summer 2026
