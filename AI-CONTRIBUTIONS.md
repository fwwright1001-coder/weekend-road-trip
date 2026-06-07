# AI vs. personal contribution

ENGR 5513 asks for an explicit, honest account of what was human and what was AI.
Here it is, per system, plus the process that kept the AI honest.

## Operating principle: agents propose, deterministic checks dispose

Every design decision, acceptance criterion, and "is this good enough" judgment was
mine. AI wrote most of the implementation, but no AI-authored change merged unless
it left the balance simulation ([`sim/balance-sim.js`](sim/balance-sim.js)) and the
self-test harness ([`qa/run-selftests.js`](qa/run-selftests.js)) green. The machine,
not the model, had the final say on correctness.

### The receipt

The fairness invariant in the obstacle spawner is checked, not guessed. The sim
once caught a layout that was physically unsolvable at escalated speed before it
ever shipped. A human set the criterion ("every obstacle stream must be clearable");
AI wrote both the spawner and the checker; the deterministic gate caught the AI's
own bug. That loop is the "Applied AI in Engineering" thesis in one event.

## Per-system split

| System | Human - design & decisions | AI - implementation, under gates |
|---|---|---|
| Core loop & physics | fixed-timestep model; jump-arc feel; "positioning, not reflexes" | rAF loop, integration, AABB collision code |
| Three lanes + patterns | the lane / jump / duck verb set; the "always a fair line" rule | pattern generators, buffered lane-hop logic |
| Fairness invariant + sim | the reachable-set criterion and the 10 acceptance criteria | the optimal-controller simulation and checks |
| Scoring | skill-dominant intent (combo / near-miss / lane-risk); about 8x weaver-vs-grinder target | multiplier math, near-miss & lane-risk detection |
| Audio | which events earn SFX; "procedural only, zero assets" constraint | WebAudio graph, oscillator SFX, speed-pitched engine |
| Accessibility | which options matter (reduce-motion, colorblind, full input parity) | ARIA wiring, palette swap, gamepad/touch handlers |
| Ghost Race | the async-replay-as-shareable-JSON idea | per-frame telemetry capture + export/import |
| Vercel + Neon | final-boss requirement framing; privacy and fallback decisions | serverless signup/high-score APIs, database schema, contract tests |
| Docs & CI | what to claim and what to prove; this rubric mapping | doc drafts, table scaffolding, CI workflow |

## Honest limits

- `game.js` is one large module. I prioritized a green, provable game over file
  decomposition.
- GitHub Pages cannot run Vercel serverless functions, so the Road Crew form and
  high scores use local fallback there. The Neon database path is exercised on
  Vercel and covered by contract tests locally.
- The 3D Nashville cruise concept is intentionally deferred until the
  2D final submission is locked.

Forrest Wright - Lipscomb MSAI '26 - ENGR 5513 Applied AI in Engineering
