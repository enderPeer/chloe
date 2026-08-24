/* CHLOE — data/arena-nav.js  (spec §20)
   PRECOMPUTED walkable floor for the church arena.

   Why this is a data file and not computed at load: three r128 ships no BVH,
   so probing 3500 grid cells against the church's 37 meshes walks every
   triangle 7000 times — about 50 seconds of frozen main thread. Baked once,
   shipped as a packed bitfield (~580 chars), decoded in under a millisecond.

   `key` pins the grid to the church placement it was measured against
   (assetVersion | x | y | z | rotY). Move or replace the model and the key
   stops matching; engine/arena3d.js then refuses the stale grid and falls
   back to the bounds rectangle with a console warning.

   TO RE-BAKE after changing the church:
     1. open the game, enter the arena, wait for churchLoaded
     2. run  JSON.stringify(CHLOE.engine.arena3d._bakeExport())
        (the tab will freeze for ~a minute — this is expected)
     3. paste the result over the object below

   Bit i of the field is cell (i / nz | 0, i % nz); 1 = you can stand there.
   Cell centre = (minX + i * cell, minZ + j * cell). The bake already
   flood-filled from the player spawn, so isolated side chapels read as 0.
*/
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

CHLOE.data.arenaNav = {
  // assetVersion 6 added asteroid.glb; the CHURCH is byte-identical, so the
  // baked floor is still valid and only the version half of the key moved.
  key: '6|0|34.04|-7.5|1.5708',
  cell: 0.4,
  minX: -9.7,
  minZ: -13.5,
  nx: 50,
  nz: 70,
  walkable: 1563,   // 250 m² of real stone, vs the 160 m² the old box guessed
  b64: 'AAAA/P8DAAAAAACA//8BAAAAAADg//8AAAAAAAD8/z8AAAAAwP////8/AAAA8P////8PAAAA/P////8DAAAA//////8AAADA/////z8AAADw/////Q8AAAD8/////wMAAAD//////wAAAMD/////PwAAAPD//f//DwAAAPz/////AwAAwP//////AAAA2P////8/AAAA8P//3/8PAAAA/P//x/8DAAAA////9/8AAADA/wcA/j8AAADw/wGA/w8AAAD8fwDg/wMAAAD/HwD4/wAAAMD/AQDwPwAAAPB/AAD8DwAAAPwfAAD/AwAAAP8fAPj/AAAAwP8HAP4/AAAA8P////8PAAAA/P////8DAAAA//////8AAADA/z///z8AAADw/x///w8AAAD8/////wMAAAD//////wAAAMD////+PwAAAPD/////DwAAAPz/////AwAAAP//////AAAAwP////8/AAAA8P////8PAAAA/P////8DAAAA//////8AAADA/////z8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
};
