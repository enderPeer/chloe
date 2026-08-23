/* CHLOE — data/characters.js  (Combat v2 + Progression v3, spec §10/§12)
   Portraits are STORY-agent data (data/portraits.js) and are resolved at USE time
   via CHLOE.ui.portraitSrc(key) — never dereferenced at load time.
   learnset replaces skillsByLevel (v1). defaultLoadouts: per-phase <=5 move ids,
   all valid vs usableIn AND the level-1 learnset, so a fresh save works untouched.
   v3 resources (spec §12): life (was hp), stamina (physical resource, regen 20%/turn),
   magic (was mp), faith (starts battles at 3, +1/turn; growth is fractional — FLOOR
   at use: Math.floor(base + growth*(level-1))). `type` is the v3 damage type;
   `element` is kept as the old-name back-compat alias (ember->fire, volt->lightning).
   resists:{} is intentionally empty at base — the skill tree provides resists. */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.characters = {
  chloe: {
    id: 'chloe',
    name: 'Chloe',
    type: 'fire',
    element: 'ember',                // back-compat alias for the v3 `type` (ember->fire)
    portraitKey: 'chloe',            // -> CHLOE.data.portraits.chloe (resolved at use, not load)
    weaponId: 'crimson_fret',
    base:   { life: 62, stamina: 40, magic: 20, faith: 3,   atk: 12, def: 8, spd: 9,  mag: 11 },
    growth: { life: 8,  stamina: 3,  magic: 3,  faith: 0.2, atk: 2,  def: 2, spd: 1,  mag: 2 },
    resists: {},                     // empty base — tree passives grant type resists
    learnset: {
      1:  ['dead_string', 'power_chord', 'fade_step', 'stage_presence', 'second_wind'],
      2:  ['feedback_wall', 'crescendo'],
      3:  ['limelight'],
      4:  ['flare_riff'],
      5:  ['anthem'],
      6:  ['encore'],
      7:  ['burn_out'],
      8:  ['pyre_solo'],
      10: ['halo_reprise']
    },
    defaultLoadouts: {
      neutral:    ['power_chord', 'dead_string', 'stage_presence', 'second_wind', 'fade_step'],
      aggressive: ['power_chord', 'dead_string'],
      guarded:    ['dead_string', 'fade_step', 'stage_presence', 'second_wind'],
      staggered:  ['dead_string', 'fade_step', 'second_wind'],
      charged:    ['power_chord', 'dead_string']
    },
    desc: 'Street musician. Razor guitar, sharper temper. Fire burns in every chord.'
  },
  ash: {
    id: 'ash',
    name: 'Ash',
    type: 'lightning',
    element: 'volt',                 // back-compat alias for the v3 `type` (volt->lightning)
    portraitKey: 'ash',              // -> CHLOE.data.portraits.ash (resolved at use, not load)
    weaponId: 'livewire',
    base:   { life: 54, stamina: 40, magic: 24, faith: 3,   atk: 11, def: 7, spd: 12, mag: 12 },
    growth: { life: 7,  stamina: 3,  magic: 4,  faith: 0.2, atk: 2,  def: 1, spd: 2,  mag: 2 },
    resists: {},                     // empty base — tree passives grant type resists
    learnset: {
      1:  ['dead_string', 'livewire_stab', 'fade_step', 'stage_presence', 'second_wind'],
      2:  ['static_veil', 'knife_dance'],
      3:  ['blackout'],
      4:  ['short_circuit'],
      5:  ['static_cling'],
      6:  ['arc_flash'],
      7:  ['shadow_slip'],
      8:  ['blade_rain'],
      10: ['null_signal']
    },
    defaultLoadouts: {
      neutral:    ['livewire_stab', 'dead_string', 'stage_presence', 'second_wind', 'fade_step'],
      aggressive: ['livewire_stab', 'dead_string'],
      guarded:    ['dead_string', 'fade_step', 'stage_presence', 'second_wind'],
      staggered:  ['dead_string', 'fade_step', 'second_wind'],
      charged:    ['livewire_stab', 'dead_string']
    },
    desc: "Chloe's sister and bandmate. Quick hands, quicker blade. Lightning runs in her veins."
  }
};
