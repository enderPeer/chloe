# CHLOE

A free browser RPG — point-and-click adventure through 111 cinematic stills, with turn-based
battles (Final Fantasy / Pokémon style), party switching, items, leveling & skills, a Shards
currency, and name+PIN accounts with optional cloud saves.

**Play locally:** open `index.html` (landing) or `game/index.html` (game) in any browser — no install, no build.

## Structure
- `index.html` + `landing.css` — landing page (GitHub Pages root)
- `game/` — the game (vanilla JS, no build step)
- `worker/` — Cloudflare Worker for cloud saves (see `worker/README.md`)
- `tools/` — image catalog + free image generator (`generate-image.ps1`, Pollinations.ai)
- `GAME_SPEC.md` — design contract · `ROADMAP.md` — plan

## Hosting (all free)
GitHub Pages serves this repo as-is; Cloudflare Pages mirrors it for a second URL.
Cloud saves: deploy `worker/` (free plan) and set `apiUrl` in `game/js/data/config.js`.
