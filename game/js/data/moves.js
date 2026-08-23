/* CHLOE — data/moves.js  (Combat v2, spec §10 — REPLACES skills.js)
   Schema per move:
   { id, name, cat:'attack'|'defense'|'stance'|'status',
     element:'ember'|'frost'|'volt'|'shadow'|'light'|'none',
     power (attack only, % of atk|mag), usesMag:bool (attack only),
     accuracy (attack only, 0-1), mpCost,
     usableIn:[phases]  // 'neutral'|'aggressive'|'guarded'|'staggered'|'charged'
     blocks:{cats:[],elements:[]}      // defense only
     stanceTo:'aggressive'|'guarded'|'charged'|'neutral'  // stance only ('neutral' only on the recover failsafe, per §10 Resolution 7)
     effect:{...}  // status/defense extras. Conventions:
       { hpPct:n }                                  -> instant heal, % of max HP
       { buff:true,  stat:'atk'|'def'|..., amount:n /*percent*/, turns:n }
       { debuff:true, stat:'atk'|'def'|..., amount:n /*percent*/, turns:n }
       { dot:true, amount:n /*flat HP per turn*/, turns:n }
     failsafe:true  -> engine failsafes (Struggle / Recover), always in the battle menu
     desc }
*/
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.moves = {

  /* ================= shared basics (Chloe + Ash, some reused by enemies) ================= */

  dead_string: {
    id:'dead_string', name:'Dead String', cat:'attack', element:'none',
    power:100, usesMag:false, accuracy:0.95, mpCost:0,
    usableIn:['neutral','aggressive','guarded','staggered','charged'],
    desc:'One muted note, swung like a fist. Costs nothing but pride.'
  },
  fade_step: {
    id:'fade_step', name:'Fade Step', cat:'defense', element:'none',
    mpCost:2, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    desc:'Step out of the light a half-beat before the hit lands.'
  },
  stage_presence: {
    id:'stage_presence', name:'Stage Presence', cat:'stance', element:'none',
    mpCost:3, usableIn:['neutral','guarded'], stanceTo:'charged',
    desc:'Plant your feet. Own the room. The next hit lands like an encore.'
  },
  second_wind: {
    id:'second_wind', name:'Second Wind', cat:'status', element:'none',
    mpCost:4, usableIn:['neutral','guarded','staggered'],
    effect:{ hpPct:20 },
    desc:'One ragged breath between verses. Restores a fifth of your HP.'
  },

  /* ================= Chloe — ember / light ================= */

  power_chord: {
    id:'power_chord', name:'Power Chord', cat:'attack', element:'ember',
    power:160, usesMag:true, accuracy:0.95, mpCost:5,
    usableIn:['neutral','aggressive','charged'],
    desc:'Chloe rakes the Crimson Fret — the riff ignites mid-air.'
  },
  feedback_wall: {
    id:'feedback_wall', name:'Feedback Wall', cat:'defense', element:'ember',
    mpCost:3, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    desc:'A shriek of amp-noise thrown up like a barricade.'
  },
  crescendo: {
    id:'crescendo', name:'Crescendo', cat:'stance', element:'ember',
    mpCost:2, usableIn:['neutral','guarded','staggered'], stanceTo:'aggressive',
    desc:'Build. Louder. Now. Chloe stops holding back.'
  },
  limelight: {
    id:'limelight', name:'Limelight', cat:'attack', element:'light',
    power:120, usesMag:true, accuracy:0.95, mpCost:6,
    usableIn:['neutral','aggressive','charged'],
    desc:'Drag the spotlight onto what hides in the dark. It hates that.'
  },
  flare_riff: {
    id:'flare_riff', name:'Flare Riff', cat:'attack', element:'ember',
    power:200, usesMag:true, accuracy:0.9, mpCost:8,
    usableIn:['aggressive','charged'],
    desc:'Fast fingers, burning frets, sparks off every bend.'
  },
  anthem: {
    id:'anthem', name:'Anthem', cat:'status', element:'light',
    mpCost:7, usableIn:['neutral','guarded'],
    effect:{ hpPct:35 },
    desc:'A chorus that remembers you whole. Restores HP.'
  },
  encore: {
    id:'encore', name:'Encore', cat:'status', element:'none',
    mpCost:5, usableIn:['neutral','aggressive'],
    effect:{ buff:true, stat:'atk', amount:25, turns:3 },
    desc:"The crowd wants more. Give it to them, harder."
  },
  burn_out: {
    id:'burn_out', name:'Burn Out', cat:'status', element:'ember',
    mpCost:6, usableIn:['neutral','aggressive'],
    effect:{ dot:true, amount:5, turns:3 },
    desc:'Leave the tune smoldering under their skin.'
  },
  pyre_solo: {
    id:'pyre_solo', name:'Pyre Solo', cat:'attack', element:'ember',
    power:260, usesMag:true, accuracy:0.85, mpCost:14,
    usableIn:['aggressive','charged'],
    desc:'The whole verse goes up at once. No encore survives it.'
  },
  halo_reprise: {
    id:'halo_reprise', name:'Halo Reprise', cat:'attack', element:'light',
    power:210, usesMag:true, accuracy:0.9, mpCost:12,
    usableIn:['neutral','aggressive','charged'],
    desc:'The last chorus comes back wearing light.'
  },

  /* ================= Ash — volt / shadow ================= */

  livewire_stab: {
    id:'livewire_stab', name:'Livewire Stab', cat:'attack', element:'volt',
    power:150, usesMag:false, accuracy:0.95, mpCost:4,
    usableIn:['neutral','aggressive','charged'],
    desc:'Ash slips inside their guard — the blade bites, the current follows.'
  },
  static_veil: {
    id:'static_veil', name:'Static Veil', cat:'defense', element:'volt',
    mpCost:3, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    effect:{ hpPct:5 },
    desc:'A crackling haze between Ash and everything with intentions.'
  },
  knife_dance: {
    id:'knife_dance', name:'Knife Dance', cat:'stance', element:'none',
    mpCost:2, usableIn:['neutral','guarded','staggered'], stanceTo:'aggressive',
    desc:'Blades out, chin down, all rhythm.'
  },
  blackout: {
    id:'blackout', name:'Blackout', cat:'attack', element:'shadow',
    power:140, usesMag:true, accuracy:0.95, mpCost:5,
    usableIn:['neutral','aggressive','charged'],
    desc:'Ash kills the lights inside their head.'
  },
  short_circuit: {
    id:'short_circuit', name:'Short Circuit', cat:'status', element:'volt',
    mpCost:5, usableIn:['neutral','aggressive'],
    effect:{ debuff:true, stat:'def', amount:20, turns:3 },
    desc:'One spark in the wrong place, and their guard eats itself.'
  },
  static_cling: {
    id:'static_cling', name:'Static Cling', cat:'status', element:'volt',
    mpCost:6, usableIn:['neutral','aggressive'],
    effect:{ dot:true, amount:5, turns:3 },
    desc:"The current stays after the blade leaves. It's clingy like that."
  },
  arc_flash: {
    id:'arc_flash', name:'Arc Flash', cat:'attack', element:'volt',
    power:210, usesMag:true, accuracy:0.9, mpCost:9,
    usableIn:['aggressive','charged'],
    desc:'The room turns white. Something smells burnt. It isn\'t Ash.'
  },
  shadow_slip: {
    id:'shadow_slip', name:'Shadow Slip', cat:'defense', element:'shadow',
    mpCost:4, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:[], elements:['ember','frost','volt'] },
    desc:"Ash goes where the elements can't follow: the dark between the stage lights."
  },
  blade_rain: {
    id:'blade_rain', name:'Blade Rain', cat:'attack', element:'volt',
    power:240, usesMag:false, accuracy:0.85, mpCost:12,
    usableIn:['aggressive','charged'],
    desc:'Every knife she owns. She owns a lot.'
  },
  null_signal: {
    id:'null_signal', name:'Null Signal', cat:'attack', element:'shadow',
    power:260, usesMag:true, accuracy:0.85, mpCost:14,
    usableIn:['aggressive','charged'],
    desc:'The frequency of nothing at all, played straight into a skull.'
  },

  /* ================= enemy-only ================= */

  shade_touch: {
    id:'shade_touch', name:'Shade Touch', cat:'attack', element:'shadow',
    power:120, usesMag:true, accuracy:0.95, mpCost:2,
    usableIn:['neutral','aggressive','charged'],
    desc:'Cold fingers through the chest, feeling for the beat.'
  },
  dead_air: {
    id:'dead_air', name:'Dead Air', cat:'attack', element:'shadow',
    power:150, usesMag:true, accuracy:0.9, mpCost:4,
    usableIn:['neutral','aggressive','charged'],
    desc:'All the sound leaves the room and takes a piece of you with it.'
  },
  hollow_stare: {
    id:'hollow_stare', name:'Hollow Stare', cat:'status', element:'shadow',
    mpCost:3, usableIn:['neutral','aggressive'],
    effect:{ debuff:true, stat:'atk', amount:15, turns:3 },
    desc:'Whatever looked out through those eyes stopped, a long time ago.'
  },
  flicker: {
    id:'flicker', name:'Flicker', cat:'defense', element:'none',
    mpCost:2, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    desc:'It stutters out of existence for a beat, like faulty neon.'
  },
  static_jolt: {
    id:'static_jolt', name:'Static Jolt', cat:'attack', element:'volt',
    power:135, usesMag:true, accuracy:0.95, mpCost:3,
    usableIn:['neutral','aggressive','charged'],
    desc:'A crackling arc off dead speakers.'
  },
  frost_gaze: {
    id:'frost_gaze', name:'Frost Gaze', cat:'attack', element:'frost',
    power:145, usesMag:true, accuracy:0.95, mpCost:4,
    usableIn:['neutral','aggressive','charged'],
    desc:'A mirrored stare that stops the blood.'
  },
  glass_skin: {
    id:'glass_skin', name:'Glass Skin', cat:'defense', element:'frost',
    mpCost:3, usableIn:['neutral','guarded','staggered'],
    blocks:{ cats:['attack'], elements:[] },
    effect:{ hpPct:5 },
    desc:'Its surface goes mirror-hard. Blows glance off into the dark.'
  },
  spotlight_drain: {
    id:'spotlight_drain', name:'Spotlight Drain', cat:'attack', element:'shadow',
    power:170, usesMag:true, accuracy:0.9, mpCost:6,
    usableIn:['neutral','aggressive','charged'],
    desc:'The Promoter takes your moment — and your pulse with it.'
  },

  /* ================= engine failsafes (spec §10 Resolution 7) ================= */

  struggle: {
    id:'struggle', name:'Struggle', cat:'attack', element:'none',
    power:60, usesMag:false, accuracy:1.0, mpCost:0, failsafe:true,
    usableIn:['neutral','aggressive','guarded','staggered','charged'],
    desc:"Swing at it with whatever's left."
  },
  recover: {
    id:'recover', name:'Recover', cat:'stance', element:'none',
    mpCost:0, failsafe:true, usableIn:['staggered'],
    stanceTo:'neutral',
    effect:{ hpPct:5 },
    desc:'Find your footing. Breathe. Get back in it.'
  }
};
