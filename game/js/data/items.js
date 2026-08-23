/* CHLOE — data/items.js — usable in & out of battle */
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
  }
};
