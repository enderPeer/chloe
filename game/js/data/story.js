window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};
// story.js — STORY agent. All dialogs referenced by scenes.js, plus intro & first-victory.
// Speakers: 'chloe' | 'ash' | '???' (or a name). portrait keys resolve via CHLOE.data.portraits.

CHLOE.data.dialogs = {

  // ---- Intro (spec §11): Chloe wakes alone in the dressing room after the gig (played once at new game) ----
  intro: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Ow. Okay. Floor of the dressing room. Last thing I remember is the encore... which we never play.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Ash? The gig ended. I think the gig ended. Why is the light doing THAT.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Listen. Forty drunk people, a sound system, a street outside. And I can hear my own heartbeat. Nothing else.' },
    { speaker: '???', text: '...chloe. open the door, chloe. it\'s me. it\'s asssh.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'That\'s Ash\'s voice. Most of it. Ash doesn\'t hiss her own name, and Ash would just come IN—' },
    { speaker: 'chloe', portrait: 'chloe', text: 'The door\'s locked. From my side. I didn\'t lock it, and this door doesn\'t HAVE a lock.' },
    { speaker: '???', text: '...you were so good tonight. do the encore. do it forever.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Right. Crimson Fret\'s still on my back. Whatever\'s wrong with this room, I\'m very persuasive in E minor.' }
  ],

  // ---- The Room (spec §11) — dressing room hotspot dialogs ----
  door_locked: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Locked. Solid. The knob\'s warm, like someone\'s been holding it from the other side this whole time.' },
    { speaker: 'ash', portrait: 'ash', text: '*muffled, through the door* Chloe? Chloe, open up — it\'s me, it\'s— *the voice drops an octave mid-word* —meeee.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'See, ninety percent of that was my sister. It\'s the last ten percent I\'m not opening the door for.' }
  ],
  dlg_room_mirror_pre: [
    { speaker: 'chloe', portrait: 'chloe', text: 'The vanity mirror\'s dead — no reflection, just... depth. Like looking into a hallway with the lights off.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Wait. Something\'s standing in it. Stagehand vest, lanyard, no— where\'s its face. WHERE\'S ITS—' },
    { speaker: '???', text: '...encore...' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Okay. It\'s coming through. Fret up. Let\'s see if it likes E minor.' }
  ],
  dlg_room_lamp: [
    { speaker: 'chloe', portrait: 'chloe', text: 'The light strip over the mirror is flickering. Long, short, short, long. That\'s not a dying bulb — that\'s a rhythm.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'It\'s our set list. It\'s flickering our SET LIST. I want to be flattered and I am not.' }
  ],
  dlg_room_polaroids: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Our gig polaroids, swept off the mirror frame. Me and Ash at the bar, on stage, in the alley...' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Except in every single one, Ash is looking at the camera. She wasn\'t. I took half of these.' }
  ],
  dlg_room_stool: [
    { speaker: 'chloe', portrait: 'chloe', text: 'The vanity stool, tipped on its side. Still spinning. Slowly. It has been spinning this whole time.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'I\'m not touching it. Some furniture you just let win.' }
  ],
  dlg_room_armchair: [
    { speaker: 'chloe', portrait: 'chloe', text: 'The armchair sags in the middle like someone heavy is still sitting in it. The cushion\'s warm.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Nobody\'s there. I checked twice. I\'m going to stop checking, because third time feels like an invitation.' }
  ],
  dlg_room_closet: [
    { speaker: 'chloe', portrait: 'chloe', text: 'The wardrobe. Door open exactly one hand\'s width. Inside: our stage clothes, and a dark that doesn\'t match the room.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Something in there is breathing very, very quietly. So we\'re both going to pretend I didn\'t notice.' }
  ],
  // Victory beat (spec §11): mirror shatters, door clicks open, Ash gets in — engine adds her to the party on roomCleared.
  room_victory: [
    { speaker: 'chloe', portrait: 'chloe', text: 'It just — folded. Like an empty costume. And the mirror went with it—' },
    { speaker: 'chloe', portrait: 'chloe', text: 'The whole pane\'s shattering. Every shard hitting the floor makes a sound like applause. I hate this venue.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'And the door just clicked. Like it lost interest in me.' },
    { speaker: 'ash', portrait: 'ash', text: '*bursting in, switchblade out* CHLOE. I\'ve been pounding on that door for an hour — it kept ANSWERING me. In your voice.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Funny. It was doing yours. Bad impression, by the way — you don\'t hiss nearly that much.' },
    { speaker: 'ash', portrait: 'ash', text: 'The club\'s empty and the halls are wrong. Livewire\'s charged and I\'m not leaving your side again. Let\'s go.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Grab those shards on your way. If tonight runs on broken mirror, we\'re getting paid in it.' }
  ],

  // ---- After the first ever battle victory ----
  first_victory: [
    { speaker: 'ash', portrait: 'ash', text: 'It just... popped. Like a busted stage light. And it dropped — glass?' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Mirror shards. From the wall by the dance floor. Why is the mirror wall in a monster.' },
    { speaker: 'ash', portrait: 'ash', text: 'Why is anything, tonight. Pocket them. If this place runs on broken glass, we\'re getting paid in it.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Gig economy. Literally. Let\'s keep moving before the hall changes its mind again.' }
  ],

  // ---- Stage ----
  dlg_stage_mic: [
    { speaker: 'chloe', portrait: 'chloe', text: 'The mic\'s still warm. The feedback\'s gone, though. All of it. Like the air stopped carrying sound it doesn\'t like.' },
    { speaker: 'ash', portrait: 'ash', text: 'Then let\'s not sing anything it likes.' }
  ],
  dlg_stage_amp: [
    { speaker: 'ash', portrait: 'ash', text: 'Amp\'s dead. Power light\'s on, cone\'s moving, no sound. That\'s not broken, that\'s... stolen.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Something\'s eating the sound in here. Add it to the tab.' }
  ],

  // ---- Main floor ----
  dlg_floor_crowd: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Forty people were here. Cigarettes still lit in the ashtrays. Nobody walks out on a lit cigarette in this town.' },
    { speaker: 'ash', portrait: 'ash', text: 'They didn\'t walk out, Chloe. Look at the chairs. Nothing\'s pushed back.' }
  ],
  dlg_floor_poster: [
    { speaker: 'ash', portrait: 'ash', text: '"CHLOE & ASH — ONE NIGHT ONLY." Someone\'s crossed out ONE and written EVERY.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'The handwriting\'s mine. That\'s the part I hate.' }
  ],

  // ---- Bar ----
  dlg_bar_glasses: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Half-finished drinks, still cold. Whatever happened, it happened between one sip and the next.' },
    { speaker: 'ash', portrait: 'ash', text: 'Great. I\'ll take my hollowing-out between drinks too, very civilized.' }
  ],
  dlg_bar_tab: [
    { speaker: 'ash', portrait: 'ash', text: 'Marek\'s tab book. Last entry: our bar tab, and under it — "paid in full, The Promoter."' },
    { speaker: 'chloe', portrait: 'chloe', text: 'We don\'t have a promoter. We\'ve never had a promoter. Nobody pays our tab.' }
  ],

  // ---- Dressing room ----
  dlg_dress_mirror: [
    { speaker: 'chloe', portrait: 'chloe', text: 'The mirror in here still works like a mirror. Small mercies.' },
    { speaker: 'ash', portrait: 'ash', text: 'Keep an eye on it anyway. If your reflection blinks first, we\'re leaving.' }
  ],
  dlg_dress_jacket: [
    { speaker: 'ash', portrait: 'ash', text: 'My spare jacket. Still smells like the van. Weirdly comforting.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'This room remembers us. That\'s why it\'s still... normal. Hold onto that.' }
  ],

  // ---- Alley ----
  dlg_alley_door: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Stage door\'s open, but the alley just... continues. The street at the end never gets closer.' },
    { speaker: 'ash', portrait: 'ash', text: 'So the exit is decorative now. Cool. Love what they\'ve done with the place.' }
  ],
  dlg_alley_rain: [
    { speaker: 'ash', portrait: 'ash', text: 'The rain\'s hanging in the air. Not falling. Just... paused.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Whoever hit pause on this place — we\'re going to find the remote.' }
  ],

  // ---- Corridor A ----
  dlg_corr_a_doors: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Every door on this hall is locked. Some of them are warm. I\'m choosing not to think about that.' },
    { speaker: 'ash', portrait: 'ash', text: 'One of them was knocking a minute ago. From the inside. Also choosing not to think about it.' }
  ],
  dlg_corr_a_hum: [
    { speaker: 'ash', portrait: 'ash', text: 'Hear the lights? They\'re humming our set list. Track by track.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'When they get to the encore, I want to be somewhere else.' }
  ],

  // ---- Corridor loop ----
  dlg_loop_carpet: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Same stain. Third time. We\'re walking in a circle that only has one side.' },
    { speaker: 'ash', portrait: 'ash', text: 'That glowing thing keeps drifting past like it owns the lease. Maybe the hall stops looping if we pop it.' }
  ],
  dlg_loop_same_door: [
    { speaker: 'ash', portrait: 'ash', text: 'I marked this door with lipstick two halls ago. The mark\'s here. The two halls aren\'t.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'The building is shuffling itself like a deck. Fine. We\'ll play the hand.' }
  ],

  // ---- Corridor B (fog) ----
  dlg_corr_b_fog: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Fog. Indoors. It tastes like the noise between radio stations.' },
    { speaker: 'ash', portrait: 'ash', text: 'It\'s not fog, it\'s static with ambitions. Stay close.' }
  ],
  dlg_corr_b_chain: [
    { speaker: 'ash', portrait: 'ash', text: 'VIP room. Chained shut — and the chains are made of mirror glass. Something on the other side is humming our encore.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'The glass answers to whatever came out of that mirror hall. Break the thing in the glass, break the chain. Then we go say hi.' }
  ],

  // ---- Backstage Between ----
  dlg_between_silence: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Say something.' },
    { speaker: 'ash', portrait: 'ash', text: 'I did. Twice. It\'s taking the words before they land. This is where the sound goes, Chloe. All of it.' }
  ],
  dlg_between_grey: [
    { speaker: 'ash', portrait: 'ash', text: 'This dust — it\'s not dust. It\'s applause. Ground down to nothing.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Someone\'s been harvesting this club for years. Every cheer, every name. And tonight they got greedy.' }
  ],

  // ---- Deep Between ----
  dlg_depths_horizon: [
    { speaker: 'chloe', portrait: 'chloe', text: 'There\'s a horizon down here. Backstage does not have a horizon. Backstage has a fire exit and a vending machine.' },
    { speaker: 'ash', portrait: 'ash', text: 'It\'s where the club keeps everything it took. Careful — the deep ones wear your face.' }
  ],
  dlg_depths_ash: [
    { speaker: 'ash', portrait: 'ash', text: 'I\'m fine. It\'s just... I can\'t remember our first song. The one we wrote in the van. It\'s gone.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'It started in E minor and you hated it. I\'ll hold the memory. You hold the knife. We\'ll trade back outside.' }
  ],

  // ---- Mirror hall ----
  dlg_mirror_wall: [
    { speaker: 'chloe', portrait: 'chloe', text: 'The mirror wall. Marek said it came with the building. Every shard\'s showing a different night — every gig this club ever ate.' },
    { speaker: 'ash', portrait: 'ash', text: 'There. Third shard from the left. That\'s tonight. That\'s us, still on stage. Still playing.' }
  ],
  dlg_mirror_shards: [
    { speaker: 'ash', portrait: 'ash', text: 'The shards on the floor are the same stuff the monsters drop. The whole economy down here is broken mirror.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'Then somebody broke this wall on purpose. And started spending the pieces.' }
  ],

  // ---- VIP room ----
  dlg_vip_contract: [
    { speaker: 'ash', portrait: 'ash', text: 'Contracts. Hundreds. Every act that ever played The Red Room — and every signature line is blank except the last page.' },
    { speaker: 'chloe', portrait: 'chloe', text: '"CHLOE & ASH — EVERY NIGHT. FOREVER." Yeah. We\'re not signing. We\'re headlining his funeral instead.' }
  ],
  dlg_vip_desk: [
    { speaker: 'chloe', portrait: 'chloe', text: 'Champagne on ice, still fizzing. Two glasses. He knew we\'d make it this far.' },
    { speaker: 'ash', portrait: 'ash', text: 'Then he also knows what happens next, and he still poured. Confidence or stupidity — either works for me.' }
  ],
  dlg_vip_after: [
    { speaker: 'ash', portrait: 'ash', text: 'The skylight\'s opening. That\'s actual night sky. Actual sirens. Actual city.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'The halls are just halls again. Whoever the Promoter was working for is still out there — but that\'s a problem for Act Two.' },
    { speaker: 'ash', portrait: 'ash', text: 'Drink first. He did pour us champagne.' },
    { speaker: 'chloe', portrait: 'chloe', text: 'To The Red Room. Worst venue in the district. Ours, though.' }
  ]
};

