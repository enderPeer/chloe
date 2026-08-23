/* CHLOE — data/characters.js
   Portraits are STORY-agent data (data/portraits.js) and are resolved at USE time
   via CHLOE.ui.portraitSrc(key) — never dereferenced at load time. */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.characters = {
  chloe: {
    id: 'chloe',
    name: 'Chloe',
    element: 'ember',
    portraitKey: 'chloe',            // -> CHLOE.data.portraits.chloe (resolved at use, not load)
    weaponId: 'crimson_fret',
    base:   { hp: 62, mp: 20, atk: 12, def: 8, spd: 9,  mag: 11 },
    growth: { hp: 8,  mp: 3,  atk: 2,  def: 2, spd: 1,  mag: 2 },
    skillsByLevel: {
      1: ['strike'],
      2: ['power_chord'],
      3: ['anthem_heal'],
      5: ['feedback_scream']
    },
    desc: 'Street musician. Razor guitar, sharper temper. Ember burns in every chord.'
  },
  ash: {
    id: 'ash',
    name: 'Ash',
    element: 'volt',
    portraitKey: 'ash',              // -> CHLOE.data.portraits.ash (resolved at use, not load)
    weaponId: 'livewire',
    base:   { hp: 54, mp: 24, atk: 11, def: 7, spd: 12, mag: 12 },
    growth: { hp: 7,  mp: 4,  atk: 2,  def: 1, spd: 2,  mag: 2 },
    skillsByLevel: {
      1: ['strike'],
      2: ['livewire_stab'],
      4: ['blackout']
    },
    desc: "Chloe's sister and bandmate. Quick hands, quicker blade. Volt runs in her veins."
  }
};
