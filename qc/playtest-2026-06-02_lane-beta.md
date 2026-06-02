# Play-Test + Review Report — Weekend Road Trip (Lane Beta)

- **Date:** 2026-06-02
- **Branch:** `showcase/alpha` (3-lane system + depth retune)
- **Method:** Headless Chromium (Playwright), real KeyboardEvents, HUD DOM reads + screenshots; ephemeral profiles. Plus a 3-lens adversarial code review of the diff, each finding independently verified.

## Verdict: PASS — merged to main

Comprehensive playtest: **0 game console errors** across all sessions; boot self-tests 12/12; all 5 regression checks + all 10 new mechanics verified clean; **no bugs found** over 6 full trips under adversarial input.

## What the beta delivers (vs the Alpha audit's gaps)

- **Second decision axis:** 3 lanes, snappy 0.16s hops with input buffer, mid-air lane changes. Lane-gated collision; adjacent-lane blockers become near-misses.
- **Climaxing difficulty:** speed auto-escalates per leg (live MPH 131→190 CITY→COAST); density 1.00→1.65; pattern complexity peaks at COAST. The finale is now the hardest leg.
- **Skill-dominant scoring:** uncapped combo (observed x10 live; multiplier to 12×+), near-miss + lane-risk bonuses, passive distance trimmed. Sim: a weaver outscores a grinder **7.82×**.
- **Provably fair:** cross-lane patterns never block all 3 lanes (layered is the single-verb exception); headless sim asserts 10 criteria incl. per-lane solvability + reachability (COAST lead 0.888s > 0.57s reach budget). Caught a real solvability bug (jump span vs lane gap at escalated speed) during design.

## Adversarial review — 3 findings, all fixed

| Sev | Finding | Fix |
|---|---|---|
| HIGH | Held lane key auto-repeated hops (no `e.repeat` guard); keyboard diverged from gamepad | `e.repeat` guard; held keys still register for continuous reads |
| MEDIUM | Lane buffer 0.12s < tween 0.16s → early chain-presses dropped | Buffer raised to 0.18s (≥ tween) |
| LOW | Sim rolled a hit per blocker in multi-lane patterns (player hits at most one) | One hit per pattern; bands still pass (skilled 100% / moderate 99.8% / careless 97.6% dry) |

## Non-blocking notes

- combo-15 / combo-25 achievements couldn't be auto-unlocked (a blind bot can't chain a pickup at combo≥15); threshold logic verified present.
- Ghost replays are forward-compatible (recorded `y` already encodes lane + jump), so no schema bump was needed.

## Gates (every commit)

`node sim/balance-sim.js` exit 0 (10/10 criteria) AND `node qa/run-selftests.js` 12/12, enforced as the merge gate on all 8 commits.
