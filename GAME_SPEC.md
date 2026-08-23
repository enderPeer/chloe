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
