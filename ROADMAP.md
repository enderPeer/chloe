# CHLOE — Roadmap (≈7 prompts)

- [x] **P1 — Foundation**: GAME_SPEC.md, image catalog, full game v1 (point-and-click scenes, battles, party/switch, items, give-up, XP/levels/skills, Shards currency, name+PIN accounts), landing page, Cloudflare Worker code, free image-gen pipeline (Pollinations), git repo.
- [ ] **P2 — Go live**: GitHub repo + Pages (landing+game), Cloudflare Pages mirror (second URL), deploy Worker + KV (cloud saves), fix anything found on live.
- [x] **P3 — Combat v2 + The Room**: phase-based fighting (neutral/aggressive/guarded/staggered/charged), four move categories (attack/defense/stance/status), per-phase loadouts capped at 5, learnsets, loadout editor; new one-room horror opening (generated dressing room, clickable items, the_hollow enemy, solo Chloe start, Ash joins after clear). Spec sections 10-11.
- [x] **P4 — Progression v3**: 100-level cap with new XP curve, 11 damage types (physical/magical/lightning/fire/occult/blood/poison/divine/virus/ghost/biological) + authored type chart, 4 resources (Life/Stamina/Magic/Faith), buildup-based status system (burn/shock/bleed/poisoned/curse/infection/haunt), 45-60-node skill trees per character (3 branches, keystones, respec), skill points, character sheet, save v3. Spec section 12.
- [x] **P5 — Room3D**: pivot to first-person 3D (Three.js r128 vendored, zero build kept): one 3D dressing room with generated textures, WASD + mouse-look + keyboard fallback, AABB collision, luminance-keyed ghost billboard enemy — click it to enter the v3 round battle. Story/2D scene flow unrouted (code kept). Spec section 13.
- [ ] **P6 — Content & depth**: shop (spend Shards), more rooms/enemies, boss polish, sound/music.
- [ ] **P5 — Polish**: animations, mobile UX, balance pass, achievements.
- [ ] **P6 — Feedback round**: whatever the playtest surfaces.
- [ ] **P7 — Release QA**: final sweep, README/landing final, version 1.0.

## Key decisions (don't re-litigate)
- Zero-build vanilla JS, classic scripts, `window.CHLOE.*` namespace, runs from `file://` and any static host.
- Hosting free: GitHub Pages (primary) + Cloudflare Pages (mirror) + CF Worker `chloe-api` + KV for cloud saves. `game/js/data/config.js` → `apiUrl` (empty = local-only).
- Art: 111 existing photos in `game/assets/chloe/` (catalog in `tools/catalog/`); new art via `tools/generate-image.ps1` (Pollinations.ai, free, keyless).
- Machine: Windows 11, no gh CLI; Node LTS installed via winget (for wrangler).
