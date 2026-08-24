# CHLOE — Roadmap

- [x] **P1 — Foundation**: GAME_SPEC.md, image catalog, full game v1 (point-and-click scenes, battles, party/switch, items, give-up, XP/levels/skills, Shards currency, name+PIN accounts), landing page, Cloudflare Worker code, free image-gen pipeline (Pollinations), git repo.
- [ ] **P2 — Go live**: GitHub repo + Pages (landing+game) ✔ live, Cloudflare Pages mirror (second URL) pending, fix anything found on live. ~~Worker + KV cloud saves~~ (dropped — roguelike pivot, no saves).
- [x] **P3 — Combat v2 + The Room**: phase-based fighting (neutral/aggressive/guarded/staggered/charged), four move categories (attack/defense/stance/status), per-phase loadouts capped at 5, learnsets, loadout editor; new one-room horror opening (generated dressing room, clickable items, the_hollow enemy, solo Chloe start, Ash joins after clear). Spec sections 10-11.
- [x] **P4 — Progression v3**: 100-level cap with new XP curve, 11 damage types (physical/magical/lightning/fire/occult/blood/poison/divine/virus/ghost/biological) + authored type chart, 4 resources (Life/Stamina/Magic/Faith), buildup-based status system (burn/shock/bleed/poisoned/curse/infection/haunt), 45-60-node skill trees per character (3 branches, keystones, respec), skill points, character sheet, save v3. Spec section 12.
- [x] **P5 — Room3D**: pivot to first-person 3D (Three.js r128 vendored, zero build kept): one 3D dressing room with generated textures, WASD + mouse-look + keyboard fallback, AABB collision, luminance-keyed ghost billboard enemy — click it to enter the v3 round battle. Story/2D scene flow unrouted (code kept). Spec section 13.
- [x] **P5.5 — Roguelike pivot**: accounts/PIN/saves removed entirely (account.js + save.js deleted, no localStorage, no cloud); title -> straight into a fresh run; permadeath — defeat shows a run summary (level / shards / fights won) and "Begin again" restarts at level 1; page reload = new run. Spec section 14.
- [x] **P5.6 — Arena battles**: battles moved into 3D — real church asset (draco glb) + "Hollow Black Knight" (dark-knight asset, procedurally animated); turn-based attack picks for the whole band, then the knight's telegraphed swing must be DODGED in the room (crouch under slashes, sidestep lanes); first-person hands (LMB/RMB close left/right hand), Ctrl crouch, grab-in-motion item pickups in the dressing room; Blender LTS via winget as the asset pipeline. Spec section 15.
- [ ] **P6 — Content & depth**: shop (spend Shards), more rooms/enemies, boss polish, sound/music.
- [ ] **P7 — Polish**: animations, mobile UX, balance pass, achievements.
- [ ] **P8 — Feedback round**: whatever the playtest surfaces.
- [ ] **P9 — Release QA**: final sweep, README/landing final, version 1.0.

## Key decisions (don't re-litigate)
- Zero-build vanilla JS, classic scripts, `window.CHLOE.*` namespace, runs from `file://` and any static host.
- **Roguelike (spec §14): no accounts, no persistence.** One run per page load, permadeath. The cloud-save Worker/KV plan is dead (`worker/` kept only as reference).
- Hosting free: GitHub Pages (primary) + Cloudflare Pages (mirror).
- Art: 111 existing photos in `game/assets/chloe/` (catalog in `tools/catalog/`); new art via `tools/generate-image.ps1` (Pollinations.ai, free, keyless).
- Machine: Windows 11, gh CLI authenticated; Node LTS installed.
