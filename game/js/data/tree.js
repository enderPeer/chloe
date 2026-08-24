/* CHLOE — data/tree.js  (Progression v3, spec §12)
   CHLOE.data.trees = { chloe:{name,branches,nodes:[...]}, ash:{...} }
   Node schema (spec §12, binding):
   { id, branch, name, desc, cost (1 stat | 2 move/passive | 3 keystone),
     requires:[nodeIds]  // ANY-OF; [] = root
     pos:{x,y}           // percent layout, hand-placed (root top-center, 3 lanes fan out)
     kind:'stat'|'move'|'passive'|'keystone',
     grant }             // stat -> {stat:{...}} | move -> {move:moveId}
                         // passive/keystone -> {passive:{...}} (keystone documented in desc)
   Totals: 60 nodes / 90 points per character.
   Tree-gated move ids referenced here MUST exist in data/moves.js:
     Chloe: crimson_riff, pyre_burst, judgement_chord, hymn_of_static,
            mercy_note, iron_string, arcane_feedback, raw_howl
     Ash:   storm_call, grave_echo, veil_walk, toxin_kiss, blood_tithe,
            plague_string, hex_needle
*/
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.trees = {

  /* ============================================================ CHLOE */
  chloe: {
    name: "Chloe — Setlist of the Pyre",
    branches: {
      trunk: { name:'Trunk',  color:'#8a8f98', blurb:'Shared fundamentals. Every road starts backstage.' },
      pyre:  { name:'Pyre',   color:'#ff5533', blurb:'Fire and fury. Burn buildup, raw spell damage.' },
      voice: { name:'Voice',  color:'#ffd166', blurb:'Divine support. Faith, healing, cleansing hymns.' },
      steel: { name:'Steel',  color:'#9db4c0', blurb:'Physical grit. Defense, stamina, standing back up.' }
    },
    nodes: [

      /* ---- Combat v3 fists (§17) ----
         The real-time hotbar starts with ONE key and one ability (punch).
         These nodes are the only source of extra abilities and extra number
         keys, so every level-up spent here literally widens the hotbar. */
      { id:'c_v3_slot1', branch:'trunk', name:'Second Nature', desc:'Muscle memory for one more trick. +1 ability keybind (key 2).',
        cost:1, requires:[], pos:{x:38,y:2}, kind:'passive', grant:{abilitySlot:1} },
      { id:'c_v3_hammer', branch:'steel', name:'Hammer Fist', desc:'Unlocks the Hammer Fist ability — one slow, heavy overhand.',
        cost:2, requires:['c_v3_slot1'], pos:{x:26,y:2}, kind:'move', grant:{ability:'hammer_fist'} },
      { id:'c_v3_slot2', branch:'trunk', name:'Quick Hands', desc:'+1 ability keybind (key 3).',
        cost:1, requires:['c_v3_slot1'], pos:{x:62,y:2}, kind:'passive', grant:{abilitySlot:1} },
      { id:'c_v3_ember', branch:'pyre', name:'Ember Jab', desc:'Unlocks Ember Jab — a jab that lights on contact.',
        cost:2, requires:['c_v3_slot2'], pos:{x:74,y:2}, kind:'move', grant:{ability:'ember_jab'} },
      { id:'c_v3_breaker', branch:'voice', name:'Hollow Breaker', desc:'Unlocks Hollow Breaker — divine damage that ignores plate.',
        cost:3, requires:['c_v3_ember'], pos:{x:86,y:2}, kind:'move', grant:{ability:'hollow_breaker'} },

      /* ---- trunk (5) ---- */
      { id:'c_t1', branch:'trunk', name:'First Chord', desc:'The night it all started. +8 life.',
        cost:1, requires:[], pos:{x:50,y:6}, kind:'stat', grant:{stat:{life:8}} },
      { id:'c_t2', branch:'trunk', name:'Calloused Hands', desc:'Strings bite less every year. +3 atk.',
        cost:1, requires:['c_t1'], pos:{x:26,y:15}, kind:'stat', grant:{stat:{atk:3}} },
      { id:'c_t3', branch:'trunk', name:'Deep Breath', desc:'In through the nose, out through the amp. +8 stamina.',
        cost:1, requires:['c_t1'], pos:{x:42,y:15}, kind:'stat', grant:{stat:{stamina:8}} },
      { id:'c_t4', branch:'trunk', name:'Quiet Prayer', desc:'Something is listening. +6 mag.',
        cost:1, requires:['c_t1'], pos:{x:58,y:15}, kind:'stat', grant:{stat:{mag:6}} },
      { id:'c_t5', branch:'trunk', name:'Stage Legs', desc:'Never miss a cue. +3 spd.',
        cost:1, requires:['c_t1'], pos:{x:74,y:15}, kind:'stat', grant:{stat:{spd:3}} },

      /* ---- Pyre — fire / attack (18: 9 stat, 3 move, 5 passive, 1 keystone) ---- */
      { id:'c_p1', branch:'pyre', name:'Crimson Riff', desc:'Learn Crimson Riff — a fast fire slash off the low string.',
        cost:2, requires:['c_t2'], pos:{x:8,y:28}, kind:'move', grant:{move:'crimson_riff'} },
      { id:'c_p2', branch:'pyre', name:'Kindling', desc:'Every note a spark. +4 mag.',
        cost:1, requires:['c_t2'], pos:{x:20,y:28}, kind:'stat', grant:{stat:{mag:4}} },
      { id:'c_p3', branch:'pyre', name:'Hot Pick', desc:'Play it like it owes you money. +4 atk.',
        cost:1, requires:['c_t2'], pos:{x:32,y:28}, kind:'stat', grant:{stat:{atk:4}} },
      { id:'c_p4', branch:'pyre', name:'Stoked Coals', desc:'The heat stays after the song ends. +5 mag.',
        cost:1, requires:['c_p1'], pos:{x:8,y:41}, kind:'stat', grant:{stat:{mag:5}} },
      { id:'c_p5', branch:'pyre', name:'Fireproof Nerves', desc:'You have stood inside worse. Fire damage taken -15%.',
        cost:2, requires:['c_p2'], pos:{x:20,y:41}, kind:'passive', grant:{passive:{resist:{fire:15}}} },
      { id:'c_p6', branch:'pyre', name:'Pyre Burst', desc:'Learn Pyre Burst — an eruption that stacks burn buildup.',
        cost:2, requires:['c_p3'], pos:{x:32,y:41}, kind:'move', grant:{move:'pyre_burst'} },
      { id:'c_p7', branch:'pyre', name:'Smoke Lungs', desc:'Breathe the black and keep singing. Burn buildup taken -30%.',
        cost:2, requires:['c_p4'], pos:{x:8,y:54}, kind:'passive', grant:{passive:{statusResist:{burn:30}}} },
      { id:'c_p8', branch:'pyre', name:'Rising Key', desc:'Half-step up, whole room hotter. +6 mag.',
        cost:1, requires:['c_p5'], pos:{x:20,y:54}, kind:'stat', grant:{stat:{mag:6}} },
      { id:'c_p9', branch:'pyre', name:'Heavy Strings', desc:'Thicker gauge, meaner tone. +6 atk.',
        cost:1, requires:['c_p6'], pos:{x:32,y:54}, kind:'stat', grant:{stat:{atk:6}} },
      { id:'c_p10', branch:'pyre', name:'Arcane Feedback', desc:'Learn Arcane Feedback — raw magical noise flung as a weapon.',
        cost:2, requires:['c_p7'], pos:{x:8,y:67}, kind:'move', grant:{move:'arcane_feedback'} },
      { id:'c_p11', branch:'pyre', name:'Fed by the Blaze', desc:'The fire keeps you standing. +10 life.',
        cost:1, requires:['c_p8'], pos:{x:20,y:67}, kind:'stat', grant:{stat:{life:10}} },
      { id:'c_p12', branch:'pyre', name:'Burning Momentum', desc:'Heat in the blood, spring in the step. Stamina regen +10%.',
        cost:2, requires:['c_p9'], pos:{x:32,y:67}, kind:'passive', grant:{passive:{staminaRegenPct:10}} },
      { id:'c_p13', branch:'pyre', name:'White Heat', desc:'Past red, past orange. +8 mag.',
        cost:1, requires:['c_p10'], pos:{x:8,y:80}, kind:'stat', grant:{stat:{mag:8}} },
      { id:'c_p14', branch:'pyre', name:'Ash Harvest', desc:'What burns down feeds you. Defeating an enemy restores 10% life.',
        cost:2, requires:['c_p11'], pos:{x:20,y:80}, kind:'passive', grant:{passive:{onKillLifePct:10}} },
      { id:'c_p15', branch:'pyre', name:'Scorched Earth', desc:'Nothing gentle left in the swing. +8 atk.',
        cost:1, requires:['c_p12'], pos:{x:32,y:80}, kind:'stat', grant:{stat:{atk:8}} },
      { id:'c_p16', branch:'pyre', name:'Heart of the Furnace', desc:'The song is mostly flame now. +10 mag.',
        cost:1, requires:['c_p13'], pos:{x:8,y:92}, kind:'stat', grant:{stat:{mag:10}} },
      { id:'c_p17', branch:'pyre', name:'ARSONATA', desc:'KEYSTONE: fire moves inflict +50% burn buildup, and burning enemies take +20% damage from Chloe’s fire attacks.',
        cost:3, requires:['c_p14'], pos:{x:20,y:92}, kind:'keystone', grant:{passive:{burnBuildupPct:50, fireDamagePct:20}} },
      { id:'c_p18', branch:'pyre', name:'Feedback Shield', desc:'Your own noise bends theirs aside. Magical damage taken -15%.',
        cost:2, requires:['c_p15'], pos:{x:32,y:92}, kind:'passive', grant:{passive:{resist:{magical:15}}} },

      /* ---- Voice — divine / faith / support (19: 10 stat, 3 move, 5 passive, 1 keystone) ---- */
      { id:'c_v1', branch:'voice', name:'Warm-Up Scales', desc:'Do-re-mi before do-or-die. +8 magic.',
        cost:1, requires:['c_t3','c_t4'], pos:{x:44,y:28}, kind:'stat', grant:{stat:{magic:8}} },
      { id:'c_v2', branch:'voice', name:'Hymn of Static', desc:'Learn Hymn of Static — a faith-fed chant that heals and cleanses.',
        cost:2, requires:['c_t3','c_t4'], pos:{x:56,y:28}, kind:'move', grant:{move:'hymn_of_static'} },
      { id:'c_v3', branch:'voice', name:'Kept Vigil', desc:'You never stopped believing, exactly. +3 max faith.',
        cost:1, requires:['c_v1'], pos:{x:38,y:41}, kind:'stat', grant:{stat:{faith:3}} },
      { id:'c_v4', branch:'voice', name:'Clear Tone', desc:'A note with no doubt in it. +5 mag.',
        cost:1, requires:['c_v1','c_v2'], pos:{x:50,y:41}, kind:'stat', grant:{stat:{mag:5}} },
      { id:'c_v5', branch:'voice', name:'Warded Throat', desc:'They can’t hex what they can’t silence. Curse buildup taken -30%.',
        cost:2, requires:['c_v2'], pos:{x:62,y:41}, kind:'passive', grant:{passive:{statusResist:{curse:30}}} },
      { id:'c_v6', branch:'voice', name:'Second Verse', desc:'There is always another verse in you. +8 life.',
        cost:1, requires:['c_v3'], pos:{x:38,y:54}, kind:'stat', grant:{stat:{life:8}} },
      { id:'c_v7', branch:'voice', name:'Mercy Note', desc:'Learn Mercy Note — one held note that closes wounds. Big heal.',
        cost:2, requires:['c_v4'], pos:{x:46,y:54}, kind:'move', grant:{move:'mercy_note'} },
      { id:'c_v8', branch:'voice', name:'Long Setlist', desc:'Deeper reserves for longer nights. +10 magic.',
        cost:1, requires:['c_v4'], pos:{x:54,y:54}, kind:'stat', grant:{stat:{magic:10}} },
      { id:'c_v9', branch:'voice', name:'Salt Ring', desc:'Old tricks still work. Occult damage taken -15%.',
        cost:2, requires:['c_v5'], pos:{x:62,y:54}, kind:'passive', grant:{passive:{resist:{occult:15}}} },
      { id:'c_v10', branch:'voice', name:'Litany', desc:'Words worn smooth by repetition. +3 max faith.',
        cost:1, requires:['c_v6'], pos:{x:40,y:67}, kind:'stat', grant:{stat:{faith:3}} },
      { id:'c_v11', branch:'voice', name:'Judgement Chord', desc:'Learn Judgement Chord — the verdict, played fortissimo. Keystone-tier divine attack.',
        cost:2, requires:['c_v7','c_v8'], pos:{x:50,y:67}, kind:'move', grant:{move:'judgement_chord'} },
      { id:'c_v12', branch:'voice', name:'Steady Voice', desc:'The dead can rattle the room, not the melody. Haunt buildup taken -40%.',
        cost:2, requires:['c_v9'], pos:{x:60,y:67}, kind:'passive', grant:{passive:{statusResist:{haunt:40}}} },
      { id:'c_v13', branch:'voice', name:'Full-Throated', desc:'Louder than the dark. +6 mag.',
        cost:1, requires:['c_v10'], pos:{x:38,y:80}, kind:'stat', grant:{stat:{mag:6}} },
      { id:'c_v14', branch:'voice', name:'Standing Ovation', desc:'The room holds you up. +10 life.',
        cost:1, requires:['c_v11'], pos:{x:46,y:80}, kind:'stat', grant:{stat:{life:10}} },
      { id:'c_v15', branch:'voice', name:'Cleansing Note', desc:'Sickness slides off the melody. Infection buildup taken -30%.',
        cost:2, requires:['c_v11'], pos:{x:54,y:80}, kind:'passive', grant:{passive:{statusResist:{infection:30}}} },
      { id:'c_v16', branch:'voice', name:'Cathedral Lungs', desc:'Room-filling, rafters-shaking reserves. +12 magic.',
        cost:1, requires:['c_v13'], pos:{x:40,y:92}, kind:'stat', grant:{stat:{magic:12}} },
      { id:'c_v17', branch:'voice', name:'SAINTED CHORUS', desc:'KEYSTONE: +1 bonus faith at the start of Chloe’s turn, and all her healing restores 30% more.',
        cost:3, requires:['c_v14'], pos:{x:50,y:92}, kind:'keystone', grant:{passive:{faithPerTurn:1, healPowerPct:30}} },
      { id:'c_v18', branch:'voice', name:'Credo', desc:'Belief with a backbeat. +3 max faith.',
        cost:1, requires:['c_v15'], pos:{x:60,y:92}, kind:'stat', grant:{stat:{faith:3}} },
      { id:'c_v19', branch:'voice', name:'Consecrated Strings', desc:'Blessed brass wound over steel. Occult damage taken -20%.',
        cost:2, requires:['c_v12'], pos:{x:62,y:80}, kind:'passive', grant:{passive:{resist:{occult:20}}} },

      /* ---- Steel — physical / defense (18: 9 stat, 2 move, 6 passive, 1 keystone) ---- */
      { id:'c_s1', branch:'steel', name:'Square Stance', desc:'Feet planted like mic stands. +4 def.',
        cost:1, requires:['c_t5'], pos:{x:80,y:28}, kind:'stat', grant:{stat:{def:4}} },
      { id:'c_s2', branch:'steel', name:'Iron String', desc:'Learn Iron String — a taut guard woven from wire and stubbornness.',
        cost:2, requires:['c_t5'], pos:{x:68,y:28}, kind:'move', grant:{move:'iron_string'} },
      { id:'c_s3', branch:'steel', name:'Roadwork', desc:'Haul your own amps, carry your own weight. +8 stamina.',
        cost:1, requires:['c_s1'], pos:{x:92,y:28}, kind:'stat', grant:{stat:{stamina:8}} },
      { id:'c_s4', branch:'steel', name:'Braced Frame', desc:'Take the hit on the forearms. Blocks absorb 15% more.',
        cost:2, requires:['c_s2'], pos:{x:68,y:41}, kind:'passive', grant:{passive:{blockPower:15}} },
      { id:'c_s5', branch:'steel', name:'Thick Skin', desc:'Scarred knuckles, unbothered heart. +10 life.',
        cost:1, requires:['c_s1'], pos:{x:80,y:41}, kind:'stat', grant:{stat:{life:10}} },
      { id:'c_s6', branch:'steel', name:'Follow-Through', desc:'Swing past the target, not at it. +4 atk.',
        cost:1, requires:['c_s3'], pos:{x:92,y:41}, kind:'stat', grant:{stat:{atk:4}} },
      { id:'c_s7', branch:'steel', name:'Guard Tuning', desc:'Angle the body like a bridge saddle. +6 def.',
        cost:1, requires:['c_s4'], pos:{x:68,y:54}, kind:'stat', grant:{stat:{def:6}} },
      { id:'c_s8', branch:'steel', name:'Roadie Lungs', desc:'Load in, load out, never winded. Stamina regen +10%.',
        cost:2, requires:['c_s5'], pos:{x:80,y:54}, kind:'passive', grant:{passive:{staminaRegenPct:10}} },
      { id:'c_s9', branch:'steel', name:'Raw Howl', desc:'Learn Raw Howl — a throat-shredding scream that hits like a body blow.',
        cost:2, requires:['c_s6'], pos:{x:92,y:54}, kind:'move', grant:{move:'raw_howl'} },
      { id:'c_s10', branch:'steel', name:'Scar Tissue', desc:'Old wounds close ranks. Bleed buildup taken -35%.',
        cost:2, requires:['c_s7'], pos:{x:68,y:67}, kind:'passive', grant:{passive:{statusResist:{bleed:35}}} },
      { id:'c_s11', branch:'steel', name:'Won’t Go Down', desc:'The floor is for amps, not for you. +12 life.',
        cost:1, requires:['c_s8'], pos:{x:80,y:67}, kind:'stat', grant:{stat:{life:12}} },
      { id:'c_s12', branch:'steel', name:'Full Swing', desc:'Hips, shoulders, headstock. +6 atk.',
        cost:1, requires:['c_s9'], pos:{x:92,y:67}, kind:'stat', grant:{stat:{atk:6}} },
      { id:'c_s13', branch:'steel', name:'Bell Stance', desc:'Ring, don’t break. +8 def.',
        cost:1, requires:['c_s10'], pos:{x:68,y:80}, kind:'stat', grant:{stat:{def:8}} },
      { id:'c_s14', branch:'steel', name:'Iron Skin', desc:'Fists and pipes glance off. Physical damage taken -15%.',
        cost:2, requires:['c_s11'], pos:{x:80,y:80}, kind:'passive', grant:{passive:{resist:{physical:15}}} },
      { id:'c_s15', branch:'steel', name:'Grounded Boots', desc:'Rubber soles, steady pulse. Shock buildup taken -30%.',
        cost:2, requires:['c_s12'], pos:{x:92,y:80}, kind:'passive', grant:{passive:{statusResist:{shock:30}}} },
      { id:'c_s16', branch:'steel', name:'Marathon Set', desc:'Three encores and still swinging. +12 stamina.',
        cost:1, requires:['c_s13'], pos:{x:68,y:92}, kind:'stat', grant:{stat:{stamina:12}} },
      { id:'c_s17', branch:'steel', name:'IRON ENCORE', desc:'KEYSTONE: blocks absorb 30% more, and once per battle a lethal hit leaves Chloe at 1 life instead of downing her.',
        cost:3, requires:['c_s14'], pos:{x:80,y:92}, kind:'keystone', grant:{passive:{blockPower:30, deathDefianceOnce:true}} },
      { id:'c_s18', branch:'steel', name:'Mosh Recovery', desc:'Walk out of the pit healthier than you went in. Defeating an enemy restores 8% life.',
        cost:2, requires:['c_s15'], pos:{x:92,y:92}, kind:'passive', grant:{passive:{onKillLifePct:8}} }
    ]
  },

  /* ============================================================ ASH */
  ash: {
    name: "Ash — Setlist of the Storm",
    branches: {
      trunk: { name:'Trunk', color:'#8a8f98', blurb:'Shared fundamentals. Quick, quiet, always ready.' },
      storm: { name:'Storm', color:'#6ec6ff', blurb:'Lightning tempo. Shock buildup, speed, spell pressure.' },
      veil:  { name:'Veil',  color:'#b78cff', blurb:'Occult and ghost. Slip the veil, curse what follows.' },
      toxin: { name:'Toxin', color:'#7ddf64', blurb:'Poison, virus, blood. Wounds that keep playing.' }
    },
    nodes: [

      /* ---- trunk (5) ---- */
      { id:'a_t1', branch:'trunk', name:'Backbeat', desc:'Steady under everything. +8 life.',
        cost:1, requires:[], pos:{x:50,y:6}, kind:'stat', grant:{stat:{life:8}} },
      { id:'a_t2', branch:'trunk', name:'Quick Fingers', desc:'Knife or fretboard, same drill. +3 spd.',
        cost:1, requires:['a_t1'], pos:{x:26,y:15}, kind:'stat', grant:{stat:{spd:3}} },
      { id:'a_t3', branch:'trunk', name:'Night Eyes', desc:'Sees what the stage lights hide. +4 mag.',
        cost:1, requires:['a_t1'], pos:{x:42,y:15}, kind:'stat', grant:{stat:{mag:4}} },
      { id:'a_t4', branch:'trunk', name:'Cold Focus', desc:'Panic is for the audience. +8 magic.',
        cost:1, requires:['a_t1'], pos:{x:58,y:15}, kind:'stat', grant:{stat:{magic:8}} },
      { id:'a_t5', branch:'trunk', name:'Wiry Frame', desc:'Light, fast, hard to wear down. +8 stamina.',
        cost:1, requires:['a_t1'], pos:{x:74,y:15}, kind:'stat', grant:{stat:{stamina:8}} },

      /* ---- Storm — lightning (18: 10 stat, 1 move, 6 passive, 1 keystone) ---- */
      { id:'a_st1', branch:'storm', name:'Storm Call', desc:'Learn Storm Call — pull the sky down through the wires. Stacks shock buildup.',
        cost:2, requires:['a_t2'], pos:{x:8,y:28}, kind:'move', grant:{move:'storm_call'} },
      { id:'a_st2', branch:'storm', name:'Downbeat Sprint', desc:'First to move, every time. +3 spd.',
        cost:1, requires:['a_t2'], pos:{x:20,y:28}, kind:'stat', grant:{stat:{spd:3}} },
      { id:'a_st3', branch:'storm', name:'Insulated', desc:'You’ve been bitten by your own gear enough. Shock buildup taken -30%.',
        cost:2, requires:['a_t2'], pos:{x:32,y:28}, kind:'passive', grant:{passive:{statusResist:{shock:30}}} },
      { id:'a_st4', branch:'storm', name:'Live Current', desc:'The hum never quite leaves her hands. +5 mag.',
        cost:1, requires:['a_st1'], pos:{x:8,y:41}, kind:'stat', grant:{stat:{mag:5}} },
      { id:'a_st5', branch:'storm', name:'Storm Cellar Kid', desc:'Grew up counting seconds after the flash. +8 life.',
        cost:1, requires:['a_st2'], pos:{x:20,y:41}, kind:'stat', grant:{stat:{life:8}} },
      { id:'a_st6', branch:'storm', name:'Crosswind Step', desc:'Move like weather. +4 spd.',
        cost:1, requires:['a_st3'], pos:{x:32,y:41}, kind:'stat', grant:{stat:{spd:4}} },
      { id:'a_st7', branch:'storm', name:'Capacitor', desc:'Deeper charge for longer storms. +8 magic.',
        cost:1, requires:['a_st4'], pos:{x:8,y:54}, kind:'stat', grant:{stat:{magic:8}} },
      { id:'a_st8', branch:'storm', name:'Rubber Soles', desc:'Grounded by habit. Lightning damage taken -15%.',
        cost:2, requires:['a_st5'], pos:{x:20,y:54}, kind:'passive', grant:{passive:{resist:{lightning:15}}} },
      { id:'a_st9', branch:'storm', name:'Squall Tempo', desc:'The song speeds up when the rain starts. +5 spd.',
        cost:1, requires:['a_st6'], pos:{x:32,y:54}, kind:'stat', grant:{stat:{spd:5}} },
      { id:'a_st10', branch:'storm', name:'Charged Air', desc:'Static crawls ahead of the strike. +6 mag.',
        cost:1, requires:['a_st7'], pos:{x:8,y:67}, kind:'stat', grant:{stat:{mag:6}} },
      { id:'a_st11', branch:'storm', name:'Eye of the Storm', desc:'Calm in the middle of it. +10 life.',
        cost:1, requires:['a_st8'], pos:{x:20,y:67}, kind:'stat', grant:{stat:{life:10}} },
      { id:'a_st12', branch:'storm', name:'Static Charge', desc:'The crackle keeps her moving. Stamina regen +10%.',
        cost:2, requires:['a_st9'], pos:{x:32,y:67}, kind:'passive', grant:{passive:{staminaRegenPct:10}} },
      { id:'a_st13', branch:'storm', name:'Thunder Thief', desc:'Steal the storm’s last breath. Defeating an enemy restores 10% life.',
        cost:2, requires:['a_st10'], pos:{x:8,y:80}, kind:'passive', grant:{passive:{onKillLifePct:10}} },
      { id:'a_st14', branch:'storm', name:'Forked Strike', desc:'Twice the arc, twice the ache. +8 mag.',
        cost:1, requires:['a_st11'], pos:{x:20,y:80}, kind:'stat', grant:{stat:{mag:8}} },
      { id:'a_st15', branch:'storm', name:'Tailwind', desc:'Nothing catches her now. +6 spd.',
        cost:1, requires:['a_st12'], pos:{x:32,y:80}, kind:'stat', grant:{stat:{spd:6}} },
      { id:'a_st16', branch:'storm', name:'White Noise', desc:'Her static drowns their spellwork. Magical damage taken -15%.',
        cost:2, requires:['a_st13'], pos:{x:8,y:92}, kind:'passive', grant:{passive:{resist:{magical:15}}} },
      { id:'a_st17', branch:'storm', name:'TEMPEST CADENCE', desc:'KEYSTONE: Ash’s lightning moves inflict +50% shock buildup, and she gains +10% speed.',
        cost:3, requires:['a_st14'], pos:{x:20,y:92}, kind:'keystone', grant:{passive:{shockBuildupPct:50, spdPct:10}} },
      { id:'a_st18', branch:'storm', name:'Lightning Rod', desc:'Take the hit so the sky owes you one. Lightning damage taken -20%.',
        cost:2, requires:['a_st15'], pos:{x:32,y:92}, kind:'passive', grant:{passive:{resist:{lightning:20}}} },

      /* ---- Veil — occult / ghost (19: 9 stat, 3 move, 6 passive, 1 keystone) ---- */
      { id:'a_ve1', branch:'veil', name:'Veil Walk', desc:'Learn Veil Walk — step halfway out of the world, into a charged stance.',
        cost:2, requires:['a_t3','a_t4'], pos:{x:44,y:28}, kind:'move', grant:{move:'veil_walk'} },
      { id:'a_ve2', branch:'veil', name:'Thin Places', desc:'She always knew where the cold spots were. +4 mag.',
        cost:1, requires:['a_t3','a_t4'], pos:{x:56,y:28}, kind:'stat', grant:{stat:{mag:4}} },
      { id:'a_ve3', branch:'veil', name:'Soft Footfalls', desc:'The dead never hear her coming either. +4 spd.',
        cost:1, requires:['a_ve1'], pos:{x:38,y:41}, kind:'stat', grant:{stat:{spd:4}} },
      { id:'a_ve4', branch:'veil', name:'Grave Manners', desc:'Respect the dead; they respect you back. Haunt buildup taken -35%.',
        cost:2, requires:['a_ve1','a_ve2'], pos:{x:50,y:41}, kind:'passive', grant:{passive:{statusResist:{haunt:35}}} },
      { id:'a_ve5', branch:'veil', name:'Séance Reserves', desc:'Deeper wells on the other side. +8 magic.',
        cost:1, requires:['a_ve2'], pos:{x:62,y:41}, kind:'stat', grant:{stat:{magic:8}} },
      { id:'a_ve6', branch:'veil', name:'Grave Echo', desc:'Learn Grave Echo — a note that comes back wrong, and cold.',
        cost:2, requires:['a_ve3'], pos:{x:38,y:54}, kind:'move', grant:{move:'grave_echo'} },
      { id:'a_ve7', branch:'veil', name:'Witch Pulse', desc:'Blood remembers older songs. +6 mag.',
        cost:1, requires:['a_ve4'], pos:{x:46,y:54}, kind:'stat', grant:{stat:{mag:6}} },
      { id:'a_ve8', branch:'veil', name:'Thin Silhouette', desc:'Less of her to grab. Ghost damage taken -15%.',
        cost:2, requires:['a_ve4'], pos:{x:54,y:54}, kind:'passive', grant:{passive:{resist:{ghost:15}}} },
      { id:'a_ve9', branch:'veil', name:'Cold Comfort', desc:'The chill stopped bothering her years ago. +8 life.',
        cost:1, requires:['a_ve5'], pos:{x:62,y:54}, kind:'stat', grant:{stat:{life:8}} },
      { id:'a_ve10', branch:'veil', name:'Between Frames', desc:'She moves in the blink. +5 spd.',
        cost:1, requires:['a_ve6'], pos:{x:40,y:67}, kind:'stat', grant:{stat:{spd:5}} },
      { id:'a_ve11', branch:'veil', name:'Hex Needle', desc:'Learn Hex Needle — one stitched curse, sharp end first. Stacks curse buildup.',
        cost:2, requires:['a_ve7','a_ve8'], pos:{x:50,y:67}, kind:'move', grant:{move:'hex_needle'} },
      { id:'a_ve12', branch:'veil', name:'Salt Thread', desc:'A warding line sewn into every hem. Occult damage taken -15%.',
        cost:2, requires:['a_ve9'], pos:{x:60,y:67}, kind:'passive', grant:{passive:{resist:{occult:15}}} },
      { id:'a_ve13', branch:'veil', name:'Other Side Fluent', desc:'She stopped translating a while ago. +8 mag.',
        cost:1, requires:['a_ve10'], pos:{x:38,y:80}, kind:'stat', grant:{stat:{mag:8}} },
      { id:'a_ve14', branch:'veil', name:'Hexproof Ink', desc:'Countersigns tattooed where curses land. Curse buildup taken -40%.',
        cost:2, requires:['a_ve11'], pos:{x:46,y:80}, kind:'passive', grant:{passive:{statusResist:{curse:40}}} },
      { id:'a_ve15', branch:'veil', name:'Grave Strength', desc:'Whatever holds her together, it holds. +10 life.',
        cost:1, requires:['a_ve11'], pos:{x:54,y:80}, kind:'stat', grant:{stat:{life:10}} },
      { id:'a_ve16', branch:'veil', name:'Half There', desc:'Hands pass through where she just was. Ghost damage taken -20%.',
        cost:2, requires:['a_ve12'], pos:{x:62,y:80}, kind:'passive', grant:{passive:{resist:{ghost:20}}} },
      { id:'a_ve17', branch:'veil', name:'Midnight Reservoir', desc:'The dark keeps its own supply. +10 magic.',
        cost:1, requires:['a_ve13'], pos:{x:40,y:92}, kind:'stat', grant:{stat:{magic:10}} },
      { id:'a_ve18', branch:'veil', name:'GHOSTLIGHT', desc:'KEYSTONE: while in the charged stance Ash dodges 20% of incoming attacks, and her ghost and occult moves deal +20% damage.',
        cost:3, requires:['a_ve14','a_ve15'], pos:{x:50,y:92}, kind:'keystone', grant:{passive:{chargedDodgePct:20, ghostOccultDamagePct:20}} },
      { id:'a_ve19', branch:'veil', name:'Untouchable', desc:'Mostly rumor at this point. Physical damage taken -10%.',
        cost:2, requires:['a_ve16'], pos:{x:60,y:92}, kind:'passive', grant:{passive:{resist:{physical:10}}} },

      /* ---- Toxin — poison / virus / blood (18: 9 stat, 3 move, 5 passive, 1 keystone) ---- */
      { id:'a_tx1', branch:'toxin', name:'Toxin Kiss', desc:'Learn Toxin Kiss — a blown kiss with a body count. Stacks poison buildup.',
        cost:2, requires:['a_t5'], pos:{x:68,y:28}, kind:'move', grant:{move:'toxin_kiss'} },
      { id:'a_tx2', branch:'toxin', name:'Sharpened Edge', desc:'She whets the blade during soundcheck. +4 atk.',
        cost:1, requires:['a_t5'], pos:{x:80,y:28}, kind:'stat', grant:{stat:{atk:4}} },
      { id:'a_tx3', branch:'toxin', name:'Gutter Stamina', desc:'Outlast anything the city throws. +8 stamina.',
        cost:1, requires:['a_t5'], pos:{x:92,y:28}, kind:'stat', grant:{stat:{stamina:8}} },
      { id:'a_tx4', branch:'toxin', name:'Blood Tithe', desc:'Learn Blood Tithe — a cut that pays her back. Lifesteal, stacks bleed buildup.',
        cost:2, requires:['a_tx1'], pos:{x:68,y:41}, kind:'move', grant:{move:'blood_tithe'} },
      { id:'a_tx5', branch:'toxin', name:'Iron Stomach', desc:'Gas-station sushi was the real training arc. Poison buildup taken -35%.',
        cost:2, requires:['a_tx2'], pos:{x:80,y:41}, kind:'passive', grant:{passive:{statusResist:{poisoned:35}}} },
      { id:'a_tx6', branch:'toxin', name:'Scar Ledger', desc:'Every mark accounted for. +8 life.',
        cost:1, requires:['a_tx3'], pos:{x:92,y:41}, kind:'stat', grant:{stat:{life:8}} },
      { id:'a_tx7', branch:'toxin', name:'Vein Work', desc:'She knows exactly where to cut. +5 atk.',
        cost:1, requires:['a_tx4'], pos:{x:68,y:54}, kind:'stat', grant:{stat:{atk:5}} },
      { id:'a_tx8', branch:'toxin', name:'Fever Logic', desc:'Sickness sharpens strange senses. +5 mag.',
        cost:1, requires:['a_tx5'], pos:{x:80,y:54}, kind:'stat', grant:{stat:{mag:5}} },
      { id:'a_tx9', branch:'toxin', name:'Thick Blood', desc:'It clots around the poison and keeps time. Poison damage taken -15%.',
        cost:2, requires:['a_tx6'], pos:{x:92,y:54}, kind:'passive', grant:{passive:{resist:{poison:15}}} },
      { id:'a_tx10', branch:'toxin', name:'Sealed Veins', desc:'She doesn’t spill easy. Bleed buildup taken -35%.',
        cost:2, requires:['a_tx7'], pos:{x:68,y:67}, kind:'passive', grant:{passive:{statusResist:{bleed:35}}} },
      { id:'a_tx11', branch:'toxin', name:'Plague String', desc:'Learn Plague String — a filthy tremolo that gets under the skin. Stacks infection buildup.',
        cost:2, requires:['a_tx8'], pos:{x:80,y:67}, kind:'move', grant:{move:'plague_string'} },
      { id:'a_tx12', branch:'toxin', name:'Survivor’s Pulse', desc:'Whatever it was, she got over it. +10 life.',
        cost:1, requires:['a_tx9'], pos:{x:92,y:67}, kind:'stat', grant:{stat:{life:10}} },
      { id:'a_tx13', branch:'toxin', name:'Butcher’s Tempo', desc:'Cuts on the downbeat. +6 atk.',
        cost:1, requires:['a_tx10'], pos:{x:68,y:80}, kind:'stat', grant:{stat:{atk:6}} },
      { id:'a_tx14', branch:'toxin', name:'Leech Rhythm', desc:'Endings feed her. Defeating an enemy restores 12% life.',
        cost:2, requires:['a_tx11'], pos:{x:80,y:80}, kind:'passive', grant:{passive:{onKillLifePct:12}} },
      { id:'a_tx15', branch:'toxin', name:'Long Haul', desc:'Set after set after set. +10 stamina.',
        cost:1, requires:['a_tx12'], pos:{x:92,y:80}, kind:'stat', grant:{stat:{stamina:10}} },
      { id:'a_tx16', branch:'toxin', name:'Red Right Hand', desc:'The knife hand never shakes. +8 atk.',
        cost:1, requires:['a_tx13'], pos:{x:68,y:92}, kind:'stat', grant:{stat:{atk:8}} },
      { id:'a_tx17', branch:'toxin', name:'PATIENT ZERO', desc:'KEYSTONE: damage-over-time from statuses Ash inflicts ticks 50% harder, and enemies suffering any active status take +10% damage from her.',
        cost:3, requires:['a_tx14'], pos:{x:80,y:92}, kind:'keystone', grant:{passive:{dotDamagePct:50, vsStatusedDamagePct:10}} },
      { id:'a_tx18', branch:'toxin', name:'Antibody Choir', desc:'Her blood sings back at what invades it. Virus damage taken -20%.',
        cost:2, requires:['a_tx15'], pos:{x:92,y:92}, kind:'passive', grant:{passive:{resist:{virus:20}}} }
    ]
  }
};

/* Dev guard: warn (never throw) if a move node references a move id missing
   from data/moves.js, or a requires id that is not in the same tree. */
(function(){
  try{
    var moves = CHLOE.data.moves || null;
    Object.keys(CHLOE.data.trees).forEach(function(cid){
      var tree = CHLOE.data.trees[cid], ids = {};
      tree.nodes.forEach(function(n){ ids[n.id] = true; });
      tree.nodes.forEach(function(n){
        if(n.kind==='move' && moves && n.grant.move && !moves[n.grant.move])
          console.warn('[CHLOE tree] '+cid+' node '+n.id+' grants unknown move id: '+n.grant.move);
        (n.requires||[]).forEach(function(r){
          if(!ids[r]) console.warn('[CHLOE tree] '+cid+' node '+n.id+' requires unknown node: '+r);
        });
      });
    });
  }catch(e){ /* never block load */ }
})();
