# AGENTS.md — read this first

You are joining work on **CHLOE**, a browser roguelike. This file is the whole orientation:
what the project is, the rules you must not break, where code lives, and how to prove your
change works. It should take five minutes. Everything deeper is in [`docs/`](docs/README.md).

---

## 1. What you are working on

A **first-person 3D horror game** that runs entirely in a browser tab with **no build step**.
You wake up in a dressing room, walk around in first person, pick a floor off a board on the
wall, and walk into a fight against the **Hollow Black Knight** — a real-time duel where you
move, sprint, crouch, evade and fire abilities off number keys while a squad of armoured
knights hunts you across the floor.

It is a **roguelike**: one run per page load, no accounts, no saves, permadeath.

Three points of texture, because they change how you write code here:

- **Zero build.** No npm install, no bundler, no transpiler. Plain `<script>` tags, ES5-flavoured
  vanilla JS, one global namespace `window.CHLOE`. Start a static server, refresh, done.
- **The spec is binding.** [`GAME_SPEC.md`](GAME_SPEC.md) is a numbered contract (§1 … §30) where
  **later sections supersede earlier ones**. A drop = one new spec section plus the code for it.
- **The comments are the design docs.** This codebase explains *why* in unusual depth, often
  including the bug that motivated a line. Read them before changing anything near them.

---

## 2. The rules (breaking one of these is a bug, not a preference)

1. **No build step, ever.** No npm dependencies, no `import`/`export` modules, no JSX, no
   TypeScript. Classic scripts assigning onto `window.CHLOE`.
2. **Layer discipline.** `js/data/` is content with no logic. `js/engine/` is logic that must never
   touch the DOM. `js/ui/` is DOM and screens only. A `document.` call in `engine/` is a defect.
3. **A new file needs a `<script>` tag.** [`game/index.html`](game/index.html) is a hand-ordered
   load list. Ship a module without its tag and the feature is *dead and silent* — this has
   actually happened (§24). Several tags carry HTML comments explaining why they sit where they do.
4. **No run saves.** No `localStorage` for anything that could resume a dead run. The one
   sanctioned exception is the record board (`chloe.records.v1`), because a leaderboard is an
   artefact *about* finished runs, not a save that restores one.
5. **One clock.** A telegraph's picture and its damage read the *same* numbers. If a wind-up
   shortens, the animation shortens by the identical factor. Two clocks have already lost a
   fight here (§21).
6. **The generated files are generated.** `game/js/data/knightrig.js` comes out of
   `tools/build-knight-rig.js`. Regenerate it; never hand-patch it.
7. **Numbers live in `data/`.** If you are typing a tuning constant into an engine file, it
   belongs in a data file instead. The engines are deliberately free of magic numbers.
8. **Don't whole-file rewrite [`GAME_SPEC.md`](GAME_SPEC.md) or [`ROADMAP.md`](ROADMAP.md).**
   Append or patch in place.

---

## 3. Where everything lives

```
game/index.html          THE LOAD ORDER — every module, hand-sequenced
game/js/data/            content: no logic, no DOM        (what things ARE)
game/js/engine/          logic: no DOM                    (what things DO)
game/js/ui/              screens and DOM only             (what you SEE)
game/vendor/             three.js r128 + GLTF/DRACO/RGBE loaders, vendored
game/assets/             3d/ glb · hdri/ · models/ · chloe/ photos · gen/ generated art
tools/                   dev server, version bumper, rig builder, image gen, manifests
worker/                  legacy Cloudflare Worker (see docs/tooling.md for its real status)
GAME_SPEC.md             the binding contract, §1 … §30
ROADMAP.md               history plus the "don't re-litigate" decisions
docs/                    the wiki — start at docs/README.md
```

The four files you will touch most:

| If you are changing… | Go to |
|---|---|
| a player ability (cost, cast time, damage) | [`game/js/data/abilities.js`](game/js/data/abilities.js) |
| what a level grants the player | [`game/js/data/skilltree.js`](game/js/data/skilltree.js) |
| the knight's swings, brain, or speed scaling | [`game/js/data/arena3d.js`](game/js/data/arena3d.js) |
| what the knight's level buys him | [`game/js/data/knighttree.js`](game/js/data/knighttree.js) |

---

## 4. Run it

Node is the only prerequisite, and only to serve files.

```bash
node tools/devserver.js 8080
```

Then open **http://localhost:8080/game/** (the game) or **http://localhost:8080/** (the landing
page). On Windows `./dev.ps1` does the same thing via `npx http-server`.

