# Contributing — adding a feature to Weekend Road Trip

This game is a single `game.js` file (~5,500 lines) plus `index.html` and `styles.css`. No build step, and no dependencies for the game itself (only the optional Vercel API layer uses `@neondatabase/serverless`). Drop your changes in, refresh the page.

If you're a classmate adding a feature for next week's ENGR 5513 assignment, this doc is the shortcut.

## Try it locally first

```bash
git clone https://github.com/fwwright1001-coder/weekend-road-trip
cd weekend-road-trip
python -m http.server 8090
# open http://localhost:8090 in your browser
```

## File tour

| File | Purpose |
|---|---|
| `index.html` | Canvas + HTML overlay menus (title, paused, gameover, win, initials, scores, help) |
| `styles.css` | Theme variables, HUD layout, menu panel styling |
| `game.js` | All game logic. Sections labeled with `// ============================================================` banners |

## Where to add your feature

Open `game.js` and search for `// === EXTENSION POINT ===`. Every spot you'd reasonably add something is marked. Here are the common ones:

### Add a new biome
Search: `EXTENSION POINT: BIOMES`
Add a `{ name, end, timeOfDay, sky, sunColor, sunY, mountainColor, ground, grass, road, dashColor, birdColor }` object to the `BIOMES` array. Then add a `case 'YOURBIOME':` branch in `drawMidScenery()` for biome-specific scenery. Also add a matching, index-aligned row to the `DIFFICULTY` array (one per leg) for that biome's tuning.

### Tune difficulty / balance
Search: `DIFFICULTY CURVE`
All per-leg balance lives in the `DIFFICULTY` array — `obstacleDensity`, `minBlockingGap`, `fuelSpawnRate`, `fuelPerCan`, `speedScale`. Tweak a number, not a code path. (This replaced the old per-biome `spawnMul`.) See `BALANCE.md` for the rationale and the headless proof.

### Add a new obstacle
Search: `EXTENSION POINT: OBSTACLE TYPES`
1. Pick a `type` string (e.g. `'cactus'`).
2. Add a branch in `makeObstacle(type)` setting `w`, `h`, `y` for collision.
3. Add a `else if (o.type === 'cactus')` branch in `drawObstacles()` for the visual.
4. (Optional) Bump the spawn-probability slice in `spawn()`.

### Add a new collectible
Search: `EXTENSION POINT: COLLECTIBLE TYPES`
Same pattern as obstacles, but in `makeCollectible()` + `drawCollectibles()` and the pickup branch in `updateWorld()`.

### Add a new screen
1. Add the HTML in `index.html` inside `#overlay` as `<div class="screen hidden" id="screen-yours">`.
2. Add `SCREEN.YOURS = 'yours';` to the `SCREEN` enum.
3. Add `[SCREEN.YOURS]: document.getElementById('screen-yours')` to `screenEls`.
4. Handle the screen in `handleKey()` if you want keyboard input.
5. Call `show(SCREEN.YOURS)` to navigate.

### Add a sound effect
Search: `EXTENSION POINT: AUDIO`
Add a method on the `audio` object that calls `this.blip(...)` or `this.noiseHit(...)`. Call it wherever you want it to play.

### Add a particle effect
Search: `EXTENSION POINT: PARTICLES`
Use `state.particles.push({ x, y, vx, vy, life, max, color, size, gravity })`. The render loop handles fade automatically.

## Workflow (the lesson from class)

```bash
# Pull the latest main first — don't branch off stale code
git checkout main
git pull

# Make a feature branch
git checkout -b feature/your-name-feature

# Make your changes, test in browser
# ...
git add -A
git commit -m "Add your-feature"
git push -u origin feature/your-name-feature

# Open a PR on github.com
# Once merged: switch back to main and pull
git checkout main
git pull
```

## House style

- Comments on the *why*, not the *what*. The code is short enough to read.
- Procedural canvas drawing — no image assets needed.
- Keep `game.js` single-file. No build step, no bundler.
- Test in Chrome / Edge / Firefox before pushing.

## Questions?

Find Forrest in class. Or open an issue on the repo.
