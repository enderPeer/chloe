# CHLOE

A free browser **roguelike RPG** — a **first-person 3D horror room** (WASD + mouse look, jump,
crouch, hands you grab things with) where walking up to the enemy drags you into an **old church**
to fight the **Hollow Black Knight**: your whole band picks their attacks turn-based, then the
knight swings back and you must physically dodge it — crouch under the slash, sidestep the charge.
11 damage types, status buildup, a 100-level XP system, and skill trees underneath.
**One run per page load** — no accounts, no saves; death (or a reload) starts the night over at level 1.

**Play now:** https://enderpeer.github.io/chloe/ (landing) · https://enderpeer.github.io/chloe/game/ (game)

## Controls

| Input | Action |
|---|---|
| Click canvas | capture mouse (ESC releases) |
| Mouse | look · **WASD** move · **Shift** sprint · **Space** jump · **Ctrl / C** crouch |
| Left / right click | close your left / right hand — look at a glinting item and click to take it |
| Arrows / Q,E | keyboard-only fallback (move + turn) |
| Click enemy (close) | start the church battle · Click TV | toggle it on/off |
| In battle | pick each bandmate's attack, then **dodge** the knight: crouch under slashes, sidestep lanes |
| M / Tab | menu (skill tree, move loadouts, character sheet, inventory) |

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
- ~~Cloud saves~~: dropped — the game is a roguelike now and saves nothing. [`worker/`](worker/README.md) is kept for reference only and is safe to delete.

## Develop from any PC

1. Clone, start a local server (above), edit, refresh. No compiler, no npm install.
2. **Read [`GAME_SPEC.md`](GAME_SPEC.md) first** — it is the binding design contract (§10 combat phases, §12 progression/types/trees, §13–14 the 3D room, §15 the roguelike rules, §16 the church arena battles). [`ROADMAP.md`](ROADMAP.md) tracks history and decisions.
3. Everything lives on `window.CHLOE` as classic scripts (load order in `game/index.html`):
   - `game/js/data/` — pure content: `moves.js`, `characters.js`, `enemies.js`, `tree.js` (skill trees), `elements.js` (type chart, table in [`tools/typechart.md`](tools/typechart.md)), `items.js`, `room3d.js` (room layout/models), `arena3d.js` (church arena + the knight's attack patterns)
   - `game/js/engine/` — logic, no DOM: `arena.js` (arena battle rules), `arena3d.js` (church scene + dodge hit tests), `world3d.js` (Three.js room: movement, collision, hands, interaction), `battle.js` (legacy 2D phase combat), `progression.js`, `tree.js`
   - `game/js/ui/` — screens/DOM only: `room3d.js`, `battle3d.js` (arena HUD + round loop), `battleui.js`, `loadout.js`, `tree.js`, `sheet.js`, `menu.js`, …
4. Common tasks: **add a move** → `moves.js` (+ a learnset level in `characters.js` or a tree node in `data/tree.js`); **add an enemy** → `enemies.js` (+ image in `game/assets/gen/`); **tweak the room** → `game/js/data/room3d.js`; **retune the knight's swings** (windup times, lane sizes, damage) → `game/js/data/arena3d.js`.
5. **Asset pipelines** (all free, no keys): AI images via `tools/generate-image.ps1` (Pollinations); 3D models/HDRIs from [Poly Haven](https://polyhaven.com) (CC0) — see `tools/model-manifest.json` + `tools/ATTRIBUTIONS.md`. The church and knight in `game/assets/3d/` were converted from user-supplied source archives with Blender (headless: relink textures → downscale to 1k → Draco → GLB).
6. Deploy = push/merge to `main`; GitHub Pages rebuilds automatically (~1 min).

## Versioning

The version shown on the title screen and in the in-game menu lives in one place:
[`game/js/data/version.js`](game/js/data/version.js) (`major.minor.build` — `minor` tracks the
`GAME_SPEC.md` section the build implements, so `v0.23.x` *is* "the game as of §23").

**The build number bumps on every push, automatically.** Enable the hook once per clone:

```bash
git config core.hooksPath tools/hooks
```

After that every commit runs [`tools/bump-version.js`](tools/bump-version.js) and stages the bump
with it. Manual use:

```bash
node tools/bump-version.js --minor 24 --label "New Drop"
```

`--print` shows the current version without changing anything, and `SKIP_VERSION_BUMP=1 git commit`
skips a bump for one commit. The hook never blocks a commit: if node is missing it warns and lets it through.

## Repo layout

```
index.html, landing.css   landing page
game/                     the game (vendor/ = three.js r128 + loaders, assets/ = art/models/hdri/3d)
worker/                   legacy cloud-save Worker — unused since the roguelike pivot
tools/                    image-gen script, type chart, model manifest, image catalog
GAME_SPEC.md, ROADMAP.md  design contract + history
dev.ps1                   local dev server helper
```

## Third-party

[Three.js](https://threejs.org) r128 (MIT, vendored) · 3D models & HDRI: Poly Haven, CC0 (per-asset list in `tools/ATTRIBUTIONS.md`) · generated images via Pollinations.ai. Character photos are AI-generated originals of this project.