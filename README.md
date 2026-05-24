# Weekend Road Trip

A 2D side-scrolling browser game built for ENGR 5513 — Applied AI in Engineering (Summer 2026, Lipscomb MSAI).

**Theme:** American Weekend Vacation
**Story:** You're Marty, a software engineer who finally got a long weekend off. Pile in the convertible and race across the country — through city traffic, forest roads, scorching desert, and finally to the coast — before your PTO runs out.

## Play

Open `index.html` in any modern browser. No build step, no install.

## Controls

| Key | Action |
|-----|--------|
| `Space` / `W` / `↑` | Jump (avoid obstacles) |
| `S` / `↓` | Duck (slide under low signs) |
| `A` / `←` | Brake |
| `D` / `→` | Accelerate |
| `P` | Pause |
| `Enter` | Confirm on menus |

## Features

- 3 screens: Title, Gameplay, High Scores
- Parallax scrolling backgrounds across 4 biomes
- Fuel & snack collectibles, road hazard obstacles
- Health/fuel system with game-over condition
- Win condition: reach the coast
- High score leaderboard with 3-character initials, persisted in `localStorage`

## Tech

Vanilla HTML5 + Canvas 2D + JS. Single folder, zero dependencies.

## Author

Forrest Wright — MSAI '26
