/* CHLOE — data/config.js */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.config = {
  version: 2,
  // Gameplay tuning (roguelike mode, spec sec 15: no accounts, no saves)
  levelCap: 100,
  fleeChance: 0.7,
  typewriterMs: 16,

  /* ---- Pockets (spec sec 23): consumables live on the hotbar --------------
     Abilities and their keys arrive TOGETHER on the ladder (sec 19), so every
     key a character owns is already spoken for — binding a bandage would mean
     giving up a move. So the hotbar GAINS room instead of taking it: these two
     extra keys exist from level 1 and are generic, exactly like the granted
     ones. Any slot may hold an ability OR a consumable; the pockets simply
     mean nothing has to be sacrificed to carry one.
     The total cap is still 9 (abilities.abilityConfig.maxSlots) — pockets push
     you toward it, they do not raise it. */
  pocketSlots: 2,

  /* How long pressing a consumable locks you out of casting. Short, but REAL:
     you can be hit while you bandage, and that is the whole price of the
     feature — without it a bandage is a free reset in the middle of his swing. */
  itemUseMs: 350,

  /* SHARED across every consumable key, so three bandages cannot go down in a
     second. It is a property of the hands, not of the item, which is why it is
     one timer rather than a per-item cooldown. */
  itemCooldownMs: 2500,

  /* ---- Mouse binds (spec sec 27B) ----------------------------------------
     LMB and RMB join the number keys as bind targets, so the hotbar is 9 keys
     + 2 buttons = 11 slots, any of which may hold an ability OR an item.

     THE IDS ARE STRINGS, AND THAT IS THE POINT. Encoding the buttons as slot
     9 and 10 would put them in the same numeric space as the keys, where one
     off-by-one silently fires the wrong ability instead of failing loudly.
     'mouseL'/'mouseR' cannot be added to, indexed past, or confused with a key
     number, so a caller that gets it wrong gets nothing rather than gets it
     wrong. Order here is the order the HUD draws them.

     The two buttons are NOT counted against abilities.abilityConfig.maxSlots:
     that cap is about how many NUMBER KEYS the ladder may hand out (see the
     keyCap arithmetic in data/skilltree.js, which subtracts pocketSlots from
     it), and the mouse was never one of them. They are addressed by id and
     live outside the numeric array entirely, so the cap logic is untouched. */
  mouseSlots: ['mouseL', 'mouseR'],

  /* What the buttons are labelled on the hotbar and the bind screen. Never
     "10" and "11" — a number there would be a lie about how you press it. */
  mouseSlotLabels: { mouseL: 'LMB', mouseR: 'RMB' },

  /* ---- Passive revive (spec sec 27C) -------------------------------------
     The breath you get after a revive potion picks you up. Deliberately the
     same 900ms the leader swap already grants (see combat3.takeHit): standing
     back up inside the same swing that just killed you, only to be killed by
     its next hit window, would spend the most expensive item in the game on
     nothing. It is a grace, not a reset — he is still standing over you. */
  reviveIframeMs: 900
};
