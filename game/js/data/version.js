/* CHLOE — data/version.js
   ONE source of truth for the version the game shows on screen.

   Scheme: major.minor.build
     major  0 until the game is called finished.
     minor  tracks the GAME_SPEC.md section this build implements, so a
            version is self-documenting: v0.23.x IS "the game as of §23".
            Bump it when a new spec section lands.
     build  incremented on EVERY push, so a player can always tell that what
            they are looking at changed. Never reset except by a minor bump.

   DO NOT hand-edit `build` or `date` — tools/bump-version.js owns them, and
   the pre-commit hook in tools/hooks runs it for you (see README). The label
   is prose and is meant to be edited by hand when a drop gets a name. */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

CHLOE.data.version = {
  major: 0,
  minor: 23,
  build: 1,
  label: 'Pockets & Asteroid',
  date: '2026-08-24',
  /* Called as CHLOE.data.version.string(), so `this` is the object. Kept as
     methods rather than a baked string so the bumper only ever rewrites the
     three numeric lines it owns and can never corrupt the display logic. */
  string: function () { return 'v' + this.major + '.' + this.minor + '.' + this.build; },
  full: function () { return this.string() + (this.label ? ' — ' + this.label : ''); }
};
