# Weekend Road Trip Submission Draft

Screenshot/GIF: use `submission-media/weekend-road-trip-ghost-race.png` or
`submission-media/weekend-road-trip-ghost-race.gif`.

My game is called **Weekend Road Trip**, a 2D side-scrolling Nashville cruise
game about Marty getting one free night before the class demo. He throws a bag
into his red GT and tries to drive a Music City loop on one tank of gas, passing
through downtown Nashville, Music Row, the Cumberland riverfront, and Lower
Broadway. The core loop is simple to read but hard to master: change lanes, jump
potholes and cones, duck under low signs, grab snacks and fuel, and reach the
neon before the tank runs dry.

Technically, the game is vanilla JavaScript and HTML5 Canvas with no engine
and no external sprite assets, built by AI coding tools under my direction and
checked by a headless simulation. It uses a real-time Canvas
render loop, HTML/CSS HUD overlays, procedural parallax scenery tied to
approximate Nashville WGS84 anchors and street/landmark cues, biome palette
blending, AABB collision, particle systems, screen shake, Web Audio sound
effects, persistent high scores, gamepad and touch support, and accessibility
settings for screen shake, reduced motion, and colorblind contrast.

The standout gameplay feature is **Ghost Race mode**: every run records replay
telemetry, saves a transparent ghost car locally, and lets players copy/paste
shareable JSON so a classmate can race their route asynchronously.

For the Vercel/Neon deployment assignment, high scores have a Neon-backed cloud
path. The game still saves scores locally so it works on GitHub Pages and offline,
but on Vercel each submitted run posts to `api/highscores.js`, creates/stores rows
in `game_high_scores`, and displays the cloud leaderboard when Neon is connected.

Play it live (Vercel production, Neon-backed):
https://weekend-road-trip-forrestw200.vercel.app

Static fallback (GitHub Pages, localStorage mode):
https://fwwright1001-coder.github.io/weekend-road-trip/

Repo:
https://github.com/fwwright1001-coder/weekend-road-trip

Vercel/Neon proof guide:
`VERCEL-NEON.md`
