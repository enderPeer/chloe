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
