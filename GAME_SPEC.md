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
**Battle**: SUPERSEDED by section 10 (Combat v2 — phases & moves). Unchanged from v1: 1 active member vs 1 enemy, spd turn order (tie → player), Items/Switch/Give Up commands, KO/forced switch, victory rewards & defeat/respawn rules below.
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

## 10. Combat v2 — Phases & Moves (supersedes skills.js schema and v1 battle rules)

### Phases
Each combatant (party member AND enemy) is always in exactly one phase:
`neutral` | `aggressive` | `guarded` | `staggered` | `charged`.
Modifiers: aggressive deals x1.25 / takes x1.15; guarded takes x0.60; staggered deals x0.75 / takes x1.25; charged next attack x1.5 (then phase is consumed -> neutral); neutral x1.0. Battle always starts both sides neutral. Phase badges shown for both sides at all times.

### Move schema (game/js/data/moves.js — REPLACES skills.js, which is deleted)
```js
CHLOE.data.moves = { id: { id, name, cat:'attack'|'defense'|'stance'|'status',
  element /*'ember'|'frost'|'volt'|'shadow'|'light'|'none'*/, power /*attack only, % of atk|mag*/,
  usesMag:bool, accuracy /*0-1*/, mpCost, usableIn:['neutral','aggressive',...],
  blocks:{cats:[],elements:[]} /*defense only: what it blocks*/,
  stanceTo:'aggressive'|'guarded'|'charged' /*stance only*/,
  effect:{ hpPct?|mp?|buff?|debuff?|dot? , stat?, amount?, turns? } /*status/defense extras*/,
  desc } }
```

### Loadouts — the 5-move rule
Per character, per phase, the player equips up to **5 moves** chosen from moves that are BOTH learned (level >= learnset entry) AND list that phase in `usableIn`. Stored in save: `loadouts:{charId:{phaseId:[<=5 ids]}}`. Characters define `learnset:{level:[moveIds]}` (replaces skillsByLevel) and `defaultLoadouts` (auto-applied on new game / when a save lacks them). New moves learned on level-up are auto-equipped into matching phases that have a free slot, else left unequipped with a toast. Menu gets a **Loadout editor**: pick character -> phase tabs -> grid of learned moves (cat icon, element, cost, desc) -> tap to equip/unequip, live count x/5, invalid picks disabled.

### Resolution (engine order — implement exactly)
Sequential turns by spd as v1. When a combatant uses a move:
1. Pay MP (insufficient MP = move not selectable).
2. `stance`: set own phase to `stanceTo`, apply optional effect. Done.
3. `status`: apply effect (buff/debuff 3 turns, dot 3 turns, heal instant). No phase change.
4. `defense`: own phase -> `guarded`; register block `{cats, elements}` lasting until the start of this combatant's NEXT turn; optional effect (e.g. small heal, counter thorns).
5. `attack`: accuracy roll — miss => attacker -> `staggered`, log "whiff", done. If defender has an active block matching the move's cat OR element: damage x0.2, attacker -> `staggered`, defender stays `guarded`, done. Else damage = v1 formula x elements.multiplier x attacker-phase deal-mod x defender-phase take-mod (charged: x1.5 then attacker charged->neutral). Then by raw element multiplier: >=2.0 => defender -> `staggered` AND attacker -> `aggressive`; <=0.5 => defender -> `aggressive` (shrugged it off) and attacker aggressive->neutral; else no change.
6. `staggered` recovery: when a staggered combatant finishes any turn, they return to `neutral` at the start of their next turn.
7. Failsafes ALWAYS appended to the battle menu regardless of loadout: **Struggle** (attack, none, power 60, acc 1.0, 0 MP, usable in every phase) and **Recover** (stance -> neutral, +5% HP, only shown while staggered). A phase with 0 equipped usable moves still offers these.

### Battle API (contract between engine and UI — battle.js owns state, battleui.js only renders)
`CHLOE.engine.battle.start(enemyId, opts)` -> state. `state`: {enemy, playerPhase, enemyPhase, blocks, over, result, turn}. Actions: `.act(moveId)`, `.item(itemId)`, `.switchTo(charId)`, `.flee()` — each resolves the full exchange and returns an ordered event array for the UI to animate: `[{t:'move'|'dmg'|'block'|'miss'|'phase'|'status'|'ko'|'switch'|'end', side:'p'|'e', ...detail}]`. `CHLOE.engine.battle.menu()` -> the current <=5 equipped+usable moves (+failsafes) with `disabled` flags (MP). UI never computes rules.

### Enemies
Enemy schema gains `moveset:[moveIds]` (3-5, from the same moves.js pool) replacing `skills`, and AI 'phased': if staggered -> Recover or best attack; prefer super-effective attack vs current player element; if player is `charged` and enemy has a defense move -> 60% use it; if own HP < 30% and has heal/status -> 40% use it; otherwise random equipped attack. Bosses unchanged: no flee.

### Save v2 + migration
Save blob v:2 adds `loadouts`. Loading a v:1 save (or missing/invalid loadouts / >5 entries / unlearned ids) silently rebuilds from `defaultLoadouts` + learned level. Everything else unchanged.

