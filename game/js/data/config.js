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
  itemCooldownMs: 2500
};
