/* CHLOE — data/moves.js  (Combat v2 §10 + Progression v3 §12 migration)
   Schema per move:
   { id, name, cat:'attack'|'defense'|'stance'|'status',
     type: one of the 11 v3 damage types (§12):
       'physical'|'magical'|'lightning'|'fire'|'occult'|'blood'|'poison'|'divine'|'virus'|'ghost'|'biological'
     element: LEGACY alias for v2 code paths ('ember'|'frost'|'volt'|'shadow'|'light'|'none').
       Mapping (§12): none<->physical, ember<->fire, volt<->lightning, shadow<->occult,
       light<->divine, frost<->magical. New-world types (ghost/blood/poison/virus/biological)
       alias to 'none' for legacy consumers.
     power (attack only, % of atk|mag), usesMag:bool (attack only),
     accuracy (attack only, 0-1),
     cost:{ sta?, mp?, faith? }  // v3 resources (§12): physical-type -> sta 10-25,
                                 // spells -> mp, divine/occult -> faith 1-3, failsafes free ({}).
                                 // biological strikes are bodywork: they spend sta.
     mpCost  // LEGACY alias == (cost.mp||0); kept so v2 engine keeps working. Do not add bare mpCost.
     usableIn:[phases]  // 'neutral'|'aggressive'|'guarded'|'staggered'|'charged'
     blocks:{cats:[],elements:[]}      // defense only (elements listed in v3 type names)
     stanceTo:'aggressive'|'guarded'|'charged'|'neutral'  // stance only ('neutral' only on the recover failsafe)
     buildup:{ status:'burn'|'shock'|'bleed'|'poisoned'|'curse'|'infection'|'haunt', amount:20-40 } // §12 status meters
     effect:{...}  // status/defense extras. Conventions:
       { hpPct:n }                                  -> instant heal, % of max life
       { buff:true,  stat:'atk'|'def'|..., amount:n (percent), turns:n }
       { debuff:true, stat:'atk'|'def'|..., amount:n (percent), turns:n }
       { dot:true, amount:n (flat life per turn), turns:n }
       { cleanse:true }                             -> clears all active statuses + buildup on target
       { lifesteal:n }                              -> attacker heals n% of damage dealt
     failsafe:true  -> engine failsafes (Struggle / Recover), always in the battle menu
     treeOnly:true  -> granted ONLY by skill-tree nodes (§12); never in any learnset
     desc }
*/
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.moves = {

  /* ================= shared basics (Chloe + Ash, some reused by enemies) ================= */

  dead_string: {
    id:'dead_string', name:'Dead String', cat:'attack', type:'physical', element:'none',
    power:100, usesMag:false, accuracy:0.95, cost:{ sta:12 }, mpCost:0,
    usableIn:['neutral','aggressive','guarded','staggered','charged'],
    desc:'One muted note, swung like a fist. Costs nothing but sweat and pride.'
  },
  fade_step: {
    id:'fade_step', name:'Fade Step', cat:'defense', type:'physical', element:'none',
    cost:{ sta:10 }, mpCost:0, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    desc:'Step out of the light a half-beat before the hit lands.'
  },
  stage_presence: {
    id:'stage_presence', name:'Stage Presence', cat:'stance', type:'physical', element:'none',
    cost:{ sta:10 }, mpCost:0, usableIn:['neutral','guarded'], stanceTo:'charged',
    desc:'Plant your feet. Own the room. The next hit lands like an encore.'
  },
  second_wind: {
    id:'second_wind', name:'Second Wind', cat:'status', type:'physical', element:'none',
    cost:{ sta:10 }, mpCost:0, usableIn:['neutral','guarded','staggered'],
    effect:{ hpPct:20 },
    desc:'One ragged breath between verses. Restores a fifth of your life.'
  },

  /* ================= Chloe — fire / divine ================= */

  power_chord: {
    id:'power_chord', name:'Power Chord', cat:'attack', type:'fire', element:'ember',
    power:160, usesMag:true, accuracy:0.95, cost:{ mp:5 }, mpCost:5,
    usableIn:['neutral','aggressive','charged'],
    buildup:{ status:'burn', amount:20 },
    desc:'Chloe rakes the Crimson Fret — the riff ignites mid-air.'
  },
  feedback_wall: {
    id:'feedback_wall', name:'Feedback Wall', cat:'defense', type:'fire', element:'ember',
    cost:{ mp:3 }, mpCost:3, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    desc:'A shriek of amp-noise thrown up like a barricade.'
  },
  crescendo: {
    id:'crescendo', name:'Crescendo', cat:'stance', type:'fire', element:'ember',
    cost:{ mp:2 }, mpCost:2, usableIn:['neutral','guarded','staggered'], stanceTo:'aggressive',
    desc:'Build. Louder. Now. Chloe stops holding back.'
  },
  limelight: {
    id:'limelight', name:'Limelight', cat:'attack', type:'divine', element:'light',
    power:120, usesMag:true, accuracy:0.95, cost:{ faith:1 }, mpCost:0,
    usableIn:['neutral','aggressive','charged'],
    desc:'Drag the spotlight onto what hides in the dark. It hates that.'
  },
  flare_riff: {
    id:'flare_riff', name:'Flare Riff', cat:'attack', type:'fire', element:'ember',
    power:200, usesMag:true, accuracy:0.9, cost:{ mp:8 }, mpCost:8,
    usableIn:['aggressive','charged'],
    buildup:{ status:'burn', amount:30 },
    desc:'Fast fingers, burning frets, sparks off every bend.'
  },
  anthem: {
    id:'anthem', name:'Anthem', cat:'status', type:'divine', element:'light',
    cost:{ faith:2 }, mpCost:0, usableIn:['neutral','guarded'],
    effect:{ hpPct:35 },
    desc:'A chorus that remembers you whole. Restores life.'
  },
  encore: {
    id:'encore', name:'Encore', cat:'status', type:'physical', element:'none',
    cost:{ sta:10 }, mpCost:0, usableIn:['neutral','aggressive'],
    effect:{ buff:true, stat:'atk', amount:25, turns:3 },
    desc:"The crowd wants more. Give it to them, harder."
  },
  burn_out: {
    id:'burn_out', name:'Burn Out', cat:'status', type:'fire', element:'ember',
    cost:{ mp:6 }, mpCost:6, usableIn:['neutral','aggressive'],
    effect:{ dot:true, amount:5, turns:3 },
    buildup:{ status:'burn', amount:35 },
    desc:'Leave the tune smoldering under their skin.'
  },
  pyre_solo: {
    id:'pyre_solo', name:'Pyre Solo', cat:'attack', type:'fire', element:'ember',
    power:260, usesMag:true, accuracy:0.85, cost:{ mp:14 }, mpCost:14,
    usableIn:['aggressive','charged'],
    buildup:{ status:'burn', amount:40 },
    desc:'The whole verse goes up at once. No encore survives it.'
  },
  halo_reprise: {
    id:'halo_reprise', name:'Halo Reprise', cat:'attack', type:'divine', element:'light',
    power:210, usesMag:true, accuracy:0.9, cost:{ faith:2 }, mpCost:0,
    usableIn:['neutral','aggressive','charged'],
    desc:'The last chorus comes back wearing light.'
  },

  /* ================= Ash — lightning / occult ================= */

  livewire_stab: {
    id:'livewire_stab', name:'Livewire Stab', cat:'attack', type:'lightning', element:'volt',
    power:150, usesMag:false, accuracy:0.95, cost:{ mp:4 }, mpCost:4,
    usableIn:['neutral','aggressive','charged'],
    buildup:{ status:'shock', amount:20 },
    desc:'Ash slips inside their guard — the blade bites, the current follows.'
  },
  static_veil: {
    id:'static_veil', name:'Static Veil', cat:'defense', type:'lightning', element:'volt',
    cost:{ mp:3 }, mpCost:3, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    effect:{ hpPct:5 },
    desc:'A crackling haze between Ash and everything with intentions.'
  },
  knife_dance: {
    id:'knife_dance', name:'Knife Dance', cat:'stance', type:'physical', element:'none',
    cost:{ sta:10 }, mpCost:0, usableIn:['neutral','guarded','staggered'], stanceTo:'aggressive',
    desc:'Blades out, chin down, all rhythm.'
  },
  blackout: {
    id:'blackout', name:'Blackout', cat:'attack', type:'occult', element:'shadow',
    power:140, usesMag:true, accuracy:0.95, cost:{ faith:1 }, mpCost:0,
    usableIn:['neutral','aggressive','charged'],
    buildup:{ status:'curse', amount:25 },
    desc:'Ash kills the lights inside their head.'
  },
  short_circuit: {
    id:'short_circuit', name:'Short Circuit', cat:'status', type:'lightning', element:'volt',
    cost:{ mp:5 }, mpCost:5, usableIn:['neutral','aggressive'],
    effect:{ debuff:true, stat:'def', amount:20, turns:3 },
    buildup:{ status:'shock', amount:25 },
    desc:'One spark in the wrong place, and their guard eats itself.'
  },
  static_cling: {
    id:'static_cling', name:'Static Cling', cat:'status', type:'lightning', element:'volt',
    cost:{ mp:6 }, mpCost:6, usableIn:['neutral','aggressive'],
    effect:{ dot:true, amount:5, turns:3 },
    buildup:{ status:'shock', amount:30 },
    desc:"The current stays after the blade leaves. It's clingy like that."
  },
  arc_flash: {
    id:'arc_flash', name:'Arc Flash', cat:'attack', type:'lightning', element:'volt',
    power:210, usesMag:true, accuracy:0.9, cost:{ mp:9 }, mpCost:9,
    usableIn:['aggressive','charged'],
    buildup:{ status:'shock', amount:35 },
    desc:'The room turns white. Something smells burnt. It isn\'t Ash.'
  },
  shadow_slip: {
    id:'shadow_slip', name:'Shadow Slip', cat:'defense', type:'occult', element:'shadow',
    cost:{ faith:1 }, mpCost:0, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:[], elements:['fire','magical','lightning'] },
    desc:"Ash goes where the elements can't follow: the dark between the stage lights."
  },
  blade_rain: {
    id:'blade_rain', name:'Blade Rain', cat:'attack', type:'lightning', element:'volt',
    power:240, usesMag:false, accuracy:0.85, cost:{ mp:12 }, mpCost:12,
    usableIn:['aggressive','charged'],
    desc:'Every knife she owns. She owns a lot.'
  },
  null_signal: {
    id:'null_signal', name:'Null Signal', cat:'attack', type:'occult', element:'shadow',
    power:260, usesMag:true, accuracy:0.85, cost:{ faith:2 }, mpCost:0,
    usableIn:['aggressive','charged'],
    buildup:{ status:'curse', amount:30 },
    desc:'The frequency of nothing at all, played straight into a skull.'
  },

  /* ================= enemy-only ================= */

  shade_touch: {
    id:'shade_touch', name:'Shade Touch', cat:'attack', type:'occult', element:'shadow',
    power:120, usesMag:true, accuracy:0.95, cost:{ faith:1 }, mpCost:0,
    usableIn:['neutral','aggressive','charged'],
    buildup:{ status:'curse', amount:20 },
    desc:'Cold fingers through the chest, feeling for the beat.'
  },
  dead_air: {
    id:'dead_air', name:'Dead Air', cat:'attack', type:'occult', element:'shadow',
    power:150, usesMag:true, accuracy:0.9, cost:{ faith:1 }, mpCost:0,
    usableIn:['neutral','aggressive','charged'],
    desc:'All the sound leaves the room and takes a piece of you with it.'
  },
  hollow_stare: {
    id:'hollow_stare', name:'Hollow Stare', cat:'status', type:'occult', element:'shadow',
    cost:{ faith:1 }, mpCost:0, usableIn:['neutral','aggressive'],
    effect:{ debuff:true, stat:'atk', amount:15, turns:3 },
    desc:'Whatever looked out through those eyes stopped, a long time ago.'
  },
  flicker: {
    id:'flicker', name:'Flicker', cat:'defense', type:'physical', element:'none',
    cost:{ sta:10 }, mpCost:0, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    desc:'It stutters out of existence for a beat, like faulty neon.'
  },
  static_jolt: {
    id:'static_jolt', name:'Static Jolt', cat:'attack', type:'lightning', element:'volt',
    power:135, usesMag:true, accuracy:0.95, cost:{ mp:3 }, mpCost:3,
    usableIn:['neutral','aggressive','charged'],
    desc:'A crackling arc off dead speakers.'
  },
  frost_gaze: {
    id:'frost_gaze', name:'Frost Gaze', cat:'attack', type:'magical', element:'frost',
    power:145, usesMag:true, accuracy:0.95, cost:{ mp:4 }, mpCost:4,
    usableIn:['neutral','aggressive','charged'],
    desc:'A mirrored stare that stops the blood.'
  },
  glass_skin: {
    id:'glass_skin', name:'Glass Skin', cat:'defense', type:'magical', element:'frost',
    cost:{ mp:3 }, mpCost:3, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    effect:{ hpPct:5 },
    desc:'Its surface goes mirror-hard. Blows glance off into the dark.'
  },
  spotlight_drain: {
    id:'spotlight_drain', name:'Spotlight Drain', cat:'attack', type:'occult', element:'shadow',
    power:170, usesMag:true, accuracy:0.9, cost:{ faith:2 }, mpCost:0,
    usableIn:['neutral','aggressive','charged'],
    desc:'The Promoter takes your moment — and your pulse with it.'
  },

  /* ================= tree-gated: Chloe (§12 — NOT in any learnset; granted by tree nodes only) ================= */

  crimson_riff: {
    id:'crimson_riff', name:'Crimson Riff', cat:'attack', type:'fire', element:'ember', treeOnly:true,
    power:110, usesMag:true, accuracy:0.95, cost:{ mp:6 }, mpCost:6,
    usableIn:['neutral','aggressive','charged'],
    desc:'The Pyre branch begins here: a riff the color of arterial neon.'
  },
  pyre_burst: {
    id:'pyre_burst', name:'Pyre Burst', cat:'attack', type:'fire', element:'ember', treeOnly:true,
    power:130, usesMag:true, accuracy:0.9, cost:{ mp:10 }, mpCost:10,
    usableIn:['neutral','aggressive','charged'],
    buildup:{ status:'burn', amount:35 },
    desc:'One chord detonated instead of played. The embers linger and dig in.'
  },
  judgement_chord: {
    id:'judgement_chord', name:'Judgement Chord', cat:'attack', type:'divine', element:'light', treeOnly:true,
    power:160, usesMag:true, accuracy:0.9, cost:{ faith:3 }, mpCost:0,
    usableIn:['aggressive','charged'],
    desc:'Keystone of the Voice. Every wrong the room ever hosted, resolved in one chord.'
  },
  hymn_of_static: {
    id:'hymn_of_static', name:'Hymn of Static', cat:'status', type:'divine', element:'light', treeOnly:true,
    cost:{ faith:2 }, mpCost:0, usableIn:['neutral','guarded','staggered'],
    effect:{ hpPct:20, cleanse:true },
    desc:'A hiss between stations that somehow forgives. Heals and clears every affliction.'
  },
  mercy_note: {
    id:'mercy_note', name:'Mercy Note', cat:'status', type:'divine', element:'light', treeOnly:true,
    cost:{ faith:3 }, mpCost:0, usableIn:['neutral','guarded'],
    effect:{ hpPct:50 },
    desc:'The one note Chloe never plays on stage. Restores half of a life.'
  },
  iron_string: {
    id:'iron_string', name:'Iron String', cat:'defense', type:'physical', element:'none', treeOnly:true,
    cost:{ sta:12 }, mpCost:0, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    effect:{ hpPct:5 },
    desc:'Steel branch. She strings the guitar with wire rope and stands behind it.'
  },
  arcane_feedback: {
    id:'arcane_feedback', name:'Arcane Feedback', cat:'attack', type:'magical', element:'frost', treeOnly:true,
    power:120, usesMag:true, accuracy:0.95, cost:{ mp:8 }, mpCost:8,
    usableIn:['neutral','aggressive','charged'],
    desc:'Raw spellwork looped through the amp until it screams in sigils.'
  },
  raw_howl: {
    id:'raw_howl', name:'Raw Howl', cat:'attack', type:'biological', element:'none', treeOnly:true,
    power:105, usesMag:false, accuracy:0.95, cost:{ sta:15 }, mpCost:0,
    usableIn:['neutral','aggressive','staggered'],
    desc:'No amp, no pick, no mercy. Just lungs, blood, and a note that bruises meat.'
  },

  /* ================= tree-gated: Ash (§12 — NOT in any learnset; granted by tree nodes only) ================= */

  storm_call: {
    id:'storm_call', name:'Storm Call', cat:'attack', type:'lightning', element:'volt', treeOnly:true,
    power:140, usesMag:true, accuracy:0.9, cost:{ mp:11 }, mpCost:11,
    usableIn:['neutral','aggressive','charged'],
    buildup:{ status:'shock', amount:35 },
    desc:'Storm branch. Ash whistles and the wiring in the walls answers.'
  },
  grave_echo: {
    id:'grave_echo', name:'Grave Echo', cat:'attack', type:'ghost', element:'none', treeOnly:true,
    power:115, usesMag:true, accuracy:0.95, cost:{ mp:7 }, mpCost:7,
    usableIn:['neutral','aggressive','charged'],
    buildup:{ status:'haunt', amount:25 },
    desc:'She repeats your last words back at you. You haven\'t said them yet.'
  },
  veil_walk: {
    id:'veil_walk', name:'Veil Walk', cat:'stance', type:'ghost', element:'none', treeOnly:true,
    cost:{ mp:5 }, mpCost:5, usableIn:['neutral','guarded'], stanceTo:'charged',
    desc:'Veil branch. Ash steps halfway out of the world and winds up like a held breath.'
  },
  toxin_kiss: {
    id:'toxin_kiss', name:'Toxin Kiss', cat:'status', type:'poison', element:'none', treeOnly:true,
    cost:{ mp:6 }, mpCost:6, usableIn:['neutral','aggressive'],
    effect:{ dot:true, amount:4, turns:3 },
    buildup:{ status:'poisoned', amount:40 },
    desc:'Lipstick off a green-room mirror. One brush and the night starts going wrong.'
  },
  blood_tithe: {
    id:'blood_tithe', name:'Blood Tithe', cat:'attack', type:'blood', element:'none', treeOnly:true,
    power:120, usesMag:false, accuracy:0.95, cost:{ mp:9 }, mpCost:9,
    usableIn:['neutral','aggressive','charged'],
    effect:{ lifesteal:30 },
    buildup:{ status:'bleed', amount:30 },
    desc:'The blade takes its cut and pays Ash her percentage. The wound keeps the books open.'
  },
  plague_string: {
    id:'plague_string', name:'Plague String', cat:'attack', type:'virus', element:'none', treeOnly:true,
    power:110, usesMag:true, accuracy:0.95, cost:{ mp:8 }, mpCost:8,
    usableIn:['neutral','aggressive','charged'],
    buildup:{ status:'infection', amount:35 },
    desc:'Toxin branch. A garrote strung with something that multiplies.'
  },
  hex_needle: {
    id:'hex_needle', name:'Hex Needle', cat:'attack', type:'occult', element:'shadow', treeOnly:true,
    power:100, usesMag:true, accuracy:0.95, cost:{ faith:2 }, mpCost:0,
    usableIn:['neutral','aggressive','charged'],
    buildup:{ status:'curse', amount:30 },
    desc:'A sliver of dark pushed under the skin, sewing bad luck into the seams.'
  },

  /* ================= engine failsafes (spec §10 Resolution 7 — always free) ================= */

  struggle: {
    id:'struggle', name:'Struggle', cat:'attack', type:'physical', element:'none',
    power:60, usesMag:false, accuracy:1.0, cost:{}, mpCost:0, failsafe:true,
    usableIn:['neutral','aggressive','guarded','staggered','charged'],
    desc:"Swing at it with whatever's left."
  },
  recover: {
    id:'recover', name:'Recover', cat:'stance', type:'physical', element:'none',
    cost:{}, mpCost:0, failsafe:true, usableIn:['staggered'],
    stanceTo:'neutral',
    effect:{ hpPct:5 },
    desc:'Find your footing. Breathe. Get back in it.'
  }
};
