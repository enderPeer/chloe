# CLAUDE.md

**Read [`AGENTS.md`](AGENTS.md) before touching anything.** It is the five-minute orientation:
what CHLOE is, the rules, the layout, how to run it and how to prove a change works. The full
wiki is [`docs/README.md`](docs/README.md).

The short version, so nothing here can be missed:

- **Zero build.** Vanilla ES5-flavoured JS, classic `<script>` tags, one global `window.CHLOE`.
  No npm deps, no bundler, no ES modules, no TypeScript.
- **A new file needs a `<script>` tag** in [`game/index.html`](game/index.html), which is a
  hand-ordered load list. Without it the feature ships dead and *silent*.
- **Layers:** `js/data/` = content only · `js/engine/` = logic, never DOM · `js/ui/` = DOM only.
- **[`GAME_SPEC.md`](GAME_SPEC.md) is binding**, §1 … §30, later sections supersede earlier ones.
  A drop is one new spec section plus the code for it. Don't whole-file rewrite it or `ROADMAP.md`.
- **Roguelike:** no accounts, no run saves, permadeath. The only sanctioned `localStorage` key is
  the record board.
- **Tuning constants live in `js/data/`**, never in an engine file.
- Run it with `node tools/devserver.js 8080` → http://localhost:8080/game/. A real server is
  required; `file://` silently degrades the 3D mode.
