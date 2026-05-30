# Legal posture — "as close as legally possible"

This layer deliberately clones the **feel and systems** of open-world crime games
while staying clear of the things the law actually protects. Short version:

> **Game mechanics, rules, and systems are not protected by copyright. Specific
> creative *expression* — art, characters, story, dialogue, music, distinctive
> named places, logos, and brand names — is.** We copy the first category and
> originate everything in the second.

This is not legal advice. It's the design rule the code follows so that the
result is defensible. If this ever ships commercially, have an actual IP lawyer
review it.

## What we DO clone (mechanics — not copyrightable)
US copyright law (17 U.S.C. § 102(b)) excludes "any idea, procedure, process,
system, method of operation." Courts have repeatedly held that *game rules and
mechanics* fall on the unprotected side (e.g. the long line of cases from
*Atari v. Amusement World* through *Tetris Holding v. Xio* and *DaVinci v.
Ziko*: you may copy the rules; you may not copy the audiovisual expression).

So we freely reproduce:
- A **wanted/heat system** with escalating star tiers and police response.
- **Carjacking / enter-exit vehicles**, arcade driving, traffic.
- **An arsenal** of weapon archetypes (pistol/SMG/shotgun/rifle/melee), ammo,
  reload, health + armor, "wasted"/"busted" fail states and respawn.
- A **mission/objective framework** (go-to, eliminate, collect, deliver, survive,
  evade), money economy, pickups, a rotating **minimap/radar**.
- The general third-person open-world sandbox loop.

These are *systems*. None of them is owned by anyone.

## What we do NOT touch (expression — protected by copyright and/or trademark)
- **Names & logos.** No "Grand Theft Auto", "GTA", "Rockstar", "Rockstar logo",
  or any of their wordmarks/stylings anywhere — those are **trademarks**, and
  using them (even in mechanics-identical clones) invites trademark + unfair-
  competition claims regardless of copyright. Our product name is generic
  ("crime sandbox" / whatever the host game calls it).
- **No copied assets.** Every mesh, color, and material in this layer is
  generated in code. There are zero imported textures, models, audio files,
  fonts, or asset URLs. Nothing is traced, ripped, or "redrawn from" a reference.
- **No protected fictional content.** No Los Santos / Liberty City / Vice City,
  no San Andreas map, no named characters (Niko, CJ, Trevor, …), no story beats,
  no mission scripts lifted from a real title, no in-game radio music or brands
  (real songs/stations are separately copyrighted; fake-brand parody is a
  different, riskier game we simply don't play).
- **No look-and-feel copying of a *specific* title's distinctive UI.** Our HUD
  (star row, radar, vitals) uses the generic genre vocabulary, drawn in our own
  style — not a pixel-recreation of any one game's interface.

## The line, concretely
| Allowed (mechanic/idea) | Not allowed (expression/mark) |
|---|---|
| 5-tier "wanted" police escalation | Calling it "wanted level" with GTA's exact star art/sound, or the GTA name |
| Steal a car by walking up and pressing a key | Recreating a specific GTA vehicle model or its in-game name |
| Pay to remove your wanted level | A "Pay 'n' Spray" sign/logo (that's a brand) |
| Open-world city with districts | Recreating a real GTA city map/layout |
| Talk-radio/era-music vibe | Any real song, artist, or station name |

## Trademark note (separate from copyright)
Even a 100%-original-art, mechanics-only clone can still get a cease-and-desist
if it **uses the marks** or markets itself as "like GTA" in a way that implies
affiliation. Keep marketing descriptive and comparative at most ("open-world
crime sandbox"), never "a GTA clone" on a store page or in the product name.

## Practical guardrails baked into this repo
1. `grep`-clean of third-party IP terms — no brand/title/character strings in code.
2. 100% procedural art — no `loader`, no asset files, no external URLs except the
   Three.js library CDN (MIT-licensed) that the host game already uses.
3. Original event/system naming throughout.
4. This file, kept current, documenting the posture.
