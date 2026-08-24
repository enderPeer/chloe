/* CHLOE — data/items.js — usable in & out of battle
   effect conventions:
     { hp:n }         -> restore n life
     { mp:n }         -> restore n magic
     { revivePct:n }  -> revive fallen ally at n% life
     { cure:[...] }   -> clear the listed §12 statuses (and their buildup meters)
*/
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.items = {
  bandage: {
    id: 'bandage', name: 'Bandage', effect: { hp: 30 }, price: 15, icon: '🩹',
    desc: 'Backstage first aid. Restores 30 HP.'
  },
  energy_drink: {
    id: 'energy_drink', name: 'Energy Drink', effect: { mp: 20 }, price: 20, icon: '🥤',
    desc: 'Tastes like neon. Restores 20 MP.'
  },
  adrenaline_shot: {
    id: 'adrenaline_shot', name: 'Adrenaline Shot', effect: { revivePct: 50 }, price: 60, icon: '💉',
    desc: 'Brings a fallen bandmate back at 50% HP.'
  },
  /* antidote + tourniquet are SHOP-RESERVED for a future vendor: no drop table
     or pickup grants them yet, and no current enemy inflicts the statuses they
     cure. (sage_smoke IS obtainable — the_hollow drops it; shade_touch curses.) */
  antidote: {
    id: 'antidote', name: 'Antidote', effect: { cure: ['poisoned', 'infection'] }, price: 25, icon: '🧪',
    desc: 'Bitter as a bad review. Cures poison and infection.'
  },
  tourniquet: {
    id: 'tourniquet', name: 'Tourniquet', effect: { cure: ['bleed', 'burn'] }, price: 25, icon: '🩸',
    desc: 'A guitar strap pulled tight. Stops bleeding and cools burns.'
  },
  sage_smoke: {
    id: 'sage_smoke', name: 'Sage Smoke', effect: { cure: ['curse', 'haunt', 'shock'] }, price: 40, icon: '🕯️',
    desc: 'Smells like every backstage superstition. Lifts curses, hauntings, and shocks.'
  }
};