### UI requirements
Battle screen adds: phase badge next to each HP bar (color-coded: neutral #9a939c, aggressive #e5173f, guarded #3d9bdc, staggered #d8a31a, charged #a44ce0) with a one-line tooltip; move buttons show cat icon (attack crossed swords, defense shield, stance footprints, status sparkle), element color dot, MP cost; effectiveness/block/phase-shift events get log lines AND floating labels ("SUPER", "BLOCKED", "STAGGERED!"). How-to-play rewritten to explain the phase loop in plain words. Loadout editor reachable from menu overlay AND from a "Moves" button on the battle screen (read-only during battle).

### Balance targets
Neon Wisp still dies to a lvl-1 default loadout in 3-5 exchanges; a player who never opens the loadout editor must be able to finish Act 1 on defaults; each character learns 12-16 moves by lvl 10 spread across all four categories (Chloe ember/light lean, Ash volt/shadow lean); phase play (stance into charged, guard-then-punish) should beat mindless attacking by roughly 30% fewer turns.

## 11. The Room — one-room horror start (supersedes the old opening; old scenes stay as the world behind the door)
The game now starts in ONE generated horror room and stays there until it is cleared. Super small, dense, fully interactive.
- Scene id `the_room` ("The Dressing Room"). BG: generated image `assets/gen/room-dressing.jpg` (wide, 1152x768): the Red Room dressing room gone wrong — deep red emergency light, broken vanity mirror, old CRT TV static, torn couch, guitar case, scattered polaroids, door ajar into darkness. Horror-movie still.
- Asset agent generates the room + views it + writes `tools/room-manifest.json`: `{bg, items:[{id,label,x,y,w,h,kind}]}` — x/y/w/h in PERCENT, hand-mapped to the items ACTUALLY VISIBLE in the generated image (must include mirror, door, couch + 3-5 more). Every visible item gets a clickable area.
- Hotspots (story agent, coords from manifest): mirror → first battle vs **the_hollow** (once, setsFlag `roomCleared`, intro dialog before); door → locked dialog while `!roomCleared` (Ash pounding, muffled, outside), goto `stage` when `roomCleared`; couch → heal; guitar case → pickup bandage (once); every other mapped item → unsettling examine dialog. Old scenes/dialogs unchanged beneath.
- Story: startScene `the_room`. New 6-8 line intro: Chloe wakes alone after the gig, door locked, Ash's voice wrong through the door, no sound from the club. Tone: horror, wry. Victory: mirror shatters, door clicks open.
- Party: new game starts **solo Chloe**. When `roomCleared` is set, Ash joins (engine hook on battle victory flag; toast "Ash joined"). Battle Switch is hidden/disabled while party size is 1. Old saves with both members keep working.
- New enemy `the_hollow` (enemies.js): a hollowed-out stagehand, shadow, lvl 1, image `assets/gen/enemy-the-hollow.jpg` (generated), moveset from moves.js, beatable by solo lvl-1 Chloe on the default loadout in 3-6 exchanges, drops a bandage 50%. It replaces neon_wisp as the first story fight (neon_wisp and the rest stay for the world beyond).
- Scene UI: hotspots must read as ITEMS: a faint pulsing red glint marker on each interactable, stronger outline + label on hover/tap. (scene.js + css.)

## 12. Progression v3 — 100 levels, 11 damage types, skill trees, statuses, 4 resources (supersedes sec 4 and parts of 5/6/10)

### Resources (per character; replace plain hp/mp)
**life** (was hp), **stamina** (physical resource; regenerates 20% of max at the start of that combatant's turn), **magic** (was mp), **faith** (starts each battle at 3, max base+tree; +1 at the start of your turn; spent by divine/occult moves). Moves declare `cost:{sta?, mp?, faith?}` — physical-cat moves cost stamina (10-25), spells cost magic, divine/occult moves cost faith (1-3). Failsafes stay free. Core stats atk/def/spd/mag unchanged (base + growth per level + tree nodes).

### Damage types — CHLOE.data.types (rewrite of elements.js; keep a back-compat alias CHLOE.data.elements.multiplier)
Exactly these 11: `physical, magical, lightning, fire, occult, blood, poison, divine, virus, ghost, biological`.
Old->new migration everywhere: none->physical, ember->fire, volt->lightning, shadow->occult, light->divine, frost->magical.
`types.multiplier(atkType, defender)` uses defender primary `type` plus optional `resists:{type:mult}` overrides.
Chart: data agent authors the full 11x11 chart (default 1.0, overrides 2.0/0.5) and documents it as a table in `tools/typechart.md`. MANDATORY anchors: occult<->divine mutual 2.0; ghost RESISTS physical/blood/poison (0.5) and TAKES 2.0 from divine and magical; biological TAKES 2.0 from fire/poison/virus; virus TAKES 2.0 from fire/divine; every type must END UP WITH >=2 offensive strengths and >=2 offensive weaknesses; no type may exceed 4 strengths. Keep it thematic and coherent.

### Status system (buildup meters)
7 statuses tied to types: burn(fire), shock(lightning), bleed(blood), poisoned(poison), curse(occult), infection(virus), haunt(ghost). Moves may carry `buildup:{status, amount}`. Each combatant has per-status buildup 0-100, decaying 10/turn; at 100 the meter resets and the status ACTIVATES: burn 8% life/turn 3t; shock -25% spd + 30% skip-turn 2t; bleed instant 15% life + 5%/turn 2t; poisoned 5%/turn 5t; curse -20% mag + faith gain stopped 3t; infection healing halved + -15% atk 3t; haunt 20% move whiff 2t. One instance max per status (re-trigger refreshes). All statuses AND buildup clear at battle end. New items: antidote (cures poisoned/infection, 25), tourniquet (cures bleed/burn, 25), sage_smoke (cures curse/haunt/shock, 40). Tree passives grant statusResist (reduces buildup taken %) and type resists.

### Levels & XP — cap 100
`xpToNext(L) = Math.round(22 * Math.pow(L, 1.75))`. Enemy xp reward = round(baseXp * level^1.35 / 2 + 10). Level-up: +growth, **+1 skill point**, toast, autosave. Learnset keeps working for levels 1-10 (early moves); everything beyond comes from the tree.

### Skill trees — game/js/data/tree.js, CHLOE.data.trees
Per character 45-60 nodes in 3 themed branches + a small shared trunk (Chloe: Pyre fire/attack, Voice divine/faith/support, Steel physical/defense; Ash: Storm lightning, Veil occult/ghost, Toxin poison/virus/blood). Node schema:
`{ id, branch, name, desc, cost /*1-3 points*/, requires:[nodeIds] /*any-of; [] = root*/, pos:{x,y} /*percent layout*/, kind:'stat'|'move'|'passive'|'keystone', grant }`
grant by kind: stat -> `{stat:{life?,stamina?,magic?,faith?,atk?,def?,spd?,mag?}}`; move -> `{move:moveId}` (joins learned pool; 5-per-phase equip rules unchanged); passive -> `{passive:{resist?:{type:pct}, statusResist?:{status:pct}, staminaRegenPct?, onKillLifePct?, blockPower?, ...}}`; keystone -> one build-defining passive, document in desc. Save: `tree:{charId:[nodeIds]}`, `skillPoints:{charId:n}`. Respec (in tree screen): refund ALL nodes for shards = 10*level.
Engine: `CHLOE.engine.tree` — owned(), canBuy(), buy(), respec(), and `effectiveStats(member)` aggregating base+growth+weapon+tree (battle, sheet and save all consume this; never raw base).

### UI additions
- **Skill tree screen** (ui/tree.js, from menu): character picker, branch-colored node graph laid out by pos in a pan/scrollable container with connecting lines (SVG or CSS), node states owned/available/locked, tap -> tooltip card (name, cost, grant, requires) -> Buy button, points counter, respec button with confirm. Mobile-friendly.
- **Character sheet** (ui/sheet.js, from menu Party): 4 resource bars, core stats, compact 11-type resistance grid, active learnset+tree moves count, skill points, weapon.
- **Battle**: under each fighter add stamina (green) / magic (blue) / faith (gold) bars beside life (red); status icons with buildup rings and floating "BLEED!"-style triggers; move buttons show type dot + cost chips and a 2x/0.5x effectiveness arrow vs the current enemy.

### Data migration
moves.js: every move gets `type` (via mapping), proper `cost`, and where thematic `buildup`. Add ~10 tree-gated moves so every damage type has >=1 player move somewhere by tree depth 3. enemies.js: every enemy gets `type` + `resists` + thematic status immunities; the_hollow (type occult... choose ghost) must stay beatable by solo lvl-1 default Chloe. characters.js: rename pools to life/stamina/magic/faith with base+growth.
Save v:3 (+skillPoints, tree, resource snapshot); silent migration from v1/v2 (points = level-1, tree empty, pools mapped).

### Balance targets
Stamina must prevent spamming the strongest attack (2-3 uses then breathe); a focused branch build at lvl 25 should clear fights ~30% faster than unspent points; xp pacing: lvl 10 within Act 1 on defaults.

## 13. Room3D — first-person mode (supersedes the 2D scene flow as the ACTIVE game; 2D world stays in the code, unrouted)
The game is now: title -> account/PIN -> **3D room**. No story, no intro dialogs, no scene routing. One room, one enemy you walk up to; clicking it starts the normal round battle (section 10/12 engine untouched). All meta systems stay reachable via the menu overlay (loadouts, skill tree, sheet, inventory, save).

### Tech
`game/vendor/three.min.js` (r128 UMD, vendored, classic script — loads BEFORE all game scripts). WebGL canvas fills the screen behind the HUD. Target 60fps; single small scene. file:// safe (textures via THREE.TextureLoader relative paths — works over file:// in Chrome only via http; MUST also handle file:// texture load failure gracefully by falling back to flat colored materials so the game never breaks).

### Files & ownership
- ASSETS agent: `game/assets/gen/tex/*.jpg` (textures below), `game/assets/gen/enemy-hollow-sprite.jpg`, manifest `tools/room3d-assets.json`.
- ENGINE agent: `game/js/engine/world3d.js` (all Three.js logic) + `game/js/data/room3d.js` (room layout config: dims, furniture list {kind,x,z,w,d,h,rotY,tex}, enemy spawn, player spawn, light rig).
- UI agent: `game/js/ui/room3d.js` (screen, HUD, pointer-lock UX, battle handoff), edits to `game/js/main.js` (route after login -> 'room3d'; skip intro/story), `game/index.html` (vendor tag first, then data/room3d.js after data/tree.js, engine/world3d.js after engine/battle.js, ui/room3d.js before ui/menu.js), `game/css/game.css` (append HUD styles).

### Room (data-driven, ~8m x 6m x 3m)
The dressing room in 3D: dark red carpet floor, padded deep-red club walls, black tile ceiling. Furniture as textured box/plane compositions placed via data: vanity table + DEAD MIRROR plane (slightly emissive, cracked texture) on one wall, torn red couch, old TV on a stand showing static (animated by cycling texture offset or noise), the red DOOR on the far wall (static prop), a floor lamp with a warm point light, 1-2 grungy posters. Light rig: dim ambient (#1a0a0d), red point light center ceiling (flickering subtly), warm lamp light, faint emissive mirror/TV. Atmosphere: fog (black, near), subtle vignette via CSS overlay.

### Textures (Pollinations, house style; 512-768 square; "seamless texture" prompts for tiling surfaces)
carpet.jpg, wall.jpg, ceiling.jpg, couch.jpg (upholstery), door.jpg (full-frame front view), mirror.jpg (dead cracked black mirror, faint red), tv_static.jpg, poster.jpg. Enemy sprite: full-body gaunt hollow ghost, arms slack, facing camera, PURE BLACK background, red rim light -> billboard.

### Movement & controls (the core deliverable — must feel good)
Pointer lock on canvas click (overlay until locked: "Click to look - WASD move - ESC release"). Mouse look: yaw free, pitch clamp +-80deg, sensitivity 0.0022. WASD relative to yaw; walk 3.0 m/s, Shift sprint 5.0; acceleration/damping (approach ~10/s lerp) so starts/stops feel smooth; eye height 1.6; subtle head bob while moving (amp 0.03, freq scales with speed). KEYBOARD-ONLY FALLBACK (mandatory, also enables automated testing): ArrowLeft/Right or Q/E rotate yaw 100deg/s, ArrowUp/Down move — fully playable without pointer lock. Collision: axis-separated AABB resolve vs walls + furniture boxes (slide along surfaces, radius 0.35); never able to leave the room or clip furniture.

### Enemy & battle handoff
the_hollow as a 1.9m billboard (always faces camera) with a custom ShaderMaterial: discard fragments with luminance < 0.09, soft alpha ramp to 0.25 — black bg vanishes; add slow float bob, opacity flicker, faint red glow sprite behind. Crosshair dot center-screen. Raycast center (and on click, the mouse point if unlocked): when enemy hit within 3.5m -> highlight (emissive pulse) + hint "click to engage"; click -> world3d pauses (stop loop, release lock) -> CHLOE.engine.battle.start('the_hollow') + battle screen exactly as today. On victory: return to room3d, enemy dissolves (scale/alpha out), respawns after 15s at spawn. On defeat: normal defeat flow -> respawn player at player spawn, enemy reset. Rewards/XP/levels/loadouts all unchanged.

### API contract
CHLOE.engine.world3d = { init(canvasEl), start(), stop(), setEnemyAlive(bool), onEngage(cb), resize(), debug() -> {x, z, yaw, pitch, locked, enemyDist, enemyAlive, colliders} }. ui/room3d.js owns the screen div + HUD (crosshair, top bar with shards/level/menu button reusing existing HUD pieces, bottom hint line, lock overlay) and wires engage -> battleui, battle end -> back to room3d + world3d.start().
Save: scene field becomes 'room3d' (migration: any old scene value -> 'room3d' on load in this mode). Menu overlay must open (and pause the loop + release pointer lock) via button AND Tab/M key.

### Verification hooks
world3d.debug() is mandatory (used by automated tests to assert movement/collision/turning). Keyboard fallback must be enough to reach and engage the enemy without pointer lock.

## 14. Room3D v2 — photorealism, real models, jump, hands, interactive TV (extends section 13)

### Photoreal pipeline (engine)
renderer: outputEncoding sRGB, ACESFilmicToneMapping (exposure ~1.1), physicallyCorrectLights, shadowMap PCFSoft (1024), pixelRatio cap 2, anisotropy 4. **Environment map**: HDRI (.hdr) via vendored RGBELoader + PMREMGenerator -> scene.environment (NOT background — room is enclosed); envMapIntensity ~0.6 on all PBR materials; graceful fallback if HDR fails (debug().envMap=false, never crash). One shadow-casting light (lamp spot or ceiling point), floor+furniture receive. Vendor tags: vendor/GLTFLoader.js + vendor/RGBELoader.js load right after three.min.js (already vendored).

### Real 3D models (MODELS agent) — Poly Haven, CC0, direct download (Sketchfab requires OAuth-gated downloads; not available)
Query https://api.polyhaven.com/assets?t=models (and /files/{id}) and pick appropriate furniture: a sofa/couch, an old TV (tube/vintage preferred), a floor or table lamp, a console/dresser usable as vanity, optionally a chair + 1-2 clutter props. Also ONE moody dim indoor/night HDRI (t=hdris, 1k or 2k .hdr). Download glTF format (1k textures) preserving relative paths into game/assets/models/<id>/ and the hdr into game/assets/hdri/. TOTAL BUDGET <= 40MB, prefer small. Manifest tools/model-manifest.json with canonical ids EXACTLY: sofa, tv, lamp, vanity, chair(optional), clutter1/clutter2(optional), hdri — each {id, polyhavenId, license, url, entryFile (the .gltf), sizeKB, realDims if stated}. Write tools/ATTRIBUTIONS.md (source, author, license per asset). Verify every entryFile + its referenced .bin/textures exist on disk.

### Placement, colliders, fallback (engine + data)
data/room3d.js furniture entries gain {model:'<canonical id>'|null, targetH (meters), rotY}. Engine loads via GLTFLoader (path from manifest — engine reads a mirrored copy of entryFile paths in data/room3d.js models block, NOT the json at runtime), scales uniformly to targetH, drops to floor (Box3 min.y -> 0), computes AABB collider from the scaled Box3 (replaces the placeholder box collider). The existing textured-box furniture stays as AUTOMATIC per-item fallback whenever a model fails to load (404/file://) — the room must never have holes. Mirror, door, posters stay as planes.

### Jump (engine)
Space while grounded: vy=4.8, gravity -14 m/s^2, land at eye 1.6 (y offset over eye height), grounded flag, no double-jump, head bob only while grounded, small camera+hands landing dip (0.05m, ~150ms). debug() adds {y, grounded}.

### First-person hands (engine)
Camera-attached hand group, always rendered (near plane 0.05, renderOrder high): two stylized gloved hands from primitives (rounded palm + finger segments + thumb, dark worn leather PBR, subtle red rim) at (+-0.28, -0.25, -0.55) angled inward. Animation: idle breath bob; walking sway (x +-0.02, y 0.015) synced to head-bob frequency, 1.5x on sprint; slight rotational lag behind look (slerp ~12/s); jump raises hands slightly, landing dips. If the MODELS agent happens to include a fitting CC0 arms glb, engine MAY use it; primitives are the required baseline. debug().handsVisible.

### Interactive TV (engine + ui)
TV screen = separate plane fitted over the model's tube face (data-configured local offset/size after scaling; fallback box TV keeps its screen plane). States: ON = animated tv_static texture + bluish emissive + flickering PointLight (~0.6); OFF (default) = near-black glossy env-reflective. Raycast hover within 2.5m -> hint "TV — click to turn on/off"; click toggles (also unlocked-mouse click). debug().tvOn. Engage-enemy interaction unchanged and takes priority when both hovered.

### Debug contract (extended, mandatory)
debug() -> {x, y, z, yaw, pitch, locked, grounded, enemyDist, enemyAlive, tvOn, envMap, handsVisible, modelsLoaded:{sofa,tv,lamp,vanity,...}, colliders}.

### Ownership
MODELS agent: game/assets/models/*, game/assets/hdri/*, tools/model-manifest.json, tools/ATTRIBUTIONS.md. ENGINE agent: engine/world3d.js + data/room3d.js. UI agent: ui/room3d.js (hint lines add Space=jump + TV hint), game/index.html (vendor loader tags), css touches. Menu unchanged.

> **Superseded in part by §15/§16**: the save flow is gone (no accounts, no persistence) and the battle handoff now enters the 3D church arena. The hands rig defined here is the baseline that §16 extends — the same gloved hands also open/close on the mouse buttons and reach out to take items.

## 15. Roguelike mode — no accounts, no saves (supersedes accounts/saves in sec 6, the account screen in sec 7, save v2 in sec 10, save v3/migration in sec 12, sec 13's account/PIN flow and its save/scene-migration line, sec 14's "save flow unchanged", and cloud sync everywhere)

> **Narrowed by §27**: a records board may persist in `localStorage`, and `worker/` reopens for an optional records endpoint. Persistence that RESUMES a run is still dead — no accounts, no saves, no cloud progress. What §27 keeps is a record ABOUT finished runs, which restores nothing.

CHLOE is a roguelike: **one run per page load, permadeath on defeat.** Nothing is ever persisted — no localStorage, no PIN, no cloud.

- **Flow**: title -> Press Start -> fresh run in the 3D room (sec 13). The account screen is GONE: `game/js/ui/account.js` and `game/js/engine/save.js` are deleted, `#screen-account` removed from `game/index.html`, account/PIN CSS removed. `worker/` is dead infrastructure (never deployed; kept in the repo for reference only).
- **A run** = `party.newGame()`: solo level-1 Chloe, default loadouts, empty tree, 0 skill points, 0 shards, starter items, fresh flags. All progression (XP, levels, tree, loadouts, shards, inventory, Ash joining) lives in memory only and dies with the run. Closing or reloading the page kills the run — intended.
- **Ash joins in-run**: the first room-battle victory sets the `roomCleared` flag from `room3d.onBattleEnd` (the 3D equivalent of §11's mirror fight), which fires `party.ensureAsh` — Ash joins with a toast and battle Switch unlocks. Flags reset with the run, so she is re-earned every night.
- **Death** (all members down): the defeat panel becomes a **run summary** — highest member level, shards ◆ held, fights won — with one button, **Begin again**, which starts a fresh run and re-enters the room (world3d: `setEnemyAlive(true)` + new export `resetPlayer()` puts the player back at spawn). The legacy 2D defeat path (scene.js, unrouted) also restarts the run. The old shard-loss respawn is gone (`defeatShardLossPct` removed from config).
- **Run stats**: `party.state.runStats = { kills }` — reset by `newGame()`, incremented in `battle.victory()`, read by the defeat panel. Extend here for future summary lines (rooms cleared, damage dealt...).
- **Removed API surface** (do not reintroduce): `CHLOE.engine.save.*` (whole module), `party.applyBlob`, `party.respawn`, `party.loseShardsPct`, `tree.sanitizeState`, `CHLOE.game.continueFrom`, all `autosave()` call sites. `config.js` lost `apiUrl` + `defeatShardLossPct`; `version` bumped to 2; `levelCap` now states the real v3 cap (100).
- **Menu**: Save tab removed (Party / Inventory / Moves / Skill Tree / How to play). How-to-play explains the roguelike rule in plain words.
- **Balance intent**: shards/tree/respec now price against a single run's economy; future content (P6 shop) must assume run-scoped wallets, not banked savings.

## 16. Arena battles — the church, the Hollow Black Knight, hands & crouch (supersedes the routed battle presentation of sec 10; the 2D battle screen stays for the unrouted legacy flow)

Battles now happen IN 3D: engaging the room's enemy pulls the run into an **old church** (real Sketchfab asset) where the **Hollow Black Knight** (real asset, static model driven procedurally like a haunted statue) waits before the altar. Turn-based attack selection + REAL-TIME dodging.

### Assets (game/assets/3d/, built by tools — never hand-edit)
- `church.glb` (~13MB, Draco-compressed, textures embedded ≤1024 JPEG) from `old-church-modeling-interior-scene.zip` (source .blend; textures must sit NEXT to the .blend when converting). Blender-measured placement: nave floor z=-34.04, walkable strip ±5, altar toward +X, center aisle |y|<1.2, pews from x≤-9 — mapped into world space by `data/arena3d.js` `church:{rotY:π/2, x:0, y:34.04, z:-7.5}` so the crossing sits on the origin.
- `knight.glb` (~6.6MB) from `dark-knight.zip` (`Knight_All.fbx`, NO animations/armature — procedural animation is intended). Diffuse-only 1024 textures; bbox-normalized to `knight.targetHeight` at load; materials darkened (color ×0.38 + faint red emissive) for the hollow look.
- Vendored loaders (classic scripts, load order: three.min.js → GLTFLoader.js → DRACOLoader.js): draco decoders in `vendor/draco/`. Loading MUST degrade gracefully (file://, missing files): fallback nave (floor disc + columns) and fallback knight (black totem) keep every fight playable.
- The two source .zip files stay in the repo root but are gitignored (165MB + 120MB).

### The round (engine/arena.js owns rules; arena3d.js answers ONLY "did the strike land?"; battle3d.js renders)
1. **Choose**: every living member picks ONE attack (learnset+tree attack-cat moves + free Struggle; costs sta/mp/faith per §12, ▲/▼ effectiveness shown) — or an item (their pick), or Give Up (70% flee, sealed vs bosses; failure = free enemy swing).
2. **Resolve**: choices fire in pick order (body first), v1 damage formula × 11-type chart vs the enemy def. Knight flinches/flashes per hit.
3. **Enemy turn**: arena.pickPattern() (weighted, no long repeats) → HUD prompt (`name — hint`) → arena3d.telegraph(): windup (~1.5-1.9s, knight glows red, aim LOCKED at windup start) → strike → hit test vs player position+crouch:
   - `slash` (reach 3.4m arc): evade by **Ctrl-crouch** or leaving reach.
   - `overhead` (1.7×4.4m lane): **sidestep** the locked lane.
   - `charge` (1.9×7.5m lunge lane): sidestep; knight physically lunges.
   Hit → pattern.power% × knight atk vs the **body** (= active member; type chart + tree resists apply). Full dodge → zero. Body KO → next living member becomes the body; all down → §14 defeat (run summary → fresh run).
4. **Round tick**: stamina +20% max, faith +1 (per §12); back to Choose.
- §12 statuses/buildup do NOT run in arena battles (v1 — revisit with P6).
- Victory awards exactly like battle.js (prog.enemyXp, grantXp/levelUps/learned, shards, drops, runStats.kills) and returns to the room; the §14 Ash hook (roomCleared) still fires in room3d.onBattleEnd.

### First-person hands & interaction (engine/world3d.js — the dressing room)
- **Ctrl (or C) = crouch** everywhere in first person: eye 1.6→0.85 lerp, speed ×0.55, half bob. (Browser reserves some Ctrl combos — C is the fallback.)
- **Left click closes the LEFT hand, right click the RIGHT** (simple blocky first-person hands, camera-attached; fingers curl on mousedown, reopen on mouseup). Context menu suppressed on the canvas.
- **Pickups**: `data/room3d.js` `pickups:[{itemId,label,x,y,z}]` render as small glinting items. Crosshair on one within 2.2m → HUD hint "take the X"; click → that hand reaches out, the item flies into it mid-motion → inventory.add + toast. One grab at a time; taken items respawn only with a new run (world3d.resetPlayer). Enemy engage wins the left-click when both are under the crosshair.
- room3d enemy config: `enemy:{id:'hollow_black_knight'}` — the ghost billboard in the room is the lure; the knight is what answers.

### Contracts
- `CHLOE.engine.arena`: start/get/isOver/attackOptions/playerAttack/useItem/pickPattern/enemyStrike/startRound/flee (pure rules, no DOM).
- `CHLOE.engine.arena3d`: init/start/stop/resize/reset/telegraph(pattern,cb)/flinch/setKnightAlive/debug + test hooks `_teleport(x,z)`, `_setCrouch(b)` (strike timing is setTimeout-based so automated tests work without rAF).
- `CHLOE.ui.battle3d.begin(enemyId)`; every end funnels through `CHLOE.ui.scene.onBattleEnd(result)` exactly like battleui, so room3d's wrapper owns the roguelike outcomes.
- world3d additions: `onPickup(cb)`, `resetPlayer()` also respawns pickups; debug() gains crouch/eye/pickupHover/pickupsLeft/hands.

> **Superseded by §17**: the turn-based round loop described below is replaced by real-time Combat v3. The church, the knight, the telegraphed patterns and the dodge rules all stay exactly as specified here — only the player's side became real-time.

### Balance targets
A first-run solo Chloe beats the knight in 4-5 rounds IF she dodges most swings; face-tanking every pattern loses. slash is the common swing (weight 3), charge the rare heavy (weight 1, 170% power). The chart makes occult take 2x physical, so the knight carries `resists:{physical:1.0}` — the plate blunts that back to NEUTRAL (a chart override, not a reduction). Fire stays chart-halved; divine (Voice tree) burns it 2x later. Tree resist nodes are PERCENT cuts applied after the chart (arena.js mirrors battle.js), never chart multipliers.


## 17. Combat v3 — real-time abilities, hotbar, evade (supersedes the turn-based round loop of §16; the arena, knight patterns and dodge rules of §16 remain)

The fight is no longer turn-based. You stand in the church and play it live: move, sprint, crouch, evade, and fire abilities off the number keys while the knight telegraphs and swings.

### Controls
`WASD` move · mouse look (click to lock) · `Shift` sprint (drains stamina) · `Ctrl` or `C` crouch (also ducks the Wide Slash) · `SPACE` **evade** (stamina cost, short i-frames, dashes along your movement input or straight back if idle) · `1`-`9` fire the ability bound to that key. Arrows/`Q`/`E` remain the keyboard-only fallback.

### Resources (per fight, from §12 effective stats)
**life** (hp), **magic** (mana), **stamina**. Abilities declare `cost:{sta?, mana?}`, paid when the cast STARTS. Sprinting drains stamina continuously and stops when dry. Evading costs stamina. Stamina and magic regenerate after a short idle delay (`abilityConfig.regen`), so trading blows is a resource decision, not a spam contest.

### Abilities (`game/js/data/abilities.js`)
`{ id, name, icon, type, desc, cost, castMs, recoverMs, cooldownMs, charges, rechargeMs, range, arc, power, usesMag, hits, hitAtMs[], anim, animSpeed, grantedBy }`
- A cast locks other casts until `hitAtMs[last] + recoverMs`.
- Each entry in `hitAtMs` is a separate hit window; at each one the 3D layer tests reach+arc (`arena3d.abilityHits`) and only then does damage resolve. Walking out mid-flurry drops the remaining hits.
- Damage: `max(1, round(base * power/100 * chartMult * rand(0.9-1.1) - def*0.5))`, `base` = atk or mag. The §12 type chart and tree resist percentages apply exactly as in §16.
- `charges` > 1 gives burst uses that refill on `rechargeMs`.

**Authored abilities.** `punch` (Rapid Punches) is the floor and the one that got the animation work: 3 hits, 8 stamina, ~0.7s, weak per hit, always known. `hammer_fist`, `ember_jab` and `hollow_breaker` are tree-granted and reuse the punch rig at different timing/cost/type.

### Hotbar, keybinds and the tree
Level 1 = **one** key and **one** ability (punch, auto-bound to key 1). Both the abilities and the keys come from the skill tree: nodes carry `grant.ability` (adds to the known pool) and `grant.abilitySlot` (+1 usable number key, capped at 9). Binding happens in **Menu → Moves** (`ui/binds.js`): pick a key, pick a known ability; locked keys show why. Binds live in `party.state.binds[charId]` and are run-scoped like everything else (§15). An ability occupies one key at a time.

### First-person arms (the punch animation)
`game/assets/3d/punch.glb` (~0.9MB) comes from the supplied `rapid-punching-animation.zip` — a Maya BodyMechanic rig with 92 armatures and ~2070 control empties, of which only `DeformationSystem` (147 bones, action already baked, no constraints) skins the mesh. The converter keeps that armature + mesh, deletes the control rig, purges ~70 orphan actions and exports a single clip named `Punch`.

In-engine the rig is parented to the camera and **fitted from the SKELETON, not `Box3`** — `setFromObject` on a SkinnedMesh returns un-posed bind bounds, which yields a wrong up-axis and scale. Head and ankle bones give the true height and up-axis; the model is stood up, scaled so head-above-feet ≈ 0.9 × body height, and positioned so the **head bone sits exactly at the camera**. The 180° facing spin goes on the WRAPPER group — composing it into the same Euler as the stand-up rotation flips the rig upside down. `Head_M` is scaled to ~0 so the head never blocks the view. Arms are visible only while a cast plays.

### Contracts
- `CHLOE.engine.combat3`: start/tick/press/evade/spendSprint/hitEnemy/takeHit/snapshot/flee + knownAbilities/slotCount/binds/bind. Pure rules, no DOM, no THREE.
- `CHLOE.engine.arena3d` gains: `playAbility(id, clip, speed, durationMs)`, `stopAbility()`, `abilityHits(ability)`, `doEvade(distance, durationMs)` and the test hooks `_renderOnce/_look/_animSeek/_fpBones/_fpPlace/_diag`.
- `CHLOE.ui.battle3d` drives the frame loop, HUD and key input; every end still funnels through `CHLOE.ui.scene.onBattleEnd(result)` so §15's roguelike outcomes are unchanged.

### Asset versioning (why the church looked broken for so long)
`data/arena3d.js` carries `assetVersion`; every model/HDRI URL is loaded through `versioned()` which appends `?v=N`. **Bump it whenever a `.glb` is rebuilt** — browsers happily served a cached, all-black church long after the fix shipped, which reads as "no textures".

### Balance targets
Punch alone should beat the knight but slowly and only with clean dodging — it is deliberately the worst option per stamina. Every tree ability must beat it in damage-per-stamina or reach. Sprint + evade together must not outpace stamina regen, so repositioning has a cost.

## 18. The knight fights back — limb animation, hunting AI, Fire Tornado (extends §17)

> **Superseded by §28**: the limb pivots below are SIBLINGS under the model, not a chain — which is why the head never inherited the torso lean. §28 replaces them with a real hierarchy (data/knightrig.js). Note also that the `_low1`/`_low2` split described here is INVERTED for `Boot_Toe`, so these legs are partly mis-sorted (9/7 where the centroid method gives 8/8). That asymmetry is a BUG, not a stylistic choice — do not restore it.

### The knight has no skeleton — he has 103 named armour pieces
`knight.glb` ships with zero bones, so the rig is built at load time by sorting every mesh into limb groups by NAME and splitting left/right by which side of the body its bounding-box centre sits on:
`Crown|Hood|Head_Mask|NeckStrap` → head · `Shoulder|ArmStrap|Bracer|Glove|UnderShoulder|Sword` → arm · `Boot|Knee|Shin|Greave|Leg|Thigh` → leg · `Chest|Padded|Belt|Dress|Cover|Shirt|Pants` → torso.
Each group gets a pivot Group placed at the matching joint (shoulders 0.80h, hips 0.48h, waist 0.50h, neck 0.82h) and the pieces are moved into it with `Object3D.attach()` so their world transform survives. Rotating those pivots animates real arms, legs and sword without a single bone. The sword falls into the right-arm group, so it swings with the hand for free. Current split: armL 34 / armR 29 / legL 9 / legR 7 / torso 20 / head 4, **none orphaned** — `debug().knightRig` reports it.

### Poses
`poseKnight()` builds a target pose every frame and eases toward it (~14/s) so states cross-fade instead of snapping.
- **idle** — slow breathing counter-sway in the arms.
- **walk** — alternating leg stride, arms counter-swinging, torso bob and a slight forward lean.
- **dash** — same cycle at ~2x cadence and amplitude with a hard 0.34rad forward lean.
- **overhead** — right arm winds back to -2.5rad over the first 45% of the swing, then chops through +1.4rad; torso follows, left arm counterbalances.
- **sweep** — used for the crouch-evade pattern: wide horizontal arc with a torso twist.

### Hunting AI
He **always faces the player** (`faceKnightTo` every frame) except mid-swing, when facing stays locked to the attack lane so the telegraph never lies about where the strike lands. Movement, all in `data/arena3d.js` `knight`: walks at `walkSpeed` until `keepDistance`, **dashes** at `dashSpeed` for `dashTime` when the player is further than `dashRange` and `dashCooldown` has elapsed, and is clamped so he can neither stand inside the player (`arena.knightMinDist`) nor leave the arena circle. `debug()` exposes `knightState`, `knightDashCd` and `knightPos`.

### Hotbar HUD
Every bound key shows its number, icon (typed colour), name, **cost chip** (`8 STA`, `18 MAG + 12 STA`, green for stamina, blue for magic, red when unaffordable), a radial-style cooldown sweep, the **seconds remaining** over the icon, and a charge counter when the ability has more than one. Slots you cannot currently pay for dim.

### Fire Tornado (`fire_tornado`)
The signature spell: `cast: 'sign'` raises the ZBrush hand (decimated 787k → 7.9k faces, 25KB) in front of the camera and spins a procedurally drawn sigil off the fingertips while the cast winds up. At the first hit window the sign drops and `spawnTornado()` drops the funnel (`firetornado.glb`, three nested tubes) on the knight — tubes counter-rotate at different rates, additive blending, an orange point light, and the funnel tracks him as he moves. Four hit windows over ~1s.
**Power is deliberately high (210):** the §12 chart HALVES fire against the knight's occult type, so a normal number would make the signature move worse than a free punch. Cost is 18 magic + 12 stamina — tuned to be castable on a base 20-magic pool, because an unaffordable button is just a grey button.

### Live slot reads
`combat3` reads bound slots **live** from `party.state.binds` every frame. A snapshot taken at `start()` meant rebinding mid-fight silently did nothing.

## 19. One ladder, a party that outlives you, a room that talks back (supersedes the point-buy ability tree of §17)

### The skill tree is a 1-100 unlock ladder, not a point shop
`data/skilltree.js` holds ONE shared track every character walks — "THE first main skill tree is available to all characters". Reaching a level grants that level's row automatically: no points, no prerequisites, nothing to mis-spend. Each character walks it at their OWN level, so a level-1 ally has only fists while a level-12 leader has the whole early kit.
Row shape: `{ability, slot, stat, ally, name, desc}` — any subset.
**Authored 1-12:** 1 punch · 2 **Fire Tornado** · 3 Ash joins · 4 +1 keybind · 5 life/stamina · 6 Hammer Fist · 7 +1 keybind · 8 magic · 9 Ember Jab · 10 +1 keybind · 11 atk/def · 12 Hollow Breaker. 13-100 are generated on a stated cadence (every 3rd level widens the hotbar to 9 keys, the rest are stat growth) so the ladder is complete and honest about what is filler; new abilities slot into this table as they are built.
`engine/skilltree.js` derives everything as a pure function of level — no state to save or de-sync (§15). `combat3.knownAbilities/slotCount` and `tree.effectiveStats` all read it. The old point-buy nodes still resolve if present, so nothing breaks.

### The party outlives its leader
Allies arrive by LEVEL (`row.ally`), not by clearing the room — checked on every level-up. They join at **level 1 and level independently**, so an ally is genuinely weaker until they earn their own rows.
When the leader's life hits 0 **and someone else is still standing**, the run does not end: the next member becomes leader mid-fight. `combat3.takeHit` swaps `charId`, re-reads that member's max pools, clears the cast and cooldowns, grants ~0.9s of i-frames so the swap is not a free kill, and returns `leaderSwap`. The HUD rebuilds the hotbar from the new leader's own level and abilities. Only when nobody is left does §15 defeat fire.

### The room reads you back (`engine/displays.js`)
Three canvas surfaces painted onto existing props, repainted whenever the room screen is entered:
- **Mirror** — your leader: name, level, life/magic/stamina bars, ATK/DEF/SPD/MAG, unlocked abilities, and what the next level gives.
- **Poster** — the Hollow Black Knight: level, type, life, stats, and every attack pattern with its dodge hint, wind-up time and power.
- **TV** — "THE LONG NIGHT", a how-to **programme in chapters** (the room, your hands, the church, dodging, getting stronger, dying). The TV is no longer a toggle: off → on starts chapter 1, each further click turns the page, and after the last chapter it switches off, so one control cycles the whole guide. Painting the programme replaces the static texture, so the jitter animation stops while it is on.

### The nave is the arena
Arena bounds are now a **rectangle matching the church walls** (`arena.bounds`), not a small circle — you and the knight both roam the whole crossing. The circle is kept as a fallback for configs without bounds.
**Benches** — SUPERSEDED by §22 (removed entirely; the nave is open floor). Kept for history: the model's pews are baked into merged meshes and cannot be split, so the interactive ones are loose benches shoved out of the rows into the fight area. Walking into one **slows you to `slowFactor`** and **shunts it aside** at `pushSpeed` (clamped to stay inside the nave). An ability whose reach/arc catches one **breaks it into a wood pile** of scattered planks that stays on the floor.

### Lighting note
Anything new in the arena must clamp `envMapIntensity` (~0.1). The keys are bright enough that unclamped IBL renders dark oak, dark leather and skin as white plastic — this has now bitten the room hands, the first-person arms and the benches.

## 20. The squad grows, the wall remembers, and the stone is real (extends §19)

### Rounds and squad size
A run is a ladder of **rounds**. `party.state.runStats.round` starts at 1 and goes up by one every time you clear a floor. **Round N spawns N Hollow Black Knights.** `combat3.start(enemyId, count)` builds `st.enemies[]` (one `{index, life, max, alive}` per knight); `arena3d.spawnSquad(n)` puts that many on the floor. Rewards scale with the squad: `xp * squad`, `shards * squad`, `runStats.kills += squad`.

Each knight is fully independent — its own attack window (`k.atk`), animation state (`k.anim`), rig, **cloned materials** (so a flinch flashes only the one you hit) and dash cooldown (staggered `i * 1.2s`). There is no module-level attack state any more; a shared one made the whole squad telegraph in unison.

`ui/battle3d.js` drives them: swing cadence tightens with squad size (`base / sqrt(aliveCount)`, floored at 650ms), each swing is performed by a randomly chosen living knight via `arena3d.telegraph(pattern, cb, index)`, and a player ability damages **every knight its arc catches** — `arena3d.abilityTargets(ability)` returns the indices, each resolved through `combat3.hitEnemy(id, mult, index)`.

### The wall remembers
Clearing a round pushes a trophy onto `runStats.trophies`: `{round, knights, by, hpLeft, hpMax}`.

There is **ONE picture**, not a gallery. It hangs on the east wall above the couch and always shows **the round you are standing in now** — the big number, one hollow-helm mark per knight that round will field, and the run's record in small print underneath (`N rounds cleared · M felled`, and how the last round fell). A row of frames accumulating down the wall buried the number that actually matters, so `world3d.buildTrophies()` **repaints the existing canvas in place** rather than adding a second frame; the mesh is built once per scene, so the frame never flickers out and back between rounds.

`engine/displays.js` `trophy()` takes no argument — it reads `runStats` directly, which keeps the picture and the round counter from drifting apart. `world3d.refreshPanels()` repaints it and the room router calls that on every entry, so the new number is up before you have finished walking in. Run-scoped like everything else (§15) — dying resets it to round 1.

### The arena is baked from the actual stone
`arena.bounds` was a hand-guessed rectangle, and it was wrong in both directions: it cut off ~2.6m of walkable side aisle on each side **and** let you stroll straight through the rood screen, the altar and the columns.

The arena now uses a **precomputed navgrid**, `data/arena-nav.js`: a 0.4m grid over the nave, one bit per cell, flood-filled from the player spawn so unreachable side chapels do not count. A cell is walkable only if there is floor within `FLOOR_TOL` (**0.28m** — deliberately tight, because the church is full of pews whose seats sit 0.45-0.85m up and a loose tolerance spawns you standing on the furniture) and a clear 1.7m head column. Player **and** knights resolve movement against it one axis at a time, which slides along stone instead of stopping dead; a knight that somehow starts off-mesh is snapped back on, or it could never move at all.

**This is a data file, not a load-time computation.** three r128 has no BVH, so probing the grid against the church's 37 meshes costs ~50 seconds of frozen main thread. `key` pins the grid to the church placement (`assetVersion|x|y|z|rotY`); on mismatch the engine refuses the stale grid and warns rather than silently opening walls. **Re-bake after moving or replacing the church**: enter the arena, then run `JSON.stringify(CHLOE.engine.arena3d._bakeExport())` and paste the result into `data/arena-nav.js`.

The bake also settled where the fight belongs. The nave centre is a solid rood screen, and both spawns were inside it — the arena is really a **ring** around that block. The fight now happens in the open south band (~16m wide, fully walkable end to end): player at `(-6.0, 5.4)` facing +X, knights across the band at `(4.0, 5.4)`, fanned **perpendicular to the approach** so the line stays abreast whichever way the spawns face.

### Level 2 gives you the spell and the key for it
Skill-tree row 2 grants `ability: 'fire_tornado'` **and** `slot: 1`, so from level 2 you can hold punch and Fire Tornado at the same time. Later keybind rows shifted accordingly (4 -> key 3, 7 -> key 4, 10 -> key 5).

### Lighting note (amended)
Clamping `envMapIntensity` at material-creation time is not enough. `applyEnvIntensity()` runs when the HDRI resolves and used to overwrite every material in the scene, flattening dark oak and leather back to white plastic. A material that wants damping must set **`userData.envClamp`**, which `applyEnvIntensity` now respects.

### Test hooks added
`arena3d._nav()` (grid summary + `free(x,z)`), `arena3d._probeAt(x,z)` (what is under and over a cell, with mesh and material names — French names in this model: `banc` pew, `autel` altar, `mur-haut` high wall, `sol` floor), `arena3d._bakeExport(cell, pad, tol)`, and `world3d._teleport(x, z)`.

## 21. Loading gate, one ladder in one place, the asteroid, and a knight who levels (extends §20)

### Nothing moves until the scene is there
The church is 26MB and the knight 6.6MB, and both used to stream in **after** the fight had started: you spawned into grey nothing while an invisible knight walked you down. Both 3D scenes now keep an asset ledger (`arena3d.assetsReady()` / `world3d.assetsReady()` + `assetProgress()`), and `ui/loading.js` holds a veil over the screen until they are ready. Every loader settles its slot on success, failure **and** skip — a missing optional asset must never wedge the gate.

`ui/loading.js` animates in **CSS only**, on purpose: it is on screen precisely when the main thread is busy parsing a 26MB GLB, so it must not ask for JS frames.

### Warming shaders is not enough — warm the textures
The first Fire Tornado cost **444ms** against a 2.9ms baseline. `renderer.compile()` did not fix it: compile builds shader *programs* but never uploads *textures*, and those go to the GPU lazily on the frame a material is first actually drawn. The tornado, hand sign and asteroid all sit hidden until cast, so every one of their texture uploads landed on a single frame mid-fight.

The warm-up now pushes every texture through `renderer.initTexture()` **and** draws one frame with all hidden objects forced visible, behind the loading veil where the flash is never seen. Measured after: **2.2ms**. Any new hidden VFX gets this for free; anything that bypasses the gate will hitch.

### Winning switches you out of movement mode
Pointer lock hides the mouse and eats clicks, so the victory card's Continue button was unreachable unless you knew to press Escape. Releasing the *lock* alone is not enough — the keydown listener stays live, so WASD keeps walking the camera behind the card and the PREVENT map keeps eating the Space that would press its button. `arena3d.releaseLock()` hands back the **whole input surface** (`controlOff`) while deliberately leaving the render loop running: `stop()` would tear the arena down and leave the card on a dead canvas, since the renderer has no `preserveDrawingBuffer`. `A.start()` re-arms it.

`requestPointerLock()` returns a promise that Chrome **rejects** inside the exit/enter cooldown. Unhandled, that is a console error, and releasing mid-fight made it reachable — so it is swallowed.

### One ladder, in one place
**The Skill Tree is deleted** (`ui/tree.js` and its script tag are gone). Progression has been a ladder since §19 — reach the level, gain the row, nothing to spend — so a whole screen for it was a list you had to go and find. It now lives in **Menu → Moves**, next to the keys it unlocks: current level, XP bar, and the rows either side of you. `engine/tree.js` **stays**: `effectiveStats` is still the aggregator behind every stat in the game. Only the *screen* was dead.

**Levels 1-9 are the authored game**, and every ability arrives WITH the key to put it on — granting a move with nowhere to bind it reads as a bug, not a reward:

| Lv | Row | Lv | Row |
|---|---|---|---|
| 1 | punch + key 1 | 6 | hammer_fist + key 4 |
| 2 | fire_tornado + key 2 | 7 | stat |
| 3 | **asteroid** + key 3 | 8 | ember_jab + key 5 |
| 4 | Ash joins | 9 | hollow_breaker + key 6 |
| 5 | stat | 10+ | generated growth to 9 keys |

**New moves bind themselves.** `combat3.binds()` auto-places any newly known ability into the first free key. Each ability is auto-placed **once** and remembered in `state.autoBound`; without that memory, deliberately clearing a key would be impossible — the next call would helpfully put it back.

### Asteroid (level 3)
The first thing you can throw. Both hands up with the sigil, then a burning rock falls out of the vault onto where you **aimed** — scored on your look direction, not proximity, so you pick which cluster eats it — tumbling with a trail of ember motes, and detonates in a crater ring.

It is the first **splash** ability: `splash: true, splashRadius: 3.4` damages every knight in the crater regardless of facing, which is what makes it the answer to a round fielding six. Damage is **deferred until the rock lands** (`spawnAsteroid(onLand)`), so the number and the impact are the same moment.

### The knight animation was wrong in three ways
1. **The rig was measured in the wrong space.** `buildKnightRig` took a WORLD `Box3` but wrote the result into `g.position`, which is MODEL-LOCAL — and `model` is already parented to `k.group` at `knight.x = 5`. Measured: the leader's shoulder pivot sat **5.9m from his own hand**, so an overhead threw the sword across the nave, while a clone's (whose group is still at the origin during rig build) sat 2.0m away and barely moved. One line, two opposite failures — which is why a squad looked like one windmilling leader and N-1 statues. Now measured in model space; **every knight in a squad reports identical pivots**.
2. **The picture and the damage ran on two clocks 25% apart.** `swingDur = telegraphMs * 1.25`, so at the damage instant the visual swing was at p = 0.800 for *every* pattern — the blade still 375-475ms from its lowest point, roughly **twice the entire 220ms i-frame window**. A player who dodged when the blade *looked* like it landed was guaranteed to be hit. `swingDur` is now `telegraphMs` exactly and the phase is measured off `atk.t0`, the same `performance.now()` stamp the strike timer counts from, so **impact is p = 1.0 by construction**. Damage stays on `setTimeout` (§16's contract — headless tests have no rAF); the picture moved onto its clock, taking `max(wall, swingT + dt)` so rAF snaps to the wall and `_tick` scrubs.
3. **There was no animation, only smoothing.** Exponential smoothing over a linear ramp was the whole system: constant angular velocity, no anticipation, no ease, no impact frame, and `Math.min(1, 14*dt)` — the Euler approximation — over-closed by 25% at 30fps, so the knight got *snappier* the worse your machine ran.

Now: `alpha(rate, dt) = 1 - exp(-rate*dt)` (frame-rate correct), per-joint rates (head leads, torso is heaviest), **elbows** built from the model's own elbow markers so the blade folds on the wind-up instead of sweeping a rigid bar through his chest, and a `swingEnvelope` with anticipation → decelerating wind-up → a readable apex **hold** → the whole arc spent in the last 12%. `recoverMs` finally drives something: he settles into `GUARD` instead of stepping 1.4rad back to breathing. Body yaw eases instead of teleporting. Each knight gets a `phase` offset, or a squad breathes as one organism.

The charge is now its own **thrust** pose (it and overhead share `evade:'sidestep'`, so evade alone could not tell them apart) and it starts lunging inside the last quarter of the wind-up — it used to start moving only *after* the hit test had already run.

Also fixed here: the midline is taken from the **body only** (the drawn sword dragged it 0.135m and flipped a shin plate, which is why the documented split was a lopsided 9/7 — it is now 8/8); harness pieces straddling the midline go to `torso` instead of riding the left arm; and `knightProto` is captured **before** rigging, so clones no longer carry a set of orphan pivots.

### The knight levels too
`data/knighttree.js` + `engine/knighttree.js`, mirroring the player's ladder as a pure function of level. **His level is the round you are on** — a squad that only ever grew in NUMBER stops being a threat and becomes a chore. Stats are **multipliers** on the base def (the last row that sets one wins, so the table reads as "what he is at level N"), and his **attack patterns unlock by level**: round 1 he only knows the slash, round 2 adds the overhead, round 4 the charge. `combat3` reads `st.enemyStats` for both his defence and his damage, the battle HUD names his level, and the room's poster shows what he is **now** rather than what the data file says he starts as.

### Test hooks added
`arena3d._rigProbe(index)` (pivots, live rotations, lever arms, `swingP`, `swingDur`), `arena3d._nav()`, `._probeAt(x,z)`, `._bakeExport()`, `world3d._teleport(x,z)`, `world3d.releaseLock()/isLocked()`.

### A note on `disableAPI`
`arena3d`'s no-WebGL fallback had drifted badly — `stopAbility` alone was already being called unguarded, so a machine without WebGL threw its way through the fight instead of degrading. It now covers the whole public surface. **Keep it in step whenever the API grows.**

## 22. The knight moves like a fighter, and the nave is open floor (supersedes the knight movement of §18, the bench props of §19, and the arena bounds of §20)

### The benches are gone
`benches`/`bench` leave `data/arena3d.js`; `buildBenches`, `breakBench`, `benchPush`, `benchHit`, `benchDebug`, the `benchSlow` multiplier and every call site leave `engine/arena3d.js`. No soft obstacles, no wood piles, no push-slow. The model's baked pews stay as scenery exactly as they are. `A.benchDebug` is removed from the public surface (delete it, do not stub it). Ability hit tests keep only the knight test. README/§19 references to benches are corrected.

### The nave is open and walkable
The fight area is the largest contiguous walkable region the baked navgrid (`data/arena-nav.js`) actually reports — not a hand-authored rectangle inside it. At load the engine measures the free region around the player spawn by flood fill and exposes it as `debug().arenaArea = {cells, m2, minX, maxX, minZ, maxZ}`. `arena.bounds` in data is widened to that measured region (author it from the flood fill, do not guess) and is used only as a fallback clamp; the navgrid stays the real constraint so stone still stops you.
Walkability fixes required: `navFree`'s 5-point probe uses `RADIUS * 0.8` for BOTH bodies, which makes doorway-width gaps impassable and lets a knight get wedged; probe with the body's own radius and allow a cell that is free at the centre plus 3 of 4 rim points, so brushing a pillar no longer reads as a wall. A body that ends a frame illegal is walked out with `navNearest` (already exists) instead of being frozen. Target: **no reachable pocket of floor smaller than 2m across is left cut off**, and the player can walk the full transept and both aisles.

### Movement patterns — a state machine, not a beeline (`knight.brain` in data)
States: `stalk` · `press` · `strafe` · `reposition` · `recover` · `stagger`. One `brain` block in `data/arena3d.js` holds every tunable (speeds, ranges, durations, cooldowns, weights) — no magic numbers in the engine.
- **stalk** (out of range): closes, but on an ARC — the approach vector is the player direction rotated by `arcBias` (sign flips per knight, held for `arcHoldMs`) so he comes in off-line instead of down a rail.
- **press** (in range, ready): holds `keepDistance` and picks an attack; while waiting he sways weight side to side.
- **strafe**: circles the player at current range at `strafeSpeed`, direction held `strafeHoldMs`, reversing on nav blocks; entered on `strafeWeight` after a recover or when an attack is on cooldown.
- **reposition**: after a combo or when crowded by a squadmate, backs off to `repositionDist` (backpedal, facing you, guard up) then re-engages.
- **recover**: the post-swing window (`recoverMs`), open to punishment — he is slow and cannot turn fast.
- **stagger**: entered when damage in one hit exceeds `staggerDamage` or a `staggerBuildup` meter fills (meter decays `staggerDecay`/s); he reels for `staggerMs`, cannot attack, and takes `staggerTakeMult` damage. This is the punish window the fight has never had.
- **dash** stays but becomes a *committed lunge with a wind-up*: `dashTellMs` of a crouch-and-coil before he launches, so it can be read and dodged.
Per-knight **personality** picked at spawn from `brain.personalities` (e.g. `aggressive` shorter cooldowns/longer presses, `cautious` more strafe/reposition, `brute` slower but dashes further): a squad must not move as one organism. `debug()` exposes `knightState`, `knightBrain` (state, personality, timers) per knight.

### Attacks — five patterns
Keep `slash` / `overhead` / `charge` and ADD:
- **`thrust_combo`** — two fast stabs then a lunge; each stab is its own hit window; evade `sidestep`; medium reach, lower per-hit power.
- **`ground_slam`** — he raises the sword two-handed and smashes the floor: a **radial shockwave** expanding from his feet; evade `backoff` (be outside `radius` at the strike frame) — the first pattern that punishes standing on top of him. Add its HUD hint ("GET BACK!") and, if `ui/battle3d.js` maps evade→prompt, extend that map.
Patterns gain optional `feint: {chance, holdMs}` — the wind-up stops at the apex, holds, then continues, so telegraph-reading alone is not enough. A feinted swing must never damage during the hold.

### Animations — the pose library grows
`SWINGS` gains `thrust_combo` (two short jabs sharing one curve segment) and `ground_slam` (both arms overhead, hard drop, knee bend on impact). New non-swing poses in `poseKnight`, all built from the existing 103-piece limb rig (no new assets, no bones):
- **strafe** — crossover side gait, torso open to the player, blade tracking.
- **backpedal** — heel-first retreat, guard high.
- **turnInPlace** — plants and pivots when yaw error exceeds `turnThreshold`.
- **stagger** — head snapped back, arms flung wide, weight on the back foot, a short recoil that eases out.
- **taunt** — on `tauntChance` after a kill or a whiffed player attack: blade raised, head tilt, a beat of contempt.
- **death** — REPLACES the sink-through-floor: knees buckle, torso pitches forward, sword drops from the hand, body settles and only then fades. `deathMs` in data.
- **hitFlash** — every damaging hit shows a short flinch even when it does not stagger, so blows always read.
Existing cross-fade discipline holds: build a target pose each frame, ease at the `RATE_*` rates, and never let a state change snap the body.

### Verification hooks (mandatory)
`debug()` gains `arenaArea`, `knightBrain[]`, `staggerMeter[]`, `tvOn`-style booleans where relevant. A headless hook must let a test drive N seconds of knight AI and report the distribution of states entered, so "he no longer only walks straight at you" is a measurement, not an opinion.

## 23. Pockets: consumables on the hotbar, and the asteroid rebalanced (extends §17 binds, §21 asteroid, §22 stagger)

### Asteroid — cheaper, and it stuns
- **Cost `mana: 24` -> `mana: 14`** (stamina 10 unchanged). It arrived one level AFTER Fire Tornado (18 mana) while costing more, on a level-3 pool of ~26 magic — one cast emptied you. It is the first ranged option and should be castable twice.
- **Level 3 is already correct** (`data/skilltree.js` row 3 grants `asteroid` + key 3, right after `fire_tornado` at row 2). Do not renumber the ladder. VERIFY it is actually reachable: `skilltree` grants it, `combat3.knownAbilities` lists it at level 3, and it auto-binds to key 3. If any link is broken, fix that — do not move the row.
- **Impact stuns.** `asteroid` gains `stun: { ms: 1500 }`. Every knight inside `splashRadius` at the impact frame is stunned: he drops the swing he was winding, cannot attack or move for the duration, plays the §22 stagger pose, and takes `staggerTakeMult` damage while it lasts. This is what makes the rock worth a key against a squad.
  New public engine surface: `CHLOE.engine.arena3d.stun(index, seconds)` — sets the §22 `staggerT` and calls `clearAttack`, **refreshing rather than stacking** (`staggerT = max(current, seconds)`), a no-op on a dead or absent knight, and it must NOT zero the stagger meter's own buildup rules. The splash damage caller applies it to every knight it damaged. HUD floats a **"STUNNED"** label per affected knight, styled distinctly from "STAGGERED!".

### Pockets — bandages and mana potions on keys 1-9
**The problem this solves:** abilities and their keys arrive together by design (§19), so every key is always occupied — binding a consumable would mean giving up an ability. So the hotbar gains room rather than taking it.
- `slotCount(charId)` gains **`pocketSlots: 2` from level 1** (`data/config.js` or the skilltree module — one named constant, not a literal). Total hotbar cap stays **9 keys**. Slots are **generic**: any slot may hold an ability OR a consumable, the player's choice; the two extra keys simply mean nothing must be sacrificed to carry a bandage.
- **Bind encoding:** a consumable is stored in `party.state.binds[charId]` as the string `'item:<itemId>'`. Ability entries stay bare ids. Validation drops entries whose item does not exist or is not combat-usable; slot 0 still defaults to punch. (No save migration exists to worry about — §15, roguelike.)
- **Bindable pool = any item with a combat-usable effect**: authored generically off `effect.hp` / `effect.mp` (so `bandage` and `energy_drink` — the mana potion — qualify today, and a future potion needs no code). Mark the rule in `data/items.js`; do not hardcode two ids in the engine. `adrenaline_shot` (revive) is explicitly OUT of scope for this pass — note why in the spec comment (it needs a target picker).
- **Using one, in `combat3.press(slotIndex)`:** an item entry bypasses ability readiness and costs nothing in mana/stamina. It requires `inventory.count(id) > 0`, applies the effect to the **active member** (clamped to their max), consumes one, and imposes `itemUseMs` (~350ms) of lock plus a **shared** `itemCooldownMs` (~2500ms) across ALL consumable slots so you cannot chug three bandages in a second. Returns the same `{ok, reason}` shape as an ability. Crucially the use-lock is real: **you can be hit while using it** — that is the cost, and it is what stops a bandage from being a free reset mid-swing.
- **Hotbar HUD** (`ui/battle3d.js`): an item slot shows the item icon and its **remaining count** badge where an ability shows its cost chip; it dims at count 0 or during the shared cooldown, and the count updates live as you use one or pick one up. An empty slot stays bound (it re-arms when you find another).
- **Bind screen** (`ui/binds.js`): consumables appear as their own group beside the ability list, bind identically, and show the carried count.
- **Auto-bind:** abilities keep priority and are never evicted for an item. After abilities are placed, auto-bind `bandage` and then `energy_drink` into the remaining free (pocket) keys, because a run starts holding 2 bandages and 1 energy drink and an unbound feature is an undiscovered one.

### Verification hooks
`combat3` exposes the resolved slot list including item entries (id, kind, count, ready) for tests. A headless check must prove: asteroid castable twice on a level-3 pool; every knight in the splash is stunned and cannot attack for the duration; using a bandage restores life, decrements the bag, locks the shared cooldown, and does not refund on a failed press.

## 24. Two stages: The Ring, and the board that announces it (extends §16 arena, §19 displays, §22 open nave)

### Why a second stage
The church is 250 m² of pillared stone shaped by a real model and a baked navgrid. Round N fields N knights (§20), and six of them in the transept is a scrum. **The Ring** is its opposite: a big, clear, perfectly round floor with nothing on it — pure room to move, circle and fight. Blank is the point; do not decorate it into a second church.

### `data/stages.js` (NEW) — one entry per stage, the engine reads the active one
```js
CHLOE.data.stages = {
  church: { id:'church', name:'The Church', shape:'model', ... },
  ring:   { id:'ring',   name:'The Ring',   shape:'round', ... }
}
```
Every stage carries: `id, name, blurb` (one line for the board), `shape` (`'model'` = load a glb + use the baked navgrid; `'round'` = procedural, no navgrid, radius clamp), `playerSpawn {x,z,yaw}`, `knightSpawn {x,z}`, `arena {radius | bounds, knightMinDist}`, `lights`, `fog`, and for `'round'` a `build` description the engine renders procedurally. The **church entry restates today's values from `data/arena3d.js`** — that file stays the source for models/patterns/knight brain; stages only own *where the fight happens and what it looks like*. Contradictions between the two are a bug: the church stage entry must reproduce §22's measured bounds and spawns exactly.

### The Ring — procedural, no new assets
Radius **14m** of open floor (~615 m², 2.5x the church), centred on the origin. Built from primitives and EXISTING textures only — no Pollinations run, no new glb:
- A round floor disc, a low perimeter wall/kerb (~0.9m) so the edge reads as a boundary rather than a drop, and a wide dark void beyond it. A ring of standing light sources (braziers/pylons) around the rim at even intervals for readability and to give the eye something to judge distance and rotation against — the one thing a blank floor must not lose.
- Nothing inside the circle. No colliders except the perimeter. **`shape:'round'` sets `nav = null`**, so §22's existing radius/bounds fallback clamp does the containment — this is why the Ring needs no bake, and that fallback path must be exercised, not bypassed.
- Fog/backdrop dark enough that the rim lights carry the silhouette of a knight across 14m.

### Stage selection
`CHLOE.engine.stages` (or an equivalent named export — state it in the code): `order` (default `['church','ring']`), `forRound(n)` cycling that order so the stage is deterministic and learnable, `current()`, `next()`. The battle entry point resolves the stage for the round and applies it BEFORE the arena builds. Switching stages between rounds must fully reset the previous one (no church geometry left standing in the Ring, no doubled lights, no stale colliders or navgrid).

### The board — the second poster becomes the stage announcement
The room has TWO poster props (`data/room3d.js`: west wall `x -3.96`, south wall `x -1.4`) and both currently paint the SAME `displays.poster()` knight canvas, so one is redundant. The **south poster becomes the stage board**: give the props distinct kinds/ids in data (e.g. `poster` and `poster_stage`) rather than relying on array order, so moving one in data cannot silently swap the two.
New `displays.stage()` canvas, in the house style of the existing panels: the stage **name** big, its `blurb`, a simple **plan diagram** that reads at a glance (a circle for the Ring, a nave outline for the church), the round it applies to, its size, and how many knights are waiting. It repaints wherever the mirror/poster repaint (room entry and after a round), so walking in tells you where the next fight is. The knight-stats poster is unchanged on the west wall.

### Verification hooks
`debug()` gains `stage: {id, shape, radius|bounds, nav: bool}`. A test must prove: the Ring clamps the player at its rim from 8 compass directions and never lets them past it; a knight squad spawns inside, spreads, and every §22 state still occurs there; switching church→Ring→church leaves no orphan geometry, lights or colliders; and the board canvas names the stage the next fight actually uses.

## 25. A miss must cost nothing, and Water Wave (fixes §16/§17 damage; extends §19 ladder)

### THE BUG: a dodge still damages you
`ui/battle3d.js` calls `C3.takeHit(res.hit ? windowPattern(pattern, res) : null)` — on a geometric MISS it passes `null`. `engine/combat3.js takeHit()` guards only `isOver()` and `invulnerable()`; with no null-pattern guard it falls through, prices the hit at the fallback `(pattern && pattern.power) || 100`, and **deducts HP** (`Math.max(1, ...)` guarantees at least 1). The UI meanwhile branches on `!res.hit` and prints "DODGED!" / "The blade splits empty air", so the feedback and the health bar disagree and every clean dodge quietly costs life. Only the 220ms evade i-frames ever really prevented damage.

**Fix, both ends (defence in depth — either alone leaves the trap armed for the next caller):**
1. `takeHit(pattern)` returns a miss **before any damage maths** when `pattern` is falsy: `{dmg:0, missed:true, dead:false}`. No HP write, no leader-swap check, no side effects.
2. `ui/battle3d.js` does not call `takeHit` at all on a miss; it renders the dodge feedback from `res.hit` alone. The engine guard stays as the backstop.
3. The `|| 100` power fallback is a lie by omission — a pattern that reaches damage with no `power` should be *reported* (console.warn once) rather than silently priced at 100.
Damage may only ever be applied on a TRUE hit test. Add a regression test to the harness: `takeHit(null)` leaves `hp` byte-identical.

### Water Wave — level 4
A wall of water shoved out in front of you that **throws the knights in it to the SIDES**, opening a lane you can walk through. It is the answer to being cornered — a mobility tool first, damage second.
- `data/abilities.js` `water_wave`: type **`magical`** (the §12 chart has no water type — do NOT invent a 12th; `magical` is what `frost` migrated to). Modest cost (castable at level 4 on that pool — check the numbers, do not guess), short cooldown relative to the offensive spells because its job is escape. **Low power** — this must not become the best damage in the kit.
- Shape: a cone/box in front of the camera (state reach and half-angle in data). Every knight inside is **displaced laterally** — perpendicular to your facing, each thrown toward whichever side it is already nearest, so the wave *parts* rather than pushing everything straight back. The displacement is paid out over ~250-350ms, never teleported.
- Being thrown **breaks whatever he was doing**: `clearAttack` so a knight mid-wind-up drops the swing. It does NOT stun (that is §23's asteroid) — he recovers his footing and comes back.
- New engine surface `CHLOE.engine.arena3d.shove(index, dirX, dirZ, distance, ms)`: displaces one knight, **respecting containment** — the navgrid on `shape:'model'` stages and the radius/bounds clamp on `shape:'round'` (§24). A shove must never push a knight into stone or outside the arena; clamp and stop short rather than teleporting him out of the world. Returns whether it moved him.
- The lane must be real: immediately after the wave, the player can walk forward through where the knights were (`knightMinDist` no longer blocking that line).

### Ladder: level 4 keeps Ash AND grants the wave
Row 4 currently grants `ally:'ash'`. A row may carry several fields, so **add `ability:'water_wave'` + a key to row 4** rather than renumbering §21's authored 1-9 ladder. **Watch the slot arithmetic:** levels 1-9 hand out 6 ability keys today; this makes 7, plus §23's 2 pockets = 9, exactly `maxSlots`. The generated 10-100 "Wider Grip" rows count ability keys only (`slotsSoFar < 9`) and would push the total past the cap — that counter must account for pocket slots so the hotbar can never exceed 9. Verify the bind array at levels 4, 9, 12 and 100.

### Verification
Prove: a dodged swing leaves HP unchanged (all five patterns, both the geometric miss and the i-frame path); the wave throws knights sideways, breaks their wind-up, respects both stages' containment, and genuinely opens a walkable lane when cornered against a wall/rim; the hotbar never exceeds 9 keys.

## 26. The night opens in the Ring, and the board becomes a picker (supersedes §24's stage ORDER, extends §24 stages and §19 displays)

### The run starts in the Ring
§24 shipped the cycle as `['church','ring']`, so every run opened on the hardest floor to read: pillars, a baked navgrid, a knight who can break line of sight on his first approach. **The order is now `['ring','church']`.** A lit blank circle with nothing to hide behind is where the fight is legible — where you learn a wind-up, a dodge and a lane — and the church is the complication you walk into on round 2, not the thing that has to teach you. The cycle is otherwise unchanged and still deterministic: round 1 Ring, round 2 church, round 3 Ring.

### The board stopped being a notice
The south poster (§24) announced where the next fight happened and you took what you were given. It now **picks**: two arrows, `◀ THE RING ▶`, painted on the sheet either side of the stage name, clicked in-room like the TV. The floor between the arrows is the floor the next fight uses.
- **A pick sticks until it is changed.** You set the stage, it stays set; the round cycle only decides while nobody has. The board says which of the two is talking — `YOUR PICK · ◀ ▶ TO CHANGE THE FLOOR` against `◀ ▶ CLICK TO CHOOSE THE FLOOR` — because a player who chose the church on round 1 must not spend round 5 blaming the round counter.
- **One question, one answer.** The pick lives in `CHLOE.data.stagePick` (`chosen() / choose(id) / peek(dir, round) / cycle(dir, round) / clear()`) and `forRound(n)` returns it when set, falling back to the pure `cycleForRound(n)`. `forRound` is the single question the room's board (`world3d.nextStagePlan`) and the fight (`ui/battle3d.resolveStage`) already ask, so the override reaches both and **cannot** drift into a board promising a floor you do not land on. A pick naming a stage that no longer exists falls back to the cycle rather than freezing the run.
- **The picture and the hit box are the same numbers.** `displays.js` owns `STAGE_ARROWS` (normalised 0..1 rects) because `displays.js` paints the arrows, and exports `stageArrows()`; the room hit-tests the poster's own UV against that table. Nothing else may hard-code an arrow position.
- **Reach and feedback.** `BOARD_DIST` 2.5m, the TV's reach and for the TV's reason — a wall panel you can press from across the room is one you press by accident while turning around. The crosshair hint names the floor the arrow would hand you (`◀ THE CHURCH`), never a bare "click"; the enemy and the TV keep priority over the board, the board outranks a floor pickup, and pressing an arrow must not also close a hand on a grab. A click repaints the board in the same breath — the sheet is the only feedback the press has.

### Verification hooks
`world3d.debug()` gains `stageArrow: {which:'left'|'right', id, name} | null` — the arrow under the crosshair and the floor it would pick. A test must prove: round 1 resolves to the Ring with nobody touching the board; the painted-left arrow is the on-screen left arrow (UV mapping, not a guess); the middle of the board is not clickable; a click changes both the board canvas and what `stages.forRound(round)` answers; and the fight lands on the picked floor, not the cycled one.
## 27. Hotbar reach, the shop, auto-revive, and the record board (fulfils the shop deferred in §6; NARROWS §15s no-localStorage rule to run saves only — a record board is not a save; extends §17 binds, §19 leader swap and §23 pockets)
*(§26 is the other session's stage picker — do not renumber it. This section owns NOTHING in data/stages.js, engine/displays.js or ui/room3d.js.)*

### A. BUG: learned abilities stop being reflected
`party.state.autoBound` remembers which entries were "already offered a key once", so an ability is auto-placed only the FIRST time. Any path that rebuilds a character's binds while that memory survives leaves every previously-offered ability **permanently unbound**. Reproduced headlessly: with binds rebuilt at level 9, a character who knows 7 abilities is bound only `punch` + the newest one; at level 12, only `punch`. Natural level-by-level progression is unaffected, which is why it hid.
**Fix:** binds and `autoBound` must be cleared and rebuilt as ONE unit (the file's own comment already warns they must move together). `binds(charId)` must additionally self-heal: any KNOWN ability that is unbound while a free slot exists is placed, unless the player explicitly cleared it (that explicit choice still has to survive — keep a distinct "player cleared this" memory from "never offered"). Find the live path that triggers it (leader swap, an ally joining above level 1, level-up rebuild) and name it in the commit. Regression test: for every level 1-100, and for a bind-set rebuilt from empty at each of those levels, **every known ability is bound while free slots remain**.

### B. Mouse buttons are bindable
`LMB` and `RMB` join keys 1-9 as bind targets: **11 slots**, any of which may hold an ability OR an item. Encode them as slot ids `'mouseL'`/`'mouseR'` (not indices 9/10 — a numeric off-by-one here silently fires the wrong ability).
**They keep their room jobs.** In the ROOM the mouse still opens/closes the hands and grabs items (§16); mouse binds fire **only in the arena**. State that split in code. A bound mouse button must not also trigger a grab, and the arena's existing left-click-to-engage must not fire an ability by accident.
`ui/binds.js` shows the two mouse slots alongside the number keys; the hotbar labels them clearly (not "10"/"11").

### C. Revive potion — the one you never press
New item `revive_potion` (buyable, §D). Bound like any consumable, but it is **passive**: when the active character would fall, if a bound `revive_potion` is carried it is consumed automatically and they get back up at `revivePct` life instead. Ordering is load-bearing: this fires **before** §19's leader swap, so the potion saves the run rather than the corpse. One per fall; the HUD slot shows its count and must visibly read as armed rather than pressable, and a clear log/splash fires when it saves you ("ADRENALINE" style). If none is carried, the leader swap proceeds exactly as today.

### D. The shop — a giftbox in the room
A **giftbox/treasure prop** in the room (`data/room3d.js`, a new furniture kind; place it where it reads as an object you can walk to, not tucked behind the couch). Looking at it shows the interaction hint; clicking opens the **shop overlay** — a new screen (`ui/shop.js` + `engine/shop.js`, NOT ui/room3d.js, which the other session holds). Spend **Shards** earned from fights: list each stocked item with icon, name, effect, price and carried count; buy decrements Shards and adds to the bag; unaffordable rows are dimmed with the shortfall shown. Stock is data-driven off `data/items.js` prices — `bandage`, `energy_drink`, `revive_potion` at minimum, plus the §12 cure items which have been unobtainable since they were authored. Closing returns to the room and resumes the 3D loop the same way the menu overlay does. Shards persist for the run only (§15 — permadeath still means you lose them).

### E. The record board — top 10, in a frame on the wall
A **new picture-frame prop** in the room (`data/room3d.js`) painted with a records canvas. Its own module (`engine/records.js`) — **do NOT add it to engine/displays.js**, which the other session is holding.
Each record: **name · round reached · date · patch · run time**. `patch` comes from `CHLOE.data.version.string()` (§23), and run time is measured in-game from the start of the run to the moment the record is set. Top 10, sorted by round then by fastest time.
When a run ends having reached the **highest round ever recorded**, the player is prompted to type a name (1-12 chars, sanitised, rejected if empty) and the record is inserted. Nothing else may write to the board.
**Persistence, and an honest limit:** records live in `localStorage` under their own key. This does NOT contradict §15 — §15 removed *run/progress saves* so death means starting over; a record board is a separate artefact and must not restore any run state. Records are therefore **per-browser, not global**, and the board must label them as such until a backend exists.
For real "world" records the repo already has `worker/` (mothballed since the roguelike pivot): add `GET /records` and `POST /records` (name, round, timeMs, patch; server-side validation, cap the table, rate-limit) and have `engine/records.js` use the remote list when `config.apiUrl` is set and fall back to local otherwise, exactly like the old cloud-save contract. **It cannot be deployed from here** — that needs the owner's one-time `wrangler login`; document the steps in `worker/README.md` and leave `apiUrl` empty so the game ships local-only and never errors.

### Verification
Prove: every known ability is bound at every level and after a rebuild; LMB/RMB fire abilities in the arena and still grab in the room; a bound revive potion resurrects you before any leader swap and is consumed exactly once; the giftbox opens a shop that actually moves Shards and stock; a record run prompts for a name and appears in the frame with the right patch and time; and the board survives a reload while granting no run progress.

## 28. A real skeleton, and knights that level apart (supersedes §18's sibling limb pivots; extends §20 squads, §21 knight levels, §22 the pose library)

> **Superseded in part by §30**: `A`'s opening rule below — every knight spawns at level 1 — is replaced by SENIORITY: a knight opens at the number of rounds he has been coming, so round N fields N, N-1, … 1. The in-fight climb described here is KEPT, but it now grows from that opening level and is capped `overCap` past it rather than past the round baseline. Note also that `A`'s "[1,1,2,1,1,2]" figure is a true measurement of the §22 BRAIN's per-knight levels, never of `combat3`'s `st.enemies`, which opened every knight at 1 because `start()` called `spawnLevel('')` once outside the loop and personalities do not exist at that point. Do not re-derive a regression from the difference.

### A. Every knight spawns at level 1 and grows
Today `knighttree.level()` is a pure function of the round, so a round-6 squad is six identical level-6 knights and none of them changes during the fight. Instead: **every knight spawns at level 1 and levels up individually while the fight runs**, so at any moment the floor holds a SPREAD — weak knights and strong ones — rather than one stat block wearing six bodies.
- Level lives on the knight instance. `knighttree.level()` stays as the ROUND baseline so its existing callers (the poster, `combat3` enemy stats, the pattern pool) keep working; add per-knight accessors, and the per-knight value drives that knight's stats and its `knighttree.patterns(level)` pool. A level-1 knight therefore also has a SMALLER move pool than a grown one, which is most of what makes the spread readable.
- **The spread must be real, not cosmetic.** If all six spawn together at level 1 and grow at one rate they are identical again by construction. Vary the rate per knight, and the natural hook already exists: §22 deals each knight a personality (aggressive / cautious / brute). Tie growth to it — an aggressive knight earns levels fastest, a brute slowest but from a harder base. Document the rates.
- Growth is data-driven in `knight.brain` (or a new `knightLevels` block — author it, document it): a trigger (default: seconds alive in the fight), a per-personality rate, a cap so a long fight cannot spiral, and a small stat step per level. A knight that levels mid-fight should be NOTICEABLE — a brief tell, and the poster/HUD showing the real number rather than the round.
- **BALANCE — say this out loud, it is a real difficulty change.** Round 6 currently fields six level-6 knights; six level-1 knights is dramatically easier at t=0, and the danger now has to come from growth, numbers and speed instead. Measure the crossover: how long a round-6 fight runs before the squad is as dangerous as today's flat level 6, and tune the rates so a competent player is pressured rather than farming a floor of weaklings. Report the curve.

### A2. From round 5, the knights get faster
Speed is the round's contribution to difficulty now that levels start at 1. From round 5 onward every knight gains a movement/attack speed multiplier that scales with the round, data-driven and capped (`brain.roundSpeed`: `fromRound: 5`, a per-round step, a ceiling). It must touch what the player FEELS — walk/strafe/dash speed and swing wind-up — while leaving the §21 one-clock rule intact: if a telegraph shortens, the picture and the damage shorten together, because the pose driver reads the same data the strike timer does. A faster wind-up must never become an unreadable one; state the floor on `telegraphMs` below which it will not scale.

### B. The rigid-plate skeleton (replaces §18's pivots)
`knight.glb` has `skins:0, animations:0` and 103 flat sibling meshes, so §18 built limb pivots as **siblings under the model** — its own comment records the consequence: "the head never inherited the torso lean". Replace that with the real hierarchy now shipped in `data/knightrig.js`: `root → hips → torso → {head, armL→forearmL, armR→forearmR→sword}`, `hips → {legL, legR}`, driven by `engine/knightanim.js` and regenerated by `tools/build-knight-rig.js`.
Validated before adoption: the tool assigns **103/103 nodes, 0 unassigned**, and gives `legL 8 / legR 8` where the old name-suffix split gives an asymmetric 9/7 — the suffix is inverted for `Boot_Toe`, so §18's legs were partly mis-sorted. Pivots are authored in NATIVE model metres (crown 1.78 against a measured crown of 1.832), and the model is bbox-normalised to `targetHeight 2.15`, i.e. **1.173x**: scale `rig.root` uniformly and pivots and mesh offsets stay in step. Scaling the inner model instead breaks it — this is the §17 "Box3 lies" class of bug, so assert the knight's on-screen height after adoption.
What this buys, and what must actually be visible afterwards: the sword swinging off a real elbow (it is parented under `forearmR`), a **hips** bone so the dress/belt moves and the stride reads (§22 had to keep boot swing at 0.28rad because the hem was static), and torso lean propagating to head and arms instead of three bones being posed to agree by hand.

### B2. THE GRIP IS WRONG — pivots must be DERIVED, not hand-authored
Reported from play: *"the knight is holding the blade not the shaft of the sword; the movements seem wrong for thrusting and swinging."* Measured against the GLB, that is exactly right and it is a rig defect, not a pose defect:
- The `sword` bone pivot is authored as `[-0.28, 0.95, 0]`, which sits at **46% along the sword's extent** — its midpoint. Rotating a sword about its middle is, visually, holding it by the blade, and it is why every arc reads wrong: a swing scythes around the centre instead of sweeping from the hand, and a thrust slides the blade through itself instead of driving from the grip.
- The right hand's measured centre is `(-0.266, 0.916, -0.130)`; the authored pivot is **0.135m away from it** and displaced along a different axis. A grip pivot must be COINCIDENT with the hand — that is what a grip is.
**Requirement:** `tools/build-knight-rig.js` currently HARD-CODES every pivot in its `BONES` table from "the measured layout". Replace that with pivots DERIVED from the meshes each bone owns, and validate every one — the sword pivot is proof the hand-authored numbers are not trustworthy, so do not assume the others are. Specifically: the sword pivot is placed at the right-hand cluster's centre (the grip), and the hand/elbow/shoulder pivots are taken from their own mesh clusters rather than a remembered table. Regenerate `data/knightrig.js` from the tool; do not hand-patch the generated file.
**Then re-check the attack poses.** `knightanim.js`'s angles were authored against the broken pivot, so some of them are compensating for it. Once the sword rotates about the grip, re-tune `thrust_*` and the swing pairs so the blade leads from the hand: a thrust drives the point forward along the sword's own axis, and a swing sweeps an arc whose centre is the grip. State the sword tip's path for both before and after.
**Acceptance:** the hand visibly holds the grip at rest and through every pose; the sword tip traces a clean arc for swings and a straight line for thrusts; and the tip's reach at the strike frame still matches the pattern's authored `reach`/`length` in data/arena3d.js, because the hit volumes were tuned to the old (wrong) geometry and may now under- or over-reach what the player sees.

### C. §22's animation library is NOT to be lost
`knightanim.js` ships `idle`, five attack pose pairs, `flinch` and `dead`. The knight today ALSO has **strafe, backpedal, turnInPlace, taunt, stagger and the collapse death**, all built and verified in §22. Adopting the new rig must **port those six onto the new hierarchy**, not drop them — they will read better on it. Adoption is not complete until every §22 state still plays.
Timing rule is unchanged and load-bearing: poses are keyed at normalised phase 0..1 and stretched over the data's own `telegraphMs` / `feint.holdMs` / `hits[].atMs` / `recoverMs`. **One clock, and it is the data** (§21 records a fight lost to two clocks). The swing envelope's impact frame stays pinned to the strike timer.

### D. Load-bearing debug export (housekeeping)
`ui/room3d.js` exports `_resume` labelled "exposed for tests/debugging", and §27's shop close path now depends on it to resume the 3D world. It is load-bearing: tidying it away freezes the room after a purchase. Either promote it to a documented public name or leave this note standing.
Related, unreached today: `debug().shopReady` has **zero consumers**. If the shop is ever made optional, the gate belongs on the giftbox glow and both click paths — not on the hint caption, which would leave an unlabelled lit prop that still eats clicks and still hides the pickup behind it.

### Verification
Prove: 103/103 meshes reparent with the knight's on-screen height unchanged at 2.15m; all five attack patterns AND all six §22 locomotion/reaction states play on the new rig; the sword tracks the elbow and the hips move; impact frames still land on the strike timer; a squad's levels visibly diverge during a fight while a fresh round-6 squad is no harder at t=0 than today.

## 29. The 9mm, and three fists become one (supersedes §21's level 5-9 ladder rows for hammer_fist and ember_jab)

### The three melee abilities really were one move
`hammer_fist`, `ember_jab` and `hollow_breaker` all share `anim: 'Punch'`, range 2.9-3.1, arc 55-65, single target. They are one move with three price tags, and the ladder spent three of its nine authored levels on it. Resolution, per the player:
- **DELETE `hammer_fist`** — the level-5/6 slot goes to the gun.
- **DELETE `ember_jab`**.
- **RENAME `hollow_breaker` -> `killer_fist`**, display name **"Killer Fist"**. Rename the ID too, not just the label — there are no saves (§15) so nothing persisted references it, and a stale id is how the next reader concludes they are different moves. Update `data/skilltree.js` and `data/tree.js`, and keep its mechanics (divine, 2 hits, rising strike) — it is the survivor, not a new move.

### `gun_9mm` — level 5, on the mouse
A 9mm pistol. **Hitscan**: a straight line from the muzzle, hit or miss decided along that ray — not an arc, not a lane volume. `cost: { sta: 10 }` and **strong** damage.
- **It lives on the mouse.** §27 put `mouseL`/`mouseR` OUTSIDE the nine number keys, so a mouse-bound gun costs no keyboard slot — which is why the ladder can afford it. On unlock it auto-binds to a free mouse button (prefer `mouseR`, leaving `mouseL` for the hands), and the player may rebind it like anything else. It must obey §27's room/arena split: in the ROOM the mouse still opens/closes hands and grabs; the gun fires only in the arena.
- **A magazine is the real cost, not the stamina.** 10 stamina is cheap enough to spam, so the gate is `charges` (a magazine) with a `rechargeMs` reload and a short `cooldownMs` fire rate. Author the numbers; state why. A reload that lands mid-swing is the tension — the gun must never be strictly better than closing to melee.
- Range long enough to cross the Ring (radius 14) meaningfully without trivialising it; state the number and the falloff, if any.
- Feedback is load-bearing for a hitscan weapon, because there is no travel time to read: muzzle flash, a brief tracer along the ray, a hit marker, and a distinct dry-click plus reload tell when the magazine is empty.
- **§21's one clock still governs.** The shot resolves on the same timer the picture fires on.

### The asset
`C:\Users\Olaf\Downloads\9-mm.zip` -> FBX + PBR set (albedo/normal/roughness/AO/metallic/emissive, ~16MB of PNG). Convert exactly the way the church and knight were: headless Blender, relink textures, **downscale to 1k**, Draco, GLB into `game/assets/3d/`, and bump `assetVersion` in `data/arena3d.js` so caches refetch. Blender is NOT currently installed (it was, for §16) — reinstall it; do not hand-roll an FBX parser.
Mount it as a first-person prop on the camera like the §17 punch rig, sized and placed so the muzzle is where the ray starts — a tracer that does not leave the barrel is worse than no tracer.

### Ladder after the change (levels 1-9, §21's "every level hands you something you can feel")
`1 punch · 2 fire_tornado · 3 asteroid · 4 water_wave + Ash · 5 gun_9mm · 6 +1 keybind · 7 stat · 8 stat · 9 killer_fist`.
**Slot arithmetic — check it, this bit §25.** Today: base 1 + 6 ladder slots = 7 keys, + 2 pockets = 9 = cap. After: the gun takes NO number key, and two ability rows become a keybind and a stat. Recount from the authored rows (the §25 fix already derives `slotsSoFar` rather than hardcoding it) and assert the total never exceeds `maxSlots` at ANY level 1-100, with every known ability still bound.

### Verification
Prove: the gun unlocks at 5, auto-binds to a mouse button, fires a straight ray in the arena and still grabs in the room; strong damage at 10 stamina but magazine-gated; the muzzle flash starts at the barrel; `hammer_fist` and `ember_jab` are gone from every file (grep); `killer_fist` is the renamed survivor with its mechanics intact; and no level 1-100 exceeds the key cap or leaves an ability unbound.
## 30. A knight levels for every round he comes back (supersedes §28 A's "every knight spawns at level 1" and its round-baseline ceiling; extends §20 squads, §28 A per-knight levels)

### The rule
A knight's level is **how many rounds he has been coming**, not what round it is and not how long this fight has run. The knight who has fought since round 1 opens at level N; the one who joined in round 2 opens at N-1; the one who walks in tonight opens at **1**. Round 5 fields **5 / 4 / 3 / 2 / 1**.

There is no knight identity across rounds to look this up from — `spawnSquad` rebuilds the squad every round — so seniority is **synthesised from the squad index**, which is legitimate rather than a fudge: round N fields N knights (§20) and each round adds exactly one, so the index IS a join date. `arena3d.spawnSquad` reuses `knights[0]` and splices the extras off the end, so index 0 is literally the same object that fought round 1.

`knighttree.seniorityFor(index, count)` = `count - index`, 1-based, clamped. `spawnLevel(personality, seniority)` = `startLevel + baseBonus[personality] + (seniority - 1) * levelPerRound`. **Omitting seniority yields §28's number**, so every caller that does not know about it keeps working.

### Growth still happens — but from his own floor
§28's in-fight climb is kept and composes with this: **level = his opening level + what the seconds have earned**. Two changes make that true rather than nominal:
1. `levelFor(personality, seconds, round, seniority)` grows **from `spawnLevel(personality, seniority)`**. §28's version computed an absolute level from seconds alone, so it would have overwritten a veteran's opening level on his first frame — a seniority rule written without this looks like it works and silently does not.
2. The ceiling is **per knight**: `capForKnight` = min(his opening level + `overCap`, `capForRound`), not the round baseline + `overCap` for everyone. The round clamp is the second half and matters for one case — a BRUTE veteran opens one above the round (§28's +1), so without it his ceiling would sit at round + overCap + 1; with it every knight still stops at the round's own ceiling at the latest. A plain veteran's ceiling is therefore unchanged from §28, because his opening level IS the round. Under §28's ceiling every knight in a long round-5 fight converged on level 7 and the ladder evaporated precisely when the fight had run long enough to matter. Measured in a real round-5 fight: spawn `[5,5,3,2,2]` climbing to `[7,7,5,4,4]`, where §28's rule gave `[7,7,7,7,7]`. The veteran's ceiling is unchanged from §28 (round + overCap, because his opening level IS the round).

The **brute's +1 rides on top of seniority**, so temperament still separates two knights who joined the same night — and a newcomer dealt "brute" opens at 2, not 1. That is §28's bonus kept deliberately, not a leak.

### Every layer must agree, including the ones that cannot render
- `arena3d.initBrain(k, i, n)` takes the squad size and sets `k.seniority` / `k.joinRound` / `k.level`; `updateLevel` passes `k.seniority` every frame.
- `arena3d.knightLevels()` pads missing indices with the **seniority** level for that index. §28 padded with the round baseline — and the padded indices are the tail, which is the JUNIOR end, so it priced newcomers as veterans.
- The **no-WebGL stub** answers with the same ladder. The rule is pure arithmetic over the index — no brain, no seconds, no renderer — so a machine that cannot draw fights the same squad shape as one that can. N copies of the round baseline made that floor *harder* than the real game, the one direction a degrade path must never fail in.
- `combat3.start()` opens each entry on the ladder and **builds a stats object per knight**. Every entry previously shared one object by reference, which was harmless while they all had one level and is a corruption the moment they do not. The personality bonus cannot be applied there — temperaments are dealt in the 3D layer, which does not exist when `start()` runs — so it arrives on the first `syncLevels` tick, from the layer that knows.
- `ui/battle3d.js`'s plate names **a range** (`Lv 2-5`), read from the per-knight numbers §28 already published and nothing consumed. One number from the round baseline is a flat lie under a ladder. Dead knights drop out of the range, so the ceiling visibly comes down as the veteran falls.

### BALANCE — a real difficulty change, stated
Round 5 total life multiplier: the pre-§28 flat squad was **8.10x**, §28's all-level-1 opening was **5.00x**, §30 is **6.52x**. The round grows in threat more slowly than it grows in number, and the danger concentrates in one veteran instead of smearing over five equals. If late rounds feel thin the knob is the veteran's climb (`rate`) or `overCap` — never the count (§20's contract) and never `levelPerRound` (it moves the whole ladder at once).

### Verification hooks
`arena3d.debug()` publishes `knightLevels` and now `knightSeniority` / `knightJoinRound`; `combat3.snapshot().enemy` carries `levels` and per-entry `seniority`. A test must prove: round N spawns `[N, N-1, … 1]` before any tick; the ladder is not flattened by the per-frame sync; a long fight ends on a ladder rather than a flat squad; the no-WebGL stub returns the same shape; and the HUD range matches the living knights.

## 31. The whole mouse, and a bottle for stamina (extends §23 pockets, §27B mouse binds; supersedes §29's ladder row for the 9mm)

### The wheel is two more slots, not a special case
`data/config.js mouseSlots` gains `wheelUp` and `wheelDown` (labels `⇑` / `⇓`), and the name now covers the whole mouse rather than its buttons. That one data edit buys storage, validation, the Moves-screen row, the hotbar tile, `entryAt`/`bind` and `press` — because the engine has exactly one question, `isMouseSlot()`, separating "addressed by id" from "indexed as a number key", and a wheel direction is on the id side for the same reasons a button is: no number, not granted by the ladder, owned from level 1. **A slot id may never be an integer** — keys are dense array indices and a new integer id would collide.

What the data edit does NOT buy is an input event. **There was no wheel listener anywhere in this repo**, so the wheel is new input, not a new binding on existing input:
- The listener lives in `ui/battle3d.js` `wireKeys()`/`unwireKeys()`, added on fight start and removed on fight end — **the lifecycle IS the arena-only enforcement**. It must be registered `{passive: false}` (window-level wheel is passive by default in Chrome, and a passive listener cannot `preventDefault`) and removed with the identical options argument or it leaks into the room and the menus.
- It follows `mousePress`'s `handled` protocol: an UNBOUND direction falls through without `preventDefault`, which for a wheel means *let the page scroll*. The bind screen and the shop are scrollable containers and must stay that way.
- **One physical notch emits several `wheel` events** on most trackpads and some mice. The handler accumulates delta and fires once per notch; without that, one flick spends a pocket and then spams the shared consumable cooldown into the fight log.
- `mouseSlotOf()` must not be reused blind: a `WheelEvent.button` reads `0`, so passing a wheel through the button path would fire `mouseL`.

The room is deliberately untouched — the wheel does nothing there. §16's hands and grab own the room's mouse, and the two paths stay separate (a bound button still closes a hand in the room, which is why the room needs a *one-per-run* "not here" tell rather than silence).

### The run opens with a layout
`combat3`'s auto-bind refuses to place anything on a mouse slot by design — a button already has a job in the room, so the engine must not quietly take one. That rule is right for a **reward arriving mid-run** and wrong for the layout a run **starts** with, which the game gets to decide once before the player has a habit to override.

`party.newGame` therefore **seeds** rather than auto-binds: once per run, when every bind store is already empty, it places the fist on `mouseL`, the bandage on `wheelUp` and the mana potion on `wheelDown`. **The 9mm is not seeded** — §29 gave abilities a `bindsTo.mouse` preference list and its `autoBindMouse` claims the first FREE button (`mouseR` first for the gun) without ever evicting one, so with the fist already holding `mouseL` the pistol binds itself to the right button the moment row 1 grants it. Two mechanisms for one job would be one too many; the seed owns the opening layout, the preference list owns what a newly granted ability claims.

The seed never re-places anything, so a cleared slot stays cleared (§27A).

**One semantic, stated because it is a choice and not an accident:** §27A's cleared memory is keyed by ABILITY ID, not by slot — clearing the 9mm off RMB means "not this ability on a button", so it will not then claim LMB either. The wheel inherits that reading rather than inventing a by-slot one. It cannot currently diverge: the seed runs only on an empty store, §23 auto-places consumables into POCKET KEYS and never onto a mouse slot, and §29's `bindsTo` consults the same by-ability list. If anything ever does auto-place onto the wheel, it follows the by-ability reading — two memories disagreeing about what a player's "no" meant is worse than either answer. Its entries are feature-detected against the live tables — an entry naming something absent is what `binds()`' self-heal deletes, and a seed that silently produces nothing is worse than one that never ran.

**Consequence, fixed here:** `combat3`'s key-1 default checked only the key array for a duplicate while the mouse binds it should also consult were read twelve lines later, so the seeded fist appeared on both LMB and key 1. Its own comment already promised otherwise ("unless it is already bound elsewhere … used to leave a duplicate on key 1 and waste the key"). **It was never unreachable:** `bind()` clears an entry off its key when you move it to a button, and the next read re-places `known[0]` on key 1 because the default cannot see the button — so binding your first ability to the mouse has produced this since §27B. §31 changed the odds rather than the possibility, by making it the opening state of every run.

### The 9mm moves to level 1 — and what row 5 becomes
§29 built the 9mm as a **row-5** unlock. The player asked for it from level 1, on the right mouse button, with the fist on the left. Row 1 grants it; **row 5 now buys the gate off** rather than the gun.

**The gate is stamina, and it is the only knob that works.** Magazine size is not the constraint (6 rounds, but a 40-point pool at 18 a shot funds two), and reload only bites if you empty a magazine, which stamina stops you doing. So: **row 1 costs `sta: 18`, row 5 drops it to `sta: 10`** — §29's authored value, arriving as a gate coming off rather than as a buff.

Why 18, priced against the clock rather than a budget: stamina regenerates at **9/s**, so 18 is refunded in **2.0 seconds** — and knight telegraphs run **1500ms (slash) to 2100ms (ground slam)**. Firing once leaves exactly one evade intact (40 − 18 = 22, an evade costs 22). Firing twice empties you, and climbing back to evade cost takes almost exactly one wind-up. The second shot is a bet that his swing outlasts your stamina. At 10 that bet disappears, which is what row 5 is selling.

**What the pistol actually is at level 1** — measured through `combat3.hitEnemy`, not derived:

| | presses to kill | stamina each | range |
|---|---|---|---|
| 9mm (115 power) | 3 shots | 18 | 22m |
| Punch (45 power, `hits: 3`) | 4 casts | 8 | 2.6m |

So it is **not** a throughput upgrade: one press fewer for more than twice the stamina. What it buys is **where you are standing while the fight happens** — 22m of hitscan instead of inside a 70° arc against 1.5–2.1s wind-ups. Price it on position, never on damage.

**Do not re-derive that damage from §12's chart.** The chart says physical → occult is 2.0 and the Hollow Black Knight is occult, but he carries `resists: { physical: 1.0 }`, and `combat3` passes the whole def object to `multiplier()`, so the real factor is **1.0**. The chart is right; the instance overrides it.

### Smelling salts — the third pool gets a bottle
Life had the bandage and magic the drink; stamina, which pays for every evade and most swings, had nothing you could hold. `smelling_salts`: **28 stamina, 14 shards**, one in the opening bag. 28 is authored against one number — an evade costs 22 — so it is "one more dodge, right now" with a little change.

Priced **under** the bandage (14 against 15 for 30 life) despite the smaller number, because stamina is the one pool that returns on its own: 28 stamina is about three seconds you would have got for free, so what you are buying is the three seconds you do not have.

It reaches the shop with **no shop edit** — `engine/shop.js` derives its shelf from `price > 0 && !noShop`. Bindability is likewise data: `'sta'` joins `COMBAT_EFFECT_KEYS` in `data/items.js`, which makes it pressable, offered in the Moves screen's pockets group, and auto-placed into a pocket at run start. The engine half is **not** free: `combat3.useItem` read `hp` and `mp` only, so a `{sta:n}` item was bindable, pressable, and then refused as "Already full." at full health — it needs the third pool in the restore maths and in the result it reports.

### Verification hooks
`ui/battle3d.js` gains `_wheel(direction)` beside `_press`/`_mouse`, or the wheel path is untestable headlessly — everything downstream of the listener runs off rAF, which is frozen in a non-compositing tab. A test must prove: a fresh run seeds exactly three slots — LMB, wheel-up, wheel-down — and leaves RMB for the ladder to claim; the wheel fires a bound pocket in the arena and nothing in the room; an unbound direction lets the page scroll; one notch spends exactly one item; the salts restore stamina in a fight rather than being refused; and the fist is on LMB and **not** duplicated on key 1.
