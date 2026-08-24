# CHLOE

A free browser RPG — a **first-person 3D horror room** (WASD + mouse look, jump, interactive props)
where walking up to the enemy and clicking it starts a **round-based phase battle** with per-phase
move loadouts, 11 damage types, status buildup, a 100-level XP system, and skill trees.
Name + PIN accounts with local saves (optional cloud saves via a Cloudflare Worker).

**Play now:** https://enderpeer.github.io/chloe/ (landing) · https://enderpeer.github.io/chloe/game/ (game)

## Controls

| Input | Action |
|---|---|
| Click canvas | capture mouse (ESC releases) |
| Mouse | look · **WASD** move · **Shift** sprint · **Space** jump |
| Arrows / Q,E | keyboard-only fallback (move + turn) |
| Click enemy (close) | start battle · Click TV | toggle it on/off |
| M / Tab | menu (skill tree, move loadouts, character sheet, inventory, save) |

## Run it locally

It's a fully static site — no build step, no dependencies to install.

```bash
git clone https://github.com/enderPeer/chloe.git
cd chloe
./dev.ps1        # starts a local server on http://localhost:8080 (Windows)
```

Any static server works: `npx http-server -p 8080 .` (Node) or `python -m http.server 8080`.
A server (not `file://`) is required for the 3D mode — browsers block GLTF/HDR loading from `file://`
(the game falls back to simple materials rather than crashing, but you want the real thing).

## Host it yourself (all free)

- **GitHub Pages**: push this repo → repo Settings → Pages → "Deploy from a branch" → `main` / root. Done — the site auto-redeploys on every push to `main`.
- **Cloudflare Pages**: connect the repo in the Cloudflare dashboard → no build command, output directory `/`. Gives you a second URL for redundancy.
- **Anything else**: it's plain static files; copy the folder to any web server.
- **Cloud saves (optional)**: deploy the Worker in [`worker/`](worker/README.md) (free plan; `wrangler login`, create the KV namespace, `wrangler deploy`), then put its URL into `apiUrl` in [`game/js/data/config.js`](game/js/data/config.js). Empty `apiUrl` = local-only saves, fully functional.

## Develop from any PC

1. Clone, start a local server (above), edit, refresh. No compiler, no npm install.
2. **Read [`GAME_SPEC.md`](GAME_SPEC.md) first** — it is the binding design contract (§10 combat phases, §12 progression/types/trees, §13–14 the 3D room). [`ROADMAP.md`](ROADMAP.md) tracks history and decisions.
3. Everything lives on `window.CHLOE` as classic scripts (load order in `game/index.html`):
   - `game/js/data/` — pure content: `moves.js`, `characters.js`, `enemies.js`, `tree.js` (skill trees), `elements.js` (type chart, table in [`tools/typechart.md`](tools/typechart.md)), `items.js`, `room3d.js` (room layout/models)
   - `game/js/engine/` — logic, no DOM: `battle.js` (phase combat), `progression.js`, `tree.js`, `save.js` (accounts/PIN/migrations), `world3d.js` (Three.js room: movement, collision, interaction)
   - `game/js/ui/` — screens/DOM only: `room3d.js`, `battleui.js`, `loadout.js`, `tree.js`, `sheet.js`, `menu.js`, …
4. Common tasks: **add a move** → `moves.js` (+ a learnset level in `characters.js` or a tree node in `data/tree.js`); **add an enemy** → `enemies.js` (+ image in `game/assets/gen/`); **tweak the room** → `game/js/data/room3d.js`.
5. **Asset pipelines** (all free, no keys): AI images via `tools/generate-image.ps1` (Pollinations); 3D models/HDRIs from [Poly Haven](https://polyhaven.com) (CC0) — see `tools/model-manifest.json` + `tools/ATTRIBUTIONS.md` for what's used where.
6. Deploy = push/merge to `main`; GitHub Pages rebuilds automatically (~1 min).

## Repo layout

```
index.html, landing.css   landing page
game/                     the game (vendor/ = three.js r128 + loaders, assets/ = art/models/hdri)
worker/                   Cloudflare Worker for cloud saves (own README)
tools/                    image-gen script, type chart, model manifest, image catalog
GAME_SPEC.md, ROADMAP.md  design contract + history
dev.ps1                   local dev server helper
```

## Third-party

[Three.js](https://threejs.org) r128 (MIT, vendored) · 3D models & HDRI: Poly Haven, CC0 (per-asset list in `tools/ATTRIBUTIONS.md`) · generated images via Pollinations.ai. Character photos are AI-generated originals of this project.