CHLOE.data.story = {
  startScene: 'the_room',
  introDialog: 'intro',
  // First story fight is now the_hollow in the_room (spec §11); its victory beat covers mirror-shatter + door click + Ash joining.
  // ('first_victory' is kept above for the legacy 2D flow, which is unrouted but must not break.)
  onFirstVictoryDialog: 'room_victory',
  // Flag documentation — every flag set/required anywhere in scenes.js:
  flags: {
    mirrorFaced: 'Set by the pre-battle mirror dialog in the_room (dlg_room_mirror_pre). Swaps the mirror hotspot from examine-dialog to the the_hollow battle.',
    roomCleared: 'Set by defeating the_hollow at the dressing-room mirror in the_room (spec §11). Hides the door_locked dialog, unlocks the door hotspot (goto stage) and triggers the engine hook that adds Ash to the party.',
    firstWispDown: 'Set by defeating the first Neon Wisp in corridor_a. Stops the red corridors looping: opens corridor_loop -> corridor_b.',
    ghoulSilenced: 'Set by defeating the Static Ghoul in corridor_b. Opens backstage_between -> mirror_hall (the glittering doorway).',
    shadeShattered: 'Set by defeating the Mirror Shade in mirror_hall. Shatters the mirror-glass chains: opens corridor_b -> vip_room (boss door).',
    promoterDown: 'Set by defeating The Promoter in vip_room. Ends Act 1; reveals the dlg_vip_after epilogue hotspot.',
    foundBandage: 'Set by taking the bandage from the first-aid kit in the alley (one-time pickup).'
  }
};
