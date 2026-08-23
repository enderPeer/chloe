# CHLOE Type Chart (Progression v3)

Source of truth for `CHLOE.data.types` in `game/js/data/elements.js`. 11 damage types,
default multiplier **1.0**; only 2.0 (super effective) and 0.5 (resisted) are charted.
`types.multiplier(atkType, defender)` reads this chart, then an enemy's optional
`resists:{type:mult}` entry overrides the chart value.

Old v1/v2 element names are migrated everywhere (inside `multiplier` too):
`none→physical, ember→fire, volt→lightning, shadow→occult, light→divine, frost→magical`.

## The chart

Rows = **attacker**, columns = **defender**. `2` = 2.0x, `½` = 0.5x, `·` = 1.0x.

| atk \ def      | PHY | MAG | LIT | FIR | OCC | BLD | PSN | DIV | VIR | GHO | BIO |
|----------------|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|
| **physical**   |  ·  |  ½  |  2  |  ·  |  2  |  ½  |  ·  |  ·  |  ·  |  ½  |  ·  |
| **magical**    |  2  |  ·  |  ·  |  ·  |  ·  |  ·  |  ·  |  ½  |  ½  |  2  |  ·  |
| **lightning**  |  2  |  ·  |  ·  |  ·  |  ½  |  2  |  ·  |  ½  |  ·  |  ·  |  ·  |
| **fire**       |  ·  |  ·  |  ·  |  ·  |  ½  |  ½  |  2  |  ·  |  2  |  ·  |  2  |
| **occult**     |  ·  |  2  |  ·  |  ·  |  ·  |  ·  |  ·  |  2  |  ½  |  ·  |  ½  |
| **blood**      |  ½  |  ·  |  ·  |  2  |  ·  |  ·  |  ·  |  2  |  2  |  ½  |  ·  |
| **poison**     |  ½  |  ·  |  ·  |  ·  |  ·  |  2  |  ·  |  ·  |  ·  |  ½  |  2  |
| **divine**     |  ½  |  ·  |  ·  |  ·  |  2  |  ·  |  ·  |  ·  |  2  |  2  |  ½  |
| **virus**      |  ½  |  ·  |  ·  |  ½  |  ·  |  2  |  ·  |  ½  |  ·  |  ·  |  2  |
| **ghost**      |  2  |  ·  |  ·  |  ·  |  ½  |  ·  |  ·  |  ½  |  ·  |  2  |  ·  |
| **biological** |  ½  |  ·  |  ·  |  ·  |  ·  |  ·  |  2  |  ·  |  ·  |  ½  |  2  |

## Rationale (one line per type)

| Type | Theme |
|------|-------|
| **physical** | Steel and muscle — a grounded blade earths the storm-born and cold iron breaks old pacts, but wards, tides and spirits don't care about blades. |
| **magical** | Clean arcana — ignores armor and is one of the two things that can bind the dead; it shatters on holy wards and can't target a mindless plague. |
| **lightning** | The neon grid's current — loves steel and arcs through living veins; the old dark grounds the charge and heaven owns the storm. |
| **fire** | Flame sterilizes everything that crawls, seeps or spreads; the wet tide smothers it and the old dark drinks its light. |
| **occult** | Forbidden rites — unravel textbook spellwork and crack halos; useless on a soulless plague or a simple beast with no name to curse. |
| **blood** | The living tide — drowns flame, defiles the sacred, and carries antibodies against the plague; there's nothing to bleed in steel or spirits. |
| **poison** | Venom taints the vein and ruins flesh; steel doesn't sicken and the dead are past poisoning. |
| **divine** | Judgment aimed squarely at the unholy — hexes, plague and haunts burn; it passes gently through plain matter and mortal flesh. |
| **virus** | Contagion rides the bloodstream and devours the living; it can't infect steel, dies in flame, and dies on holy ground. |
| **ghost** | Spectral hands pass straight through armor, and only the dead can truly touch the dead; the coven that binds haunts fears none, and the holy cannot be haunted. |
| **biological** | Tooth and claw — evolved to eat the venomous and each other; claws can't rend steel or rake a spirit. |

## Design notes

- **Anchors (spec sec 12, all honored):** occult↔divine mutual 2.0; ghost resists
  physical/blood/poison (0.5) and takes 2.0 from divine and magical; biological takes
  2.0 from fire/poison/virus; virus takes 2.0 from fire/divine.
- **Row balance:** every type has 2–3 offensive strengths (cap is 4; fire, blood and
  divine sit at 3) and 2–3 offensive weaknesses.
- **Mutual wars:** occult↔divine (the old dark vs. the light) and blood↔virus
  (antibodies vs. bloodborne contagion) both hit each other at 2.0.
- **Aggressive diagonals:** ghost→ghost and biological→biological are 2.0 — the dead
  touch the dead, and nature is red in tooth and claw. All other mirror matches are 1.0.
- **Defensive identities that fall out of the chart:** ghost shrugs everything bodily
  (physical/blood/poison/biological) and falls only to magical/divine — the first
  fight vs. `the_hollow` (ghost) teaches this; occult tanks the mortal elements
  (fire/lightning) but is cracked by faith and cold iron; divine resists mortal
  spellcraft, storms and plague but is defiled by the profane pair (occult, blood).
- **Statuses tied to types** (`types.STATUS_OF_TYPE`): fire→burn, lightning→shock,
  blood→bleed, poison→poisoned, occult→curse, virus→infection, ghost→haunt
  (physical, magical, divine and biological carry no status).
