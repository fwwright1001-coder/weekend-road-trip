# Weekend Road Trip submission draft

Screenshot/GIF: use `submission-media/weekend-road-trip-ghost-race.png` or `submission-media/weekend-road-trip-ghost-race.gif`.

My game is called **Weekend Road Trip**, a 2D side-scrolling American vacation game about Marty finally getting PTO after eleven months of shipping work. He throws a bag into his red convertible and tries to drive coast-to-coast on one tank of gas, passing through city dawn, pine forest morning, desert afternoon, and a sunset coast. The core loop is simple to read but hard to master: accelerate, brake, jump potholes and cones, duck under low signs, grab snacks and fuel, and reach the ocean before the tank runs dry.

Technically, the game is built from scratch in vanilla JavaScript and HTML5 Canvas with no engine and no external sprite assets. It uses a Canvas render loop, HTML/CSS HUD overlays, procedural parallax scenery, biome palette blending, AABB collision, particle systems, screen shake, Web Audio sound effects, a persistent high-score table, gamepad support through the Gamepad API, and a settings panel for screen shake, colorblind contrast, and ghost visibility. It also includes an 18-achievement system with unlock toasts and persistent progress in localStorage.

The standout feature is **Ghost Race mode**: every run records replay telemetry, saves a transparent ghost car locally, and lets players copy/paste shareable JSON so a classmate can race their route asynchronously. That gives the project a replay challenge system on top of the normal arcade run. The game also includes four biome stages, pit stops, semi-truck events, bird flocks, combo scoring, persistent achievements, and local replay persistence.

Play it live: https://fwwright1001-coder.github.io/weekend-road-trip/

Repo: https://github.com/fwwright1001-coder/weekend-road-trip
