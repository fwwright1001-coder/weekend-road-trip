# Weekend Road Trip Submission Draft

Screenshot/GIF: use `submission-media/weekend-road-trip-ghost-race.png` or
`submission-media/weekend-road-trip-ghost-race.gif`.

My game is called **Weekend Road Trip**, a 2D side-scrolling American vacation
game about Marty finally getting PTO after eleven months of shipping work. He
throws a bag into his red GT and tries to drive coast-to-coast on one tank of
gas, passing through city dawn, pine forest morning, desert afternoon, and a
sunset coast. The core loop is simple to read but hard to master: change lanes,
jump potholes and cones, duck under low signs, grab snacks and fuel, and reach
the ocean before the tank runs dry.

Technically, the game is built from scratch in vanilla JavaScript and HTML5
Canvas with no engine and no external sprite assets. It uses a real-time Canvas
render loop, HTML/CSS HUD overlays, procedural parallax scenery, biome palette
blending, AABB collision, particle systems, screen shake, Web Audio sound
effects, persistent high scores, gamepad and touch support, and accessibility
settings for screen shake, reduced motion, and colorblind contrast.

The standout gameplay feature is **Ghost Race mode**: every run records replay
telemetry, saves a transparent ghost car locally, and lets players copy/paste
shareable JSON so a classmate can race their route asynchronously.

For the Vercel/Neon deployment assignment, I added a production-style **Road
Crew** signup path on top of the game. The title screen now has a launch signup
form. On Vercel, it writes through `api/waitlist.js` into a Neon Postgres table
named `email_signups`; on GitHub Pages, it falls back safely to localStorage
because static Pages cannot run serverless functions. The API validates emails,
upserts duplicates, creates the schema automatically, returns a live signup
count, avoids storing raw IP addresses, and has its own CI contract test.

Play it live on GitHub Pages:
https://fwwright1001-coder.github.io/weekend-road-trip/

Repo:
https://github.com/fwwright1001-coder/weekend-road-trip

Vercel/Neon proof guide:
`VERCEL-NEON.md`
