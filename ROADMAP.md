# CHLOE — Roadmap (≈7 prompts)

- [x] **P1 — Foundation**: GAME_SPEC.md, image catalog, full game v1 (point-and-click scenes, battles, party/switch, items, give-up, XP/levels/skills, Shards currency, name+PIN accounts), landing page, Cloudflare Worker code, free image-gen pipeline (Pollinations), git repo.
- [ ] **P2 — Go live**: GitHub repo + Pages (landing+game), Cloudflare Pages mirror (second URL), deploy Worker + KV (cloud saves), fix anything found on live.
- [ ] **P3 — Content**: shop (spend Shards), more scenes/Act 2, more enemies/skills/weapons, boss polish.
- [ ] **P4 — Battle depth**: status effects, multi-enemy fights, smarter AI, sound/music.
- [ ] **P5 — Polish**: animations, mobile UX, balance pass, achievements.
- [ ] **P6 — Feedback round**: whatever the playtest surfaces.
- [ ] **P7 — Release QA**: final sweep, README/landing final, version 1.0.

## Key decisions (don't re-litigate)
- Zero-build vanilla JS, classic scripts, `window.CHLOE.*` namespace, runs from `file://` and any static host.
- Hosting free: GitHub Pages (primary) + Cloudflare Pages (mirror) + CF Worker `chloe-api` + KV for cloud saves. `game/js/data/config.js` → `apiUrl` (empty = local-only).
- Art: 111 existing photos in `game/assets/chloe/` (catalog in `tools/catalog/`); new art via `tools/generate-image.ps1` (Pollinations.ai, free, keyless).
- Machine: Windows 11, no gh CLI; Node LTS installed via winget (for wrangler).
