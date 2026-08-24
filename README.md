# CHLOE

A free browser **roguelike RPG** — a first-person 3D room crawl where battles drag you
into an old church: your whole band picks their attacks turn-based, then the **Hollow
Black Knight** swings back and you must physically dodge it — crouch under the slash,
sidestep the charge. Items you grab with your own two hands, 100 levels, skill trees,
a Shards currency. One run per page load: no accounts, no saves — death (or a reload)
starts the night over from level 1.

**Play locally:** open `index.html` (landing) or `game/index.html` (game) in any browser — no install, no build.

## Structure
- `index.html` + `landing.css` — landing page (GitHub Pages root)
- `game/` — the game (vanilla JS, no build step)
- `worker/` — legacy cloud-save Worker (unused since the roguelike pivot — safe to delete)
- `tools/` — image catalog + free image generator (`generate-image.ps1`, Pollinations.ai)
- `GAME_SPEC.md` — design contract · `ROADMAP.md` — plan

## Hosting (all free)
GitHub Pages serves this repo as-is; Cloudflare Pages mirrors it for a second URL.
