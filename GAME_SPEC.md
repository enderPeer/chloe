# CHLOE — Game Spec v1 (single source of truth)

Dark urban-fantasy RPG adventure in the browser. Point-and-click exploration over the 111
photoreal "Chloe" images + turn-based battles (Final Fantasy / Pokémon hybrid).
100% free hosting: static site (GitHub Pages + Cloudflare Pages) + optional Cloudflare Worker for cloud saves.

## 1. Tech rules (MANDATORY)
- Vanilla HTML/CSS/JS. **No build step, no npm deps, no ES modules, no fetch() for local data.**
- Everything must work when opened via `file://` AND from any static host (relative paths only).
- Classic `<script>` tags in a fixed order. Single global namespace: `window.CHLOE = { data:{}, engine:{}, ui:{} }`.
- Each data file assigns into the namespace, e.g. `CHLOE.data.skills = {...}`.
- No external requests at runtime except the optional cloud-save API (`CHLOE.data.config.apiUrl`, empty string = local-only mode, must never error).
- Google Fonts allowed via <link> but every font MUST have a system fallback (page must look fine offline/file://).
- Target: desktop + mobile responsive. No console errors on load.

## 2. File structure & ownership (agents: touch ONLY your files)
```
/index.html, /landing.css            → LANDING agent
/game/index.html, /game/css/game.css → GAME agent
/game/js/main.js                     → GAME agent
/game/js/data/*.js                   → GAME agent, EXCEPT story.js, scenes.js, portraits.js
/game/js/data/{story,scenes,portraits}.js → STORY agent
/game/js/engine/*.js, /game/js/ui/*.js    → GAME agent
/game/assets/chloe/Chloe001..111.jpg → existing art (never modify)
/game/assets/gen/*.jpg               → ASSETS agent (generated enemies etc.)
/worker/*                            → WORKER agent
/tools/catalog/*.json                → CATALOG agents
/tools/generate-image.ps1, /tools/IMAGEGEN.md → ASSETS agent
```
`game/index.html` loads scripts in this order:
`data/config.js, data/elements.js, data/portraits.js, data/characters.js, data/skills.js, data/weapons.js, data/items.js, data/enemies.js, data/story.js, data/scenes.js, engine/save.js, engine/progression.js, engine/party.js, engine/inventory.js, engine/battle.js, ui/ui.js, ui/title.js, ui/account.js, ui/dialog.js, ui/scene.js, ui/battleui.js, ui/menu.js, main.js`
(GAME agent may merge/rename ui files but must keep story.js/scenes.js/portraits.js as separate STORY-owned files and load them.)

## 3. Lore (fixed — do not invent conflicting names)
- **Chloe** (19) — protagonist. Street musician. Element **Ember**. Weapon: razor guitar "Crimson Fret".
- **Ash** — Chloe's sister & bandmate (the second girl in the duo photos). Element **Volt**. Weapon: switchblade "Livewire". Joins the party in the intro; switchable in battle.
- Setting: the **Velvet District** at night. Home base: nightclub **The Red Room**. After midnight its red corridors loop into the **Backstage Between** — a shadow otherworld that steals sound and memory.
- Goal of Act 1: find who/what is hollowing out the club's people; get out of the looping halls.
- **First enemy: "Neon Wisp"** (Shadow, lvl 1) in the red corridor. Early boss: **"The Promoter"** (Shadow, lvl 4).
- Currency: **Shards** (shards of the club's broken mirror wall). Earned after every won battle.
- Tone: moody, cinematic, a little wry. PG-13. The photos are the world — treat them as film stills.

## 4. Elements
`ember > frost > volt > ember` (2.0x following the arrow, 0.5x against it). `shadow ⇄ light` deal 2.0x to each other. Everything else 1.0x. Neutral element `none` exists for basic attacks/enemies.
`CHLOE.data.elements.multiplier(att, def) -> number`.

## 5. Data schemas (exact)
```js
// characters.js  CHLOE.data.characters = { chloe: {...}, ash: {...} }
{ id, name, element, portrait: CHLOE.data.portraits.chloe /*resolved at use, not load*/,
  base:{hp,mp,atk,def,spd,mag}, growth:{hp,mp,atk,def,spd,mag} /*per level*/,
  skillsByLevel:{1:['strike'], 2:['power_chord'], ...}, weaponId }
// skills.js  CHLOE.data.skills = { id:{...} }
{ id, name, element, kind:'attack'|'heal'|'buff', power /*% of atk or mag*/, usesMag:bool,
  mpCost, target:'enemy'|'ally'|'self'|'allEnemies', desc }
// items.js — usable in & out of battle
{ id, name, effect:{hp?:n, mp?:n, revivePct?:n}, price, desc, icon /*emoji*/ }
// weapons.js
{ id, name, atkBonus, element|null, price, desc }
// enemies.js  CHLOE.data.enemies
{ id, name, image, element, level, stats:{hp,mp,atk,def,spd,mag}, skills:[ids],
  ai:'basic', rewards:{ xp, shards, drops:[{itemId, chance}] } }
// scenes.js  CHLOE.data.scenes = { sceneId:{...} }  (STORY agent)
{ id, name, bg:'assets/chloe/ChloeXXX.jpg', intro /*shown first visit*/,
  hotspots:[ { x,y,w,h /*percent 0-100 of image box*/, label,
      action:{ type:'goto'|'dialog'|'battle'|'pickup'|'heal'|'story',
               scene?, dialogId?, enemyId?, itemId?, storyId?, once?:bool, requiresFlag?, setsFlag? } } ] }
// story.js (STORY agent)
CHLOE.data.dialogs = { dialogId: [ {speaker:'chloe'|'ash'|'???'|name, text, portrait?:'chloe'|'ash'} ] }
CHLOE.data.story = { startScene, introDialog, onFirstVictoryDialog, flags:{} /*doc of flag names*/ }
// portraits.js (STORY agent) — best face shots picked from catalog
CHLOE.data.portraits = { chloe:'assets/chloe/ChloeXXX.jpg', ash:'assets/chloe/ChloeYYY.jpg' }
```

## 6. Systems
**Progression**: `xpToNext(level) = Math.round(25 * Math.pow(level, 1.5))`. On level-up: stats += growth, full skill list = union of skillsByLevel ≤ level, show "learned X!" toast. Cap 50.
**Battle** (`CHLOE.engine.battle`): 1 active party member vs 1 enemy; turn order by spd (tie → player).
Player commands: **Attack** (basic, element none, 100% atk) / **Skills** (MP) / **Items** / **Switch** (change active member, uses the turn) / **Give Up** (flee: 70% success, else enemy free hit; cannot flee boss fights — battle action `boss:true` later).
Damage: `max(1, round((usesMag?mag:atk+weaponAtk) * power/100 * elemMult * (0.85..1.15 rand) - def*0.5))`. Fallen ally auto-forces Switch if another alive; all fallen → defeat screen → respawn at start scene with full HP, lose 30% shards.
Victory: xp + shards + drops, level-up check, `onFirstVictoryDialog` after the first ever win.
**Economy**: shards from battles; shop system deferred to a later prompt (items have prices already).
**Accounts & saves** (`CHLOE.engine.save`): accounts in `localStorage['chloe.accounts']`; save per account in `localStorage['chloe.save.'+name]`. Create: name (1-16 chars) + 4-digit PIN. `pinHash = SHA-256(lower(name)+':'+pin)` via WebCrypto (async). Login: pick account, enter PIN. Autosave on scene change & battle end.
Cloud sync (only if `config.apiUrl` set): `POST {api}/register {name,pinHash}`, `POST {api}/login {name,pinHash}`, `POST {api}/save {name,pinHash,save}`, `POST {api}/load {name,pinHash}` → merge by newest `savedAt`. Fail silently to local mode.
Save blob: `{ v:1, name, savedAt, party:[{id,level,xp,hp,mp,weaponId}], activeId, inventory:{itemId:count}, shards, flags:{}, scene }`.

## 7. Screens (CHLOE.ui, one `<div id=screen-*>` each, router `CHLOE.ui.show(name)`)
title → account (list/create/login with PIN pad) → intro dialog → **scene** (point-and-click: full-bleed bg image, hotspots as positioned divs with hover glow + label tooltip; bottom dialog box with typewriter text + portrait; top HUD: shards ◆, menu button) → **battle** (enemy image top/right, party member portrait + HP/MP bars, command buttons, scrolling battle log, damage pop numbers, screen-shake on hit) → menu overlay (Party / Inventory / Save / How to play). Defeat & victory panels. Smooth CSS transitions.

## 8. Visual style
Palette: bg `#0a0a0c`, panel `#141317`, red accent `#e5173f`, deep red `#7a0c22`, text `#f2eef0`, dim `#9a939c`. Font: headers 'Bebas Neue'/'Oswald' w/ `Impact, "Arial Narrow", sans-serif` fallback; body system-ui stack. Look: neon-noir nightclub — red glows, film grain vignette overlay, subtle CRT scanline on battle screen. Buttons: dark w/ red border, red fill on hover. Everything responsive (flex/grid, `clamp()`).

## 9. Hosting (all free)
GitHub Pages serves repo root (`/index.html` landing links relatively to `game/`). Cloudflare Pages serves the same repo → second URL (redundancy if one is down). Worker (free plan, workers.dev) + KV namespace `CHLOE_KV` for cloud saves; `game/js/data/config.js` holds `apiUrl` (default `''`).
