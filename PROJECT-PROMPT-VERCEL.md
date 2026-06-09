# Weekend Road Trip - Full Project Prompt

Build the polished Vercel web version of **Weekend Road Trip**, a browser-first
2D arcade driving game for Lipscomb MSAI ENGR 5513. Treat this as a finished
class submission and portfolio artifact, not a sketch, landing page, or toy
demo. The player should immediately see and play the actual game. The first
screen is the playable title/menu wrapped over the live game world, with Start,
High Scores, Achievements, Ghost Race, Settings, Controls, and the Road Crew
signup. The tone is Music City night-cruise polish: clean, confident, readable,
and arcade-satisfying.

The story is simple. Marty has one free night before the class demo. He points
his GT through Nashville on one tank of gas, starting downtown, rolling through
Music Row, crossing the Cumberland riverfront, and finishing under Lower
Broadway neon. The goal is to reach the final Broadway stretch before fuel runs
out. The player does not control throttle directly. The car accelerates on its
own and the route becomes faster and denser by leg, so the player focuses on
positioning: changing lanes, jumping, ducking, collecting fuel and snacks, using
nitro, skimming hazards for near misses, and keeping the combo alive.

Use a dependency-light architecture: vanilla HTML, CSS, and JavaScript with an
HTML5 Canvas renderer and no build step. Keep the main game runnable by opening
`index.html` or serving the folder locally. Use Node only for tests and Vercel
serverless functions. The only production dependency should be
`@neondatabase/serverless` for Neon Postgres. The target engine is a fixed
logical 960 by 540 game space rendered crisply through a DPR-aware canvas
backing store. HTML/CSS overlays own menus, HUD, forms, focus states, help
screens, and responsive layout. Canvas owns the world, road, car, obstacles,
collectibles, particles, screen effects, ghost replay, and camera renderers.

The core game is a three-lane arcade dodger. The car is pinned near the left
side of the logical screen and the world scrolls around it. Inputs are `A` or
left arrow to move left, `D` or right arrow to move right, Space/`W`/up to jump,
`S`/down to duck, `P` or Escape to pause, `M` to mute, `?` for controls, and `T`
to toggle the camera between side view and chase view. Support gamepad and touch
with parity. Lane changes should feel snappy but buffered: one lane hop takes
about 0.16 seconds, and a short input buffer lets a held or quickly repeated
input chain cleanly without causing accidental multi-hop chaos. The player can
change lanes while airborne. Jump and duck are independent verbs, so obstacle
patterns can ask the player to think in both horizontal and vertical space.

The obstacle set should include potholes, cones, low signs, and traffic pressure
such as semis, each with readable silhouettes and clear hitboxes. Collectibles
include fuel cans, snacks/score pickups, nitro, and pit stops. Pit stops provide
a meaningful partial refill, not a full reset that removes the lose condition.
The game should reward skill rather than passive survival: score comes from
distance, pickups, near-miss bonuses, lane-risk bonuses, nitro use, and an
uncapped-feeling combo system that keeps climbing while the player strings
clean actions together. A collision should cost fuel and break the combo, but it
should not feel arbitrary. A clean skilled run should finish reliably, a
moderate run should usually finish, and a careless run should usually run dry.

The most important design constraint is fairness. No spawned obstacle layout may
be unavoidable. Express balance as data, not scattered code. Keep one reviewable
`BIOMES` array for the route and one index-aligned `DIFFICULTY` table controlling
per-leg speed scale, obstacle density, minimum blocking gap, fuel spawn rate,
fuel per can, maximum lane span, and pattern weights. The spawner must enforce a
reachable-set invariant: non-layered patterns cannot block every lane, layered
full-width patterns must be solvable by one clear vertical action, same-lane
blockers must be separated by a speed-aware minimum gap, and every pattern must
give enough lead time for the player to reach an open lane. Maintain a headless
simulation that mirrors the physics constants and proves the game remains fair
before any change ships.

The route is Nashville-specific. It has four legs: Downtown, Music Row,
Cumberland, and Broadway. Each leg needs a distinct palette, time-of-day feel,
background silhouette, and landmark language. Use procedural Canvas art only:
skyline blocks, Ryman and 5th Avenue cues, AT&T/333 Commerce shape language,
Country Music Hall of Fame/SoBro hints, Music Row studios, guitar signs,
riverfront water, Seigenthaler bridge, Nissan Stadium, Bridgestone Arena,
streetlights, Broadway storefronts, neon reflections, clouds, hills, and
atmospheric haze. Use approximate Nashville geography as design inspiration and
optional internal anchors, but keep map-like coordinate placards and non-gameplay
wayfinding labels disabled by default. The current polished visual direction
should feel like a game world, not a GIS overlay.

