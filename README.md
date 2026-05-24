# Weekend Road Trip

A polished 2D side-scrolling browser game built for ENGR 5513 — Applied AI in Engineering (Summer 2026, Lipscomb MSAI).

**Theme:** An American Weekend Vacation — Coast to Coast.

## Protagonist & Motivation

You play **Marty**, a software engineer who's been heads-down shipping for eleven months straight. Today his PTO finally cleared. He throws a duffel in his red convertible, points it west, and drives. The goal is simple: dodge the potholes, duck the low STOP signs, grab roadside snacks and fuel cans, and don't run out of gas before you reach the ocean. The trip takes him through four American biomes — city at dawn, pine forest in the morning, scorched desert in the afternoon, and the Pacific coast at sunset.

## Play

Open `index.html` in any modern browser (Chrome, Edge, Firefox, Safari). No build step, no install, no dependencies.

For best performance, serve it locally:
```bash
python -m http.server 8090
# then open http://localhost:8090
```

## Controls

| Key | Action |
|---|---|
| `Space` / `W` / `↑` | Jump over potholes & cones |
| `S` / `↓` | Duck under low STOP signs |
| `D` / `→` | Accelerate |
| `A` / `←` | Brake |
| `P` / `Esc` | Pause |
| `M` | Mute / unmute audio |
| `?` | Toggle controls overlay |
| `Enter` | Confirm on menus |

## Game systems

- **Four biomes** with per-biome time-of-day palettes: city dawn, forest morning, desert afternoon, coast sunset
- **5-layer parallax** scrolling: gradient sky + sun & clouds, silhouette mountains, biome-specific mid scenery, near-ground detail
- **Player car** with animated wheels, body bob, accel/brake tilt, headlights, driver figure
- **Obstacles**: potholes (jump), traffic cones (jump), STOP signs (duck)
- **Collectibles**: fuel cans (+health, +score), snacks (+score) — both bob and glow
- **Particle effects**: exhaust, take-off dust, landing dust, impact sparks, pickup bursts
- **Screen shake** + damage flash on collisions
- **Biome entry banners** when you cross into a new region
- **Score** = distance + collectible bonuses + biome-clear bonuses
- **Health/fuel** depletes over time and on hits; refilled by fuel cans
- **Win** when you reach the coast (6000 distance units); **lose** when your tank hits zero
- **High scores** with 3-character editable initials, top 5, persisted to `localStorage`

## Three main screens (per assignment)

1. **Title screen** — story, START button, high-score & controls access
2. **Gameplay screen** — the actual side-scroller with HUD overlays
3. **High scores screen** — top 5 leaderboard with initials, scores, dates

Plus paused / game-over / win / initials-entry / help screens as needed.

## Tech

Vanilla HTML5 + Canvas 2D + JavaScript. HTML/CSS overlays for menus and HUD (crisp typography). Single folder, zero dependencies, no build step.

## Author

Forrest Wright — Lipscomb MSAI '26 — ENGR 5513 Summer 2026
