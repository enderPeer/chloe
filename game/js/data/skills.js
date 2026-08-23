/* CHLOE — data/skills.js
   power = % of atk (or mag when usesMag) fed into the damage/heal formula. */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.skills = {
  /* ---- party skills ---- */
  strike: {
    id: 'strike', name: 'Strike', element: 'none', kind: 'attack',
    power: 100, usesMag: false, mpCost: 0, target: 'enemy',
    desc: 'A no-frills hit. Costs nothing but pride.'
  },
  power_chord: {
    id: 'power_chord', name: 'Power Chord', element: 'ember', kind: 'attack',
    power: 155, usesMag: true, mpCost: 5, target: 'enemy',
    desc: 'Chloe rakes the Crimson Fret — the riff ignites mid-air.'
  },
  anthem_heal: {
    id: 'anthem_heal', name: 'Anthem', element: 'light', kind: 'heal',
    power: 140, usesMag: true, mpCost: 7, target: 'ally',
    desc: 'A chorus that remembers you whole. Restores HP.'
  },
  feedback_scream: {
    id: 'feedback_scream', name: 'Feedback Scream', element: 'ember', kind: 'attack',
    power: 230, usesMag: true, mpCost: 12, target: 'enemy',
    desc: 'Amp to eleven. The wall of sound catches fire.'
  },
  livewire_stab: {
    id: 'livewire_stab', name: 'Livewire Stab', element: 'volt', kind: 'attack',
    power: 160, usesMag: false, mpCost: 5, target: 'enemy',
    desc: 'Ash slips inside their guard — the blade bites, current follows.'
  },
  blackout: {
    id: 'blackout', name: 'Blackout', element: 'shadow', kind: 'attack',
    power: 210, usesMag: true, mpCost: 10, target: 'enemy',
    desc: 'Ash kills the lights inside their head.'
  },

  /* ---- enemy skills ---- */
  shade_touch: {
    id: 'shade_touch', name: 'Shade Touch', element: 'shadow', kind: 'attack',
    power: 95, usesMag: true, mpCost: 2, target: 'enemy',
    desc: 'Cold fingers through the chest.'
  },
  static_jolt: {
    id: 'static_jolt', name: 'Static Jolt', element: 'volt', kind: 'attack',
    power: 115, usesMag: true, mpCost: 3, target: 'enemy',
    desc: 'A crackling arc off dead speakers.'
  },
  frost_gaze: {
    id: 'frost_gaze', name: 'Frost Gaze', element: 'frost', kind: 'attack',
    power: 125, usesMag: true, mpCost: 4, target: 'enemy',
    desc: 'A mirrored stare that stops the blood.'
  },
  spotlight_drain: {
    id: 'spotlight_drain', name: 'Spotlight Drain', element: 'shadow', kind: 'attack',
    power: 150, usesMag: true, mpCost: 6, target: 'enemy',
    desc: 'The Promoter takes your moment — and your pulse with it.'
  }
};