**A real server is mandatory.** `file://` blocks GLTF and HDR loading, so the 3D mode silently
degrades to flat materials and you will "verify" something that is not the game.

---

## 5. Prove it works

This repo has verification *contracts*, not vibes. Before you call something done:

1. **Load the game and read the console.** `main.js` runs a `sanityCheck()` that warns about
   dangling ids across data files. Warnings are findings.
2. **Query the live state.** Every engine publishes a debug surface. From the browser console:
   ```js
   CHLOE.data.version.full()          // what build am I actually looking at
   CHLOE.engine.knighttree.spawnLevel('cautious', 5)   // pure — no fight needed
   CHLOE.engine.arena3d.debug()       // knightLevels / knightSeniority / roundSpeed / knightBrain
   CHLOE.engine.combat3.snapshot()    // resources, cooldowns, per-knight enemy levels
   ```
   Modules like `knighttree`, `skilltree` and `progression` are pure functions of a level, so you
   can exercise an entire balance change without entering a battle. The other two need a live
   fight: `arena3d.debug()` returns a much smaller stub until the arena is initialised, and
   `combat3.snapshot()` is `null` outside a round.
3. **Check the spec's own hooks.** Recent `GAME_SPEC.md` sections end with a **Verification**
   block naming what a change must *prove*. Prove those.
4. **Make the probe fail on purpose before you trust it.** Feed it something you know is broken —
   a misspelled personality, a function name with a typo, an out-of-range index — and confirm it
   complains. This codebase degrades rather than throws at almost every boundary, so a probe with
   no failure path hands back a plausible number instead of an error, and you cannot tell that
   output from a real measurement. Six ways it happens, with the tell for each, in
   [`docs/debugging.md`](docs/debugging.md).
5. **A test that never advanced a frame is a failing test.** A headless check with a frozen
   `requestAnimationFrame` will happily report success while nothing ticked. Confirm frames moved.

Full list of hooks and traps: [`docs/debugging.md`](docs/debugging.md).

---

## 6. Ship it

The repo's actual rhythm, readable straight off `git log`:

1. Branch off `main` (`git checkout -b short-kebab-name`).
2. Implement, then **write the spec section** — a drop is a `GAME_SPEC.md` section plus the code
   that satisfies it, and the section states the *why* and the balance consequences out loud.
3. Tick the entry in [`ROADMAP.md`](ROADMAP.md).
4. Commit. Commit subjects here are prose sentences, not conventional-commit prefixes —
   *"A knight levels for every round he comes back"*.
5. Open a PR, then merge to `main`. GitHub Pages redeploys in about a minute.

**Version bumping is automatic**, once per clone:

```bash
git config core.hooksPath tools/hooks
```

After that every commit bumps the build number the player sees on the title screen. When you land
a new spec section, bump the minor to match it — `v0.30.x` *is* "the game as of §30":

```bash
node tools/bump-version.js --minor 31 --label "Your Drop Name"
```

---

## 7. The traps that have actually bitten this repo

| Symptom | Cause |
|---|---|
| Your whole feature does nothing, silently | The module has no `<script>` tag in `game/index.html` |
| The church renders black, or a model looks stale | Cached asset — bump `assetVersion` in `data/arena3d.js` |
| The animation and the damage disagree | Two clocks. Both must read the same data (§21) |
| A model is the wrong size after a rig change | `Box3` lies about skinned meshes — measure from the skeleton (§17) and assert on-screen height (§28 B) |
| The room freezes after closing the shop | Something tidied away `ui/room3d.js`'s `_resume` export. It is load-bearing (§28 D) |
| A "harmless" cleanup broke the hotbar | The five bind stores only mean anything together — reset them through `party.resetBinds()` (§27 A) |
| A round feels wrong after a balance edit | You turned a contract, not a knob. Squad count (§20) and `levelPerRound` are not tuning dials |

---

## 8. The wiki

[`docs/README.md`](docs/README.md) is the index. The pages you are most likely to need:

- [Architecture](docs/architecture.md) — the namespace, the load order, the layer rules
- [The Run Loop](docs/run-loop.md) — how a night actually plays out
- [Real-Time Combat](docs/combat.md) — abilities, resources, the hotbar, damage
- [The Knight](docs/knight-ai.md) — [behaviour](docs/knight-ai.md) · [levels](docs/knight-levels.md) · [rig](docs/knight-rig.md)
- [Difficulty Scaling](docs/difficulty-scaling.md) — count, level and speed
- [Data Reference](docs/data-reference.md) — every schema, plus "how do I add a…" cookbooks
- [Debugging & Verification](docs/debugging.md) — the hooks, and the traps above in detail
