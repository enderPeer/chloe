/* CHLOE — data/pvp.js  (spec §32)
   The numbers behind the eight-player deathmatch. Content only: no logic, no
   DOM, no network — engine/net.js, engine/pvp.js and ui/lobby.js all read from
   here, so a knob turned once is turned everywhere.

   Two numbers in here are RESTATED from files that do not know this one
   exists — `nameMaxLen` is engine/records.js's NAME_MAX, and `seatRadius` is
   the radius the eight seats in data/stages.js are resolved on. That is the
   same deal data/stages.js already makes with data/arena3d.js: a restated
   number is a promise to change both. If you change one and not the other, two
   parts of the game disagree about the same fact, and that is a bug, not a
   preference.

   Distances in meters, angles in radians, everything else in milliseconds
   unless the key says Hz. */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.pvp = {

  /* ---- The wire's identity (spec §32) ------------------------------------
     Every message carries `v`, and a `v` the other side does not know is
     refused AT THE LOBBY with a readable line rather than being let into a
     match that then behaves strangely. Two players on GitHub Pages can easily
     be on builds a week apart, and "the hits stopped registering" is a much
     worse failure than "your version is older than the host's".

     Bump this when a field's MEANING changes, not when one is added: unknown
     fields are ignored by contract, so adding one is not a break. */
  protocolVersion: 1,

  /* BroadcastChannel name prefix; the room code is appended. Namespaced the
     way records.js namespaces its storage key ('chloe.records.v1'), because a
     BroadcastChannel name is a global string shared with every other page on
     the origin — the landing page, a second build in another tab, anything.

     Deliberately NOT versioned. If the channel carried protocolVersion, two
     mismatched builds would simply never hear each other and the lobby would
     show an empty room forever. On one shared channel they meet, exchange
     `hello`, and the version check above can say the true thing out loud. */
  channelPrefix: 'chloe.pvp.',

  /* ---- The room code ------------------------------------------------------
     Four characters: a code you can read down a voice call in one breath and
     retype from a photo of someone's screen. 32^4 = 1,048,576 rooms.

     A room IS its code — the relay derives the Durable Object id straight from
     it, and BroadcastChannel derives the channel name — so there is no
     registry of live rooms and no allocation step. The cost of that is that
     two unrelated parties who pick the same four characters land in the same
     match. At one in a million per pair, that is a curiosity; the alternative
     is server-side room state, which is the kind of thing this game
     deliberately does not have. */
  roomCodeLen: 4,

  /* 32 characters, uppercase only, with I, O, 0 and 1 removed — those are the
     four that do not survive being read aloud or copied off a screenshot, and
     a room code's entire job is surviving exactly that. Uppercase-only means
     the lobby can upper-case whatever is typed and never has to ask which case
     was meant. */
  roomCodeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',

  /* The same 12 as engine/records.js NAME_MAX, and the same on purpose: a
     player has ONE name in this game, so a name that fits the record board
     fits a roster row and a kill-feed line. The worker scrubs to this length
     too — a client is never a validator, and the length is part of the
     validation, not just part of the layout. */
  nameMaxLen: 12,

  /* ---- The lobby ----------------------------------------------------------
     EIGHT is not a taste call, it is the draw-call budget. One knight body is
     103 meshes and 44,037 triangles; eight of them is ~824 draw calls in the
     colour pass even with the shadow pass dropped, and geometry and textures
     are shared by reference so only the calls multiply, not the VRAM. It is
     also ROOM_MAX_SOCKETS in the worker, and the length of `colors` below.
     Those three eights are the same eight — move one and move all three. */
  maxPlayers: 8,

  /* A deathmatch of one is over before it starts, so Start stays disabled
     below this. Two is a duel, which is a real match AND the cheapest thing to
     test with: two tabs on BroadcastChannel, no server anywhere. */
  minPlayers: 2,

  /* The beat between the host pressing Start and the arenas beginning to
     build. It buys two things: a `ready` or `roster` still in flight lands
     before seats are frozen, and all eight players watch the same short
     countdown instead of eight differently-timed loading hitches. Short enough
     that nobody wonders whether the button worked. */
  startCountdownMs: 1500,

  /* ---- The hot path -------------------------------------------------------
     `state` is the only high-rate message. Fifteen a second per player is 120
     messages/second through a full room — nothing to a BroadcastChannel or a
     Durable Object — and it is a quarter of what a per-rAF send would cost.
     Below about 10 the interpolation starts to read as gliding; above about 20
     you are paying bandwidth for motion the interpolator was already drawing
     correctly. engine/pvp.js rate-limits internally, because battle3d calls
     tickSend() once per FRAME and the frame rate is not ours to choose. */
  sendHz: 15,

  /* How long a remote body takes to ease onto the last position it reported.
     Deliberately longer than the 66.7 ms gap between two sends at 15 Hz: an
     interpolation window shorter than the packet interval runs dry between
     packets, so the body arrives, stops dead, and jerks on the next one. The
     price is ~100 ms of positional lag on someone else's body, which is the
     honest cost of having no server to reconcile against. */
  interpMs: 100,

  /* Rounding applied before a `state` goes out: 2 decimals on metres (1 cm),
     3 on radians (0.057°). Both are far below what a 2.15 m body shows at
     10 m. Bandwidth is only half the reason — the other half is that an
     unrounded float makes EVERY tick a change, so a player standing perfectly
     still would transmit forever. */
  posDecimals: 2,
  angDecimals: 3,

  /* Liveness, and it is on a TIMER rather than on the frame loop for a
     measured reason: a browser stops rAF in a hidden tab, and the local
     transport's whole premise is two tabs of which only one can be in front.
     A hidden tab would stop sending `state`, look silent, and be timed out of
     its own match. setInterval is throttled in a background tab but not
     stopped, and 2000 ms is already past the throttle floor, so the ping keeps
     arriving. Half a message a second against the 15 of `state`: free. */
  pingMs: 2000,

  /* Silence this long and a peer is treated as gone. Two and a half ping
     intervals: one lost ping is a bad moment on a train, two in a row is a
     player who is not coming back. A gone player is marked dead and hidden IN
     PLACE — never spliced out of the body array, because the array index is
     the only identity a body has and renumbering silently re-targets every
     in-flight timer and callback. */
  peerTimeoutMs: 5000,

  /* The hard timeout on opening the relay, and the same 4000 ms records.js
     uses for its requests, for the same stated reason: a slow server must
     never hold up the room. When it expires the lobby says "no relay" and
     falls back rather than spinning on a socket that is never going to open. */
  connectTimeoutMs: 4000,

  /* ---- The match: one life, and a ladder made of kills ---------------------
     Exactly one level per kill on the shared 1–100 ladder (config.levelCap),
     granted immediately and mid-match. One and not two: the ladder already
     hands out an ability and a key every few rows, and with combat3's
     refreshLeaderStats making the new maximums live, a single level is a
     visible, felt reward. Two would let the first player to find someone end
     the match before the rest had found each other. */
  levelsPerKill: 1,

  /* How long nobody can be hurt after the Ring opens, and this one is a RULE
     of the mode rather than a dial, because the arithmetic forces it.

     Eight seats at seatRadius put ADJACENT fighters 8.03m apart (2*10.5*
     sin(22.5deg)), and gun_9mm — which ladder row 1 seeds onto BOTH mouse
     buttons, so it is what everyone opens with — does FULL damage out to 14m
     and still reaches 22m at 0.6x. Opposite seats are 21.0m apart. So at the
     first frame every fighter is already inside full-damage range of both
     neighbours and in range of literally everyone else, on a floor whose
     entire design is that it has no cover.

     Geometry cannot fix it: an 8.03m chord only reaches 14m at a seat ring of
     r > 18.3m, and the player clamp is 13.65m. So the answer is temporal. The
     grace is what turns "whoever clicked first wins" into a fight that starts
     with eight people moving. combat3 already owns the primitive — the same
     iframe window evade and the revive potion use — so a declared hit is
     refused by the same guard that refuses one during a dodge. */
  spawnGraceMs: 3000,

  /* The level a fighter is entered on the board at, and the floor a match can
     never go below — the ladder is 1-based, so there is no level 0 to fall to
     when a `roster` has not yet said what a peer really is. */
  startLevel: 1,

  /* The beat between "you are dead" and the dressing room taking you back.
     Not a loading delay: it is the moment you get to see who killed you and
     where you fell, and it is roughly the length of the death pose. Under a
     second reads as a bug, because the screen changes before you know why. */
  respawnToHubMs: 1200,

  /* A kill-level fires three toasts today (the skill point, and one per
     learnset move). In a deathmatch that is per-kill noise across the middle
     of a fight, so §32 suppresses them and says "LEVEL n" once instead. Long
     enough to read without looking away from someone trying to kill you. */
  levelToastMs: 1400,

  /* The kill feed. Five lines is about as much as anyone reads while still
     watching the fight, and six seconds outlives one exchange — long enough
     that you can look back after a trade and see what happened to you. */
  killFeedMax: 5,
  killFeedMs: 6000,

  /* ---- The eight seats ----------------------------------------------------
     RESTATED from data/stages.js, where the eight resolved {x,z,yaw} seats of
     the Ring live. That file carries the coordinates because a stage owns
     WHERE the fight happens; this file carries the radius because the radius
     is the tuning knob, and because a reader asking "how far apart do people
     start?" comes here first. The arithmetic behind the number — the 13.65 m
     player clamp, the 8.04 m chord between neighbours, the 21 m across — is
     written out beside the seats in data/stages.js. Change both. */
  seatRadius: 10.5,

  /* Per-seat body tint, and the ONLY thing that tells one fighter from
     another: a remote body gets no PointLight of its own (the Ring already
     runs five, and eight more would re-key every material's shader program
     mid-match as players joined and died), so identity has to be colour.

     Applied with `m.color`, NEVER `emissive` — emissive is triple-booked by
     the hit flash, the kill flash and the level-up tell, all of which reset it
     unconditionally to black, so an emissive identity marker is stomped the
     first time its owner is hit.

     WHY THEY ARE ALL SO BRIGHT. These replace the absolute dark steel tint
     arena3d's loadKnight sets on the knight (0.30, 0.29, 0.33 — set
     absolutely because the GLB's own black baseColorFactor left pure black
     when multiplied), and they are then multiplied by the armour's own dark
     diffuse map. A dark tint times a dark map is invisible at 10 m, which is
     exactly the distance these have to work at. So every entry keeps at least
     one channel at or near full: saturated and light, so the multiply leaves
     both hue AND value on the body.

     They also have to survive the room. The floor is warm grey (0x6d6a66) and
     the four rim lights are orange (0xff7a2a), which is why there is no orange
     seat — a body tinted the same hue as the light rimming it is a body you
     stop being able to find. The blue half of the palette loses chroma where a
     rim light is strongest, so the blues here are LIGHT rather than deep: a
     pale blue that has been warmed still separates from the floor by value.
     The disc's dominant light is cool anyway (ambient 0x5f6570, moon 0xaebdd4,
     key 0xd8e2f2) — the orange is a rim, not the key.

     Eight hues, roughly evenly spaced, with a neutral bone white as the eighth
     because a ninth saturated hue would collide with one of the other eight
     long before it read as its own colour. Order is seat order. */
  colors: [
    0xff4a4a,   // 0  red
    0xffcf3d,   // 1  gold        (not orange — that is the rim light)
    0x7ae04b,   // 2  lime
    0x25d8bf,   // 3  teal
    0x4aa6ff,   // 4  sky
    0x9b6cff,   // 5  violet
    0xff63c8,   // 6  magenta
    0xe9ecf5    // 7  bone
  ],

  /* What a seat is CALLED, so the kill feed can say "Teal killed Gold" when a
     player has not typed a name, and so the roster can label a swatch. One
     word each, because the feed line has to fit beside two of them and a verb.
     Index-locked to `colors` above: same order, same length. */
  colorNames: ['Red', 'Gold', 'Lime', 'Teal', 'Sky', 'Violet', 'Magenta', 'Bone']
};