The renderer must have two camera modes that share the exact same gameplay
state. Side view is the primary 2D arcade presentation. Chase view is a
renderer-only projection from behind the car, using the same live obstacles,
collectibles, pit stops, semis, lane state, ghost position, collision model, and
finish line. Toggling camera mode must never replace physics arrays, reset
spawns, or change difficulty. Use the `T` key and announce the mode change. Keep
the road visually coherent: asphalt grain, cracks, reflections, light pools,
seams, and lane dashes should scroll as one road sheet. Parallax should ramp
cleanly from far to near: clouds slowest, then mountains, skyline, mid-scenery,
and any sign layer fastest. Avoid clutter that makes hazards harder to read.

The car should read as a fictional GT racer, not a licensed vehicle. Draw it
procedurally with metallic shading, planted tires, a body-only suspension bob,
a stable shadow/contact line, a random per-run livery, a visible door number,
and a clear collision footprint. Wheels must not visually float above the road.
The game should have particles, smoke, sparks, pickup bursts, speed lines,
screen shake, combo popups, low-fuel pulse, nitro overlay, finish celebration,
and achievement toast polish, but every motion effect must respect
reduce-motion settings.

Ghost Race is a flagship feature. Every run should record compact replay
telemetry at a steady sample interval. At the end of a run, save a transparent
ghost car locally and allow the player to copy or paste shareable JSON so a
classmate can race the line asynchronously. Imported ghosts must be validated:
right game name, version, sane frame shape, bounded frame count, and numeric
fields. The ghost appears as a transparent car when on screen and as an edge
arrow when ahead or behind. Ghost Race must work offline and must not depend on
Neon.

Persistence should be practical and resilient. Store local high scores, settings,
achievements, and ghost replay in localStorage with try/catch fallbacks so the
game does not crash in restricted browsers. High scores use three-character
initials and a top-five leaderboard. Achievements should include starting the
cruise, first jump, first collision survived, pickups, low fuel, each route leg,
max speed, combo/score milestones, finish, clean finish, ghost save, and ghost
race. Settings include screen shake, colorblind/high-contrast palette, ghost
visibility, mute, SFX toggle, master volume, and reduce motion. Audio must obey
browser autoplay policy: create the AudioContext only after a user gesture.
Engine sound should be present but not droning, and one-shot sounds should be
short, readable, and gated by settings.

The Vercel/Neon requirement is part of the project, not a bolt-on. The title
screen includes a compact Road Crew signup form with name and email. On Vercel,
`api/waitlist.js` validates and normalizes email, collapses whitespace in names,
upserts duplicate emails into a Neon `email_signups` table, returns a live count,
and stores only a short IP hash for light abuse protection. On GitHub Pages or a
local static server, the form must fall back to localStorage and clearly say
that Vercel saves to Neon. Finished game runs also sync high scores through
`api/highscores.js` into a Neon `game_high_scores` table. Cloud score failures
must never trap the player on a saving screen: save locally first, then attempt
cloud sync, then show a clear fallback status.

Accessibility is a hard requirement. Use semantic buttons, visible focus rings,
keyboard-first menu flow, ARIA progress values for fuel and trip, a polite live
region for screen changes and critical events, a useful canvas aria-label that
summarizes current state, reduced-motion defaults seeded from the operating
system, and colorblind-safe alternatives for important colors. The touch UI
must have large tap targets, prevent accidental page scroll/zoom during play,
and stay out of the HUD. Text must remain legible at desktop and mobile sizes.

The engineering story matters because this is an Applied AI in Engineering
artifact. Keep documentation honest: explain which parts were human design
decisions, which parts were AI-assisted implementation, and how deterministic
gates kept the work honest. The acceptance gate is `npm test`, which must run
the balance simulation, JS self-tests, DOM smoke test, Road Crew API contract,
cloud high-score API contract, high-score client contract, and launch contract.
The project is acceptable only when the game plays start to finish, the Vercel
and fallback paths both behave correctly, the simulation proves no unavoidable
layouts, all tests pass, there are no console errors, and the final result feels
like a polished Nashville arcade game rather than a prototype.
