window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};
// scenes.js — STORY agent. Act 1: "The Red Room / Backstage Between".
// All bg images verified against tools/catalog/*.json. Coords are percent (0-100) of the image box.
//
// Act 1 flow:
//   stage -> club_floor -> corridor_a (first Neon Wisp, once -> firstWispDown)
//   corridor_loop loops back to corridor_a until firstWispDown, then opens corridor_b
//   corridor_b: Static Ghoul (once -> ghoulSilenced) -> backstage_between
//   backstage_between -> mirror_hall gated by ghoulSilenced; Mirror Shade there (once -> shadeShattered)
//   corridor_b's VIP door gated by shadeShattered -> vip_room -> The Promoter (boss, once -> promoterDown)
//   Side areas: bar, dressing_room (heal couch), alley (bandage pickup), between_depths (grinding)
//
// Flags used here are documented in story.js (CHLOE.data.story.flags).

CHLOE.data.scenes = {

  stage: {
    id: 'stage',
    name: 'The Red Room — Stage',
    bg: 'assets/chloe/Chloe041.jpg',
    intro: 'Last chord still ringing. The spotlight hums. Past it, the club is darker than it should be.',
    hotspots: [
      { x: 6, y: 30, w: 16, h: 40, label: 'The mic stand',
        action: { type: 'dialog', dialogId: 'dlg_stage_mic' } },
      { x: 72, y: 45, w: 20, h: 30, label: 'Dead amplifier',
        action: { type: 'dialog', dialogId: 'dlg_stage_amp' } },
      { x: 40, y: 62, w: 22, h: 32, label: 'Down to the floor',
        action: { type: 'goto', scene: 'club_floor' } },
      { x: 84, y: 10, w: 14, h: 45, label: 'Dressing room',
        action: { type: 'goto', scene: 'dressing_room' } }
    ]
  },

  club_floor: {
    id: 'club_floor',
    name: 'The Red Room — Main Floor',
    bg: 'assets/chloe/Chloe063.jpg',
    intro: 'The floor was packed an hour ago. Now there are drinks on every table and nobody holding them.',
    hotspots: [
      { x: 30, y: 40, w: 18, h: 30, label: 'Empty tables',
        action: { type: 'dialog', dialogId: 'dlg_floor_crowd' } },
      { x: 62, y: 25, w: 16, h: 28, label: 'Tonight\'s poster',
        action: { type: 'dialog', dialogId: 'dlg_floor_poster' } },
      { x: 4, y: 30, w: 14, h: 45, label: 'Back to the stage',
        action: { type: 'goto', scene: 'stage' } },
      { x: 80, y: 35, w: 16, h: 40, label: 'The bar',
        action: { type: 'goto', scene: 'bar' } },
      { x: 42, y: 5, w: 20, h: 26, label: 'Red corridor',
        action: { type: 'goto', scene: 'corridor_a' } }
    ]
  },

  bar: {
    id: 'bar',
    name: 'The Red Room — Bar',
    bg: 'assets/chloe/Chloe083.jpg',
    intro: 'Marek\'s bar. Bottles lined up like a choir. No Marek.',
    hotspots: [
      { x: 20, y: 42, w: 20, h: 28, label: 'Half-finished drinks',
        action: { type: 'dialog', dialogId: 'dlg_bar_glasses' } },
      { x: 55, y: 30, w: 18, h: 26, label: 'The tab book',
        action: { type: 'dialog', dialogId: 'dlg_bar_tab' } },
      { x: 2, y: 35, w: 14, h: 45, label: 'Back to the floor',
        action: { type: 'goto', scene: 'club_floor' } },
      { x: 82, y: 25, w: 16, h: 50, label: 'Back door — alley',
        action: { type: 'goto', scene: 'alley' } }
    ]
  },

  dressing_room: {
    id: 'dressing_room',
    name: 'Dressing Room',
    bg: 'assets/chloe/Chloe015.jpg',
    intro: 'Their dressing room. Smells like hairspray, solder and old smoke. The one safe square meter in the building.',
    hotspots: [
      { x: 8, y: 25, w: 18, h: 40, label: 'The mirror',
        action: { type: 'dialog', dialogId: 'dlg_dress_mirror' } },
      { x: 70, y: 20, w: 20, h: 30, label: 'Ash\'s jacket',
        action: { type: 'dialog', dialogId: 'dlg_dress_jacket' } },
      { x: 34, y: 60, w: 30, h: 30, label: 'The couch — rest',
        action: { type: 'heal' } },
      { x: 2, y: 5, w: 14, h: 40, label: 'Back to the stage',
        action: { type: 'goto', scene: 'stage' } }
    ]
  },

  alley: {
    id: 'alley',
    name: 'Alley Behind The Red Room',
    bg: 'assets/chloe/Chloe089.jpg',
    intro: 'The alley. Rain that never quite lands. The street at the end of it looks... painted on.',
    hotspots: [
      { x: 8, y: 20, w: 16, h: 40, label: 'Stage door',
        action: { type: 'dialog', dialogId: 'dlg_alley_door' } },
      { x: 62, y: 8, w: 24, h: 26, label: 'The sky',
        action: { type: 'dialog', dialogId: 'dlg_alley_rain' } },
      { x: 40, y: 72, w: 16, h: 20, label: 'First-aid kit',
        action: { type: 'pickup', itemId: 'bandage', once: true, setsFlag: 'foundBandage' } },
      { x: 82, y: 35, w: 16, h: 45, label: 'Back inside',
        action: { type: 'goto', scene: 'bar' } }
    ]
  },

  corridor_a: {
    id: 'corridor_a',
    name: 'Red Corridor',
    bg: 'assets/chloe/Chloe060.jpg',
    intro: 'The corridor to the exit. It was maybe ten meters long this afternoon. It is not ten meters long now.',
    hotspots: [
      { x: 10, y: 30, w: 16, h: 38, label: 'Locked doors',
        action: { type: 'dialog', dialogId: 'dlg_corr_a_doors' } },
      { x: 70, y: 12, w: 20, h: 24, label: 'The humming lights',
        action: { type: 'dialog', dialogId: 'dlg_corr_a_hum' } },
      { x: 42, y: 34, w: 18, h: 34, label: 'Something glowing ahead',
        action: { type: 'battle', enemyId: 'neon_wisp', once: true, setsFlag: 'firstWispDown' } },
      { x: 43, y: 8, w: 16, h: 22, label: 'Deeper down the hall',
        action: { type: 'goto', scene: 'corridor_loop' } },
      { x: 2, y: 60, w: 14, h: 35, label: 'Back to the floor',
        action: { type: 'goto', scene: 'club_floor' } }
    ]
  },

  corridor_loop: {
    id: 'corridor_loop',
    name: 'Red Corridor — Again',
    bg: 'assets/chloe/Chloe084.jpg',
    intro: 'The same carpet. The same doors. Chloe is almost sure they have walked past that stain before. Twice.',
    hotspots: [
      { x: 12, y: 55, w: 18, h: 25, label: 'That stain again',
        action: { type: 'dialog', dialogId: 'dlg_loop_carpet' } },
      { x: 66, y: 30, w: 16, h: 35, label: 'A door you already opened',
        action: { type: 'dialog', dialogId: 'dlg_loop_same_door' } },
      { x: 40, y: 40, w: 18, h: 30, label: 'A wisp drifts the hall',
        action: { type: 'battle', enemyId: 'neon_wisp' } },
      { x: 2, y: 25, w: 14, h: 45, label: 'Keep walking',
        action: { type: 'goto', scene: 'corridor_a' } },
      { x: 44, y: 6, w: 14, h: 22, label: 'A hall that wasn\'t there',
        action: { type: 'goto', scene: 'corridor_b', requiresFlag: 'firstWispDown' } }
    ]
  },

  corridor_b: {
    id: 'corridor_b',
    name: 'Fogbound Corridor',
    bg: 'assets/chloe/Chloe075.jpg',
    intro: 'Fog indoors. It doesn\'t drift; it waits. Somewhere in it, something is breathing static.',
    hotspots: [
      { x: 8, y: 15, w: 18, h: 30, label: 'The fog',
        action: { type: 'dialog', dialogId: 'dlg_corr_b_fog' } },
      { x: 74, y: 30, w: 18, h: 38, label: 'A chained double door — VIP',
        action: { type: 'dialog', dialogId: 'dlg_corr_b_chain' } },
      { x: 40, y: 35, w: 20, h: 35, label: 'Static in the fog',
        action: { type: 'battle', enemyId: 'static_ghoul', once: true, setsFlag: 'ghoulSilenced' } },
      { x: 2, y: 55, w: 14, h: 35, label: 'Back the way you came',
        action: { type: 'goto', scene: 'corridor_loop' } },
      { x: 44, y: 4, w: 16, h: 24, label: 'Where the fog thins',
        action: { type: 'goto', scene: 'backstage_between' } },
      { x: 76, y: 70, w: 18, h: 24, label: 'The VIP door — unchained',
        action: { type: 'goto', scene: 'vip_room', requiresFlag: 'shadeShattered' } }
    ]
  },

  backstage_between: {
    id: 'backstage_between',
    name: 'The Backstage Between',
    bg: 'assets/chloe/Chloe064.jpg',
    intro: 'The color drains out of everything but the red. No echo. No footsteps. This is the Backstage Between.',
    hotspots: [
      { x: 10, y: 20, w: 20, h: 30, label: 'The silence',
        action: { type: 'dialog', dialogId: 'dlg_between_silence' } },
      { x: 66, y: 55, w: 20, h: 28, label: 'Grey, weightless dust',
        action: { type: 'dialog', dialogId: 'dlg_between_grey' } },
      { x: 40, y: 38, w: 18, h: 30, label: 'A shape of white noise',
        action: { type: 'battle', enemyId: 'static_ghoul' } },
      { x: 2, y: 45, w: 14, h: 40, label: 'Back into the fog',
        action: { type: 'goto', scene: 'corridor_b' } },
      { x: 44, y: 4, w: 16, h: 24, label: 'Deeper between',
        action: { type: 'goto', scene: 'between_depths' } },
      { x: 82, y: 15, w: 16, h: 35, label: 'A glittering doorway',
        action: { type: 'goto', scene: 'mirror_hall', requiresFlag: 'ghoulSilenced' } }
    ]
  },

  between_depths: {
    id: 'between_depths',
    name: 'The Deep Between',
    bg: 'assets/chloe/Chloe036.jpg',
    intro: 'The Between opens up into a pale nothing. If the club has a subconscious, this is it.',
    hotspots: [
      { x: 30, y: 8, w: 40, h: 22, label: 'The horizon',
        action: { type: 'dialog', dialogId: 'dlg_depths_horizon' } },
      { x: 66, y: 45, w: 20, h: 30, label: 'Ash, lagging behind',
        action: { type: 'dialog', dialogId: 'dlg_depths_ash' } },
      { x: 34, y: 45, w: 20, h: 32, label: 'Your own reflection, walking wrong',
        action: { type: 'battle', enemyId: 'mirror_shade' } },
      { x: 2, y: 55, w: 14, h: 35, label: 'Back toward the red',
        action: { type: 'goto', scene: 'backstage_between' } }
    ]
  },

  mirror_hall: {
    id: 'mirror_hall',
    name: 'Hall of the Broken Mirror',
    bg: 'assets/chloe/Chloe078.jpg',
    intro: 'The club\'s famous mirror wall — shattered into a red mosaic. Every shard shows a face that isn\'t yours.',
    hotspots: [
      { x: 8, y: 15, w: 22, h: 40, label: 'The mirror wall',
        action: { type: 'dialog', dialogId: 'dlg_mirror_wall' } },
      { x: 68, y: 62, w: 22, h: 28, label: 'Shards on the floor',
        action: { type: 'dialog', dialogId: 'dlg_mirror_shards' } },
      { x: 40, y: 30, w: 20, h: 40, label: 'Something steps out of the glass',
        action: { type: 'battle', enemyId: 'mirror_shade', once: true, setsFlag: 'shadeShattered' } },
      { x: 2, y: 50, w: 14, h: 40, label: 'Back to the Between',
        action: { type: 'goto', scene: 'backstage_between' } }
    ]
  },

  vip_room: {
    id: 'vip_room',
    name: 'VIP Room — The Promoter',
    bg: 'assets/chloe/Chloe081.jpg',
    intro: 'A perfect red square of a room. A skylight with no sky behind it. He has been expecting you.',
    hotspots: [
      { x: 8, y: 55, w: 20, h: 30, label: 'A desk of unsigned contracts',
        action: { type: 'dialog', dialogId: 'dlg_vip_contract' } },
      { x: 70, y: 55, w: 20, h: 30, label: 'Champagne, still fizzing',
        action: { type: 'dialog', dialogId: 'dlg_vip_desk' } },
      { x: 38, y: 22, w: 24, h: 48, label: 'The Promoter',
        action: { type: 'battle', enemyId: 'promoter', once: true, setsFlag: 'promoterDown' } },
      { x: 40, y: 6, w: 20, h: 16, label: 'The skylight, opening',
        action: { type: 'dialog', dialogId: 'dlg_vip_after', requiresFlag: 'promoterDown' } },
      { x: 2, y: 40, w: 14, h: 40, label: 'Back to the corridor',
        action: { type: 'goto', scene: 'corridor_b' } }
    ]
  }

};
