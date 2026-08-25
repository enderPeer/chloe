/* CHLOE — engine/displays.js  (spec §19)
   The dressing room reads you back. Three canvas surfaces the 3D room paints
   onto its own props:
     mirror()  -> YOUR leader: level, resources, stats, unlocked abilities
     poster()  -> the Hollow Black Knight: level, stats, attack patterns
     tv(ch)    -> "THE LONG NIGHT" — a how-to programme, one chapter per screen

   Pure drawing: takes game state, returns a canvas. No THREE, no DOM tree.
   engine/world3d.js wraps these in CanvasTextures and refreshes them. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.displays = (function () {
  'use strict';

  var BG = '#0d0a0c', RED = '#e5173f', TXT = '#f2eef0', DIM = '#9a939c';
  // amber: the stage board's accent, kept off the mirror's blue and the
  // poster's red so a glance at the wall tells the three panels apart
  var ACCENT = '#ffd166';
  var ACCENT_DIM = 'rgba(255,209,102,0.65)';

  /* §26: the two picker arrows on the stage board, in CANVAS-NORMALISED
     coordinates (0..1 from the top-left of the painted sheet). The room
     hit-tests the poster's UV against THIS table and the board draws its
     buttons from it, so the arrow you can see and the arrow you can press
     cannot drift apart. Deliberately generous (~13 x 11cm on the 0.85 x
     1.15m sheet): they are aimed at down a crosshair from across a room,
     not clicked with a mouse pointer resting on them. */
  var STAGE_ARROWS = {
    left:  { x0: 0.045, y0: 0.150, x1: 0.190, y1: 0.248 },
    right: { x0: 0.810, y0: 0.150, x1: 0.955, y1: 0.248 }
  };

  function make(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function panel(g, w, h, title, accent) {
    g.fillStyle = BG; g.fillRect(0, 0, w, h);
    // vignette so the panel reads as a lit surface, not a flat sticker
    var v = g.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.8);
    v.addColorStop(0, 'rgba(255,255,255,0.05)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = v; g.fillRect(0, 0, w, h);
    g.strokeStyle = accent || RED; g.lineWidth = 6;
    g.strokeRect(10, 10, w - 20, h - 20);
    g.fillStyle = accent || RED;
    g.font = 'bold ' + Math.round(h * 0.075) + 'px Impact, "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.fillText(title, w / 2, h * 0.115);
    g.textAlign = 'left';
  }

  function bar(g, x, y, w, h, pct, color) {
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(x, y, w, h);
    g.fillStyle = color; g.fillRect(x, y, Math.max(0, Math.min(1, pct)) * w, h);
    g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 2; g.strokeRect(x, y, w, h);
  }

  /* ---------------- mirror: your leader ---------------- */
  function mirror() {
    var W = 512, H = 640, c = make(W, H), g = c.getContext('2d');
    var p = CHLOE.engine.party;
    var m = p && p.active ? p.active() : null;
    panel(g, W, H, 'WHO YOU ARE', '#9db4c0');
    if (!m) {
      g.fillStyle = DIM; g.font = '22px system-ui, sans-serif';
      g.fillText('Nobody is looking back.', 40, H / 2);
      return c;
    }
    var def = (CHLOE.data.characters || {})[m.id] || {};
    var eff = p.effStats(m);
    var y = H * 0.20;

    g.fillStyle = TXT; g.font = 'bold 40px Impact, "Arial Narrow", sans-serif';
    g.fillText((def.name || m.id).toUpperCase(), 40, y);
    g.fillStyle = RED; g.font = '24px system-ui, sans-serif';
    g.fillText('Level ' + m.level, 40, y + 34);

    y += 70;
    var bw = W - 80;
    var rows = [
      ['LIFE', m.hp, eff.life, '#e5173f'],
      ['MAGIC', m.mp, eff.magic, '#7fb3e8'],
      ['STAMINA', m.stamina || 0, eff.stamina, '#7fd08a']
    ];
    rows.forEach(function (r) {
      g.fillStyle = DIM; g.font = '15px system-ui, sans-serif';
      g.fillText(r[0], 40, y);
      g.textAlign = 'right';
      g.fillStyle = TXT; g.fillText(Math.round(r[1]) + ' / ' + Math.round(r[2]), W - 40, y);
      g.textAlign = 'left';
      bar(g, 40, y + 8, bw, 16, r[2] > 0 ? r[1] / r[2] : 0, r[3]);
      y += 52;
    });

    y += 12;
    g.fillStyle = '#9db4c0'; g.font = 'bold 20px Impact, sans-serif';
    g.fillText('STATS', 40, y); y += 30;
    g.font = '18px system-ui, sans-serif';
    var stats = [['ATK', eff.atk], ['DEF', eff.def], ['SPD', eff.spd], ['MAG', eff.mag]];
    stats.forEach(function (s, i) {
      var col = 40 + (i % 2) * (bw / 2);
      var row = y + Math.floor(i / 2) * 30;
      g.fillStyle = DIM; g.fillText(s[0], col, row);
      g.fillStyle = TXT; g.fillText(String(s[1]), col + 70, row);
    });
    y += 80;

    g.fillStyle = '#9db4c0'; g.font = 'bold 20px Impact, sans-serif';
    g.fillText('UNLOCKED', 40, y); y += 28;
    var C3 = CHLOE.engine.combat3;
    var known = (C3 && C3.knownAbilities) ? C3.knownAbilities(m.id) : [];
    g.font = '17px system-ui, sans-serif';
    known.slice(0, 6).forEach(function (id) {
      var a = (CHLOE.data.abilities || {})[id] || {};
      g.fillStyle = TXT;
      g.fillText((a.icon || '•') + '  ' + (a.name || id), 40, y);
      y += 26;
    });
    var sk = CHLOE.engine.skilltree;
    var nxt = sk && sk.nextRow ? sk.nextRow(m.level) : null;
    if (nxt) {
      g.fillStyle = DIM; g.font = 'italic 15px system-ui, sans-serif';
      g.fillText('Lv ' + nxt.level + ': ' + (nxt.row.name || '—'), 40, H - 40);
    }
    return c;
  }

  /* ---------------- poster: the knight ---------------- */
  function poster() {
    var W = 512, H = 700, c = make(W, H), g = c.getContext('2d');
    var e = (CHLOE.data.enemies || {}).hollow_black_knight || {};
    /* §21: show what he is NOW, not what the data file says he starts as.
       His level is the round you are on and his stats climb with it. */
    var kt = CHLOE.engine.knighttree;
    var kLevel = kt ? kt.level() : (e.level || 2);
    var st = kt ? kt.stats(kLevel, e) : (e.stats || {});
    var kRow = kt ? kt.rowAt(kLevel) : null;
    var known = kt ? kt.patterns(kLevel) : null;
    panel(g, W, H, 'KNOWN: THE HOLLOW', RED);

    var y = H * 0.17;
    g.fillStyle = TXT; g.font = 'bold 34px Impact, "Arial Narrow", sans-serif';
    g.fillText((CHLOE.data.arena3d && CHLOE.data.arena3d.knight
      ? CHLOE.data.arena3d.knight.name : e.name || 'Hollow Black Knight').toUpperCase(), 36, y);
    g.fillStyle = RED; g.font = '20px system-ui, sans-serif';
    g.fillText('Level ' + kLevel + '  ·  ' + (e.type || 'occult') +
               (kRow ? '  ·  ' + kRow.name : ''), 36, y + 30);

    y += 66;
    g.fillStyle = DIM; g.font = '15px system-ui, sans-serif';
    g.fillText('LIFE', 36, y);
    bar(g, 36, y + 8, W - 72, 18, 1, RED);
    g.fillStyle = TXT; g.font = '17px system-ui, sans-serif';
    g.textAlign = 'right'; g.fillText(String(st.life || 48), W - 40, y); g.textAlign = 'left';

    y += 58;
    g.font = '17px system-ui, sans-serif';
    [['ATK', st.atk], ['DEF', st.def], ['SPD', st.spd], ['MAG', st.mag]].forEach(function (s, i) {
      var col = 36 + (i % 2) * ((W - 72) / 2);
      var row = y + Math.floor(i / 2) * 28;
      g.fillStyle = DIM; g.fillText(s[0], col, row);
      g.fillStyle = TXT; g.fillText(String(s[1] || 0), col + 70, row);
    });
    y += 76;

    g.fillStyle = RED; g.font = 'bold 20px Impact, sans-serif';
    g.fillText('HOW HE SWINGS', 36, y); y += 28;
    var pats = (CHLOE.data.arena3d && CHLOE.data.arena3d.patterns) || {};
    for (var id in pats) {
      var pt = pats[id];
      // only the swings he has actually learned by this level
      if (known && known.indexOf(id) === -1) continue;
      g.fillStyle = TXT; g.font = 'bold 18px system-ui, sans-serif';
      g.fillText(pt.name, 36, y);
      g.fillStyle = '#ffd166'; g.font = '15px system-ui, sans-serif';
      g.fillText(pt.hint, 36, y + 20);
      g.fillStyle = DIM; g.font = '14px system-ui, sans-serif';
      g.fillText('wind-up ' + ((pt.telegraphMs || 0) / 1000).toFixed(1) + 's  ·  power ' + (pt.power || 0) + '%',
        36, y + 38);
      y += 62;
    }
    g.fillStyle = DIM; g.font = 'italic 14px system-ui, sans-serif';
    g.fillText('Resists physical. Fire barely scratches him.', 36, H - 36);
    return c;
  }

  /* ---------------- trophy: the round you are on ---------------- */
  /* ONE picture on the dressing-room wall, not a growing row of them. It
     repaints between fights to show the round you are standing in now, with
     the run's record underneath — so the wall reads as a single tally that
     climbs, rather than a gallery that crowds. */
  function trophy() {
    var W = 384, H = 512, c = make(W, H), g = c.getContext('2d');
    var pt = CHLOE.engine.party;
    var rs = (pt && pt.state && pt.state.runStats) || {};
    var cleared = rs.trophies || [];
    var round = rs.round || 1;
    var last = cleared.length ? cleared[cleared.length - 1] : null;
    var felled = 0;
    cleared.forEach(function (e) { felled += e.knights || 0; });

    // aged paper, not the black panel the mirror/poster use — this reads as
    // something pinned up and written on, night after night
    g.fillStyle = '#171114'; g.fillRect(0, 0, W, H);
    var wash = g.createLinearGradient(0, 0, 0, H);
    wash.addColorStop(0, 'rgba(90,60,45,0.30)');
    wash.addColorStop(0.55, 'rgba(30,20,24,0.10)');
    wash.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = wash; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#6b4a2f'; g.lineWidth = 5; g.strokeRect(12, 12, W - 24, H - 24);
    g.strokeStyle = 'rgba(229,23,63,0.55)'; g.lineWidth = 1.5;
    g.strokeRect(21, 21, W - 42, H - 42);

    g.textAlign = 'center';
    g.fillStyle = DIM; g.font = '15px "Consolas", monospace';
    g.fillText('THE NIGHT REMEMBERS', W / 2, 56);

    g.fillStyle = RED; g.font = 'bold 26px Impact, "Arial Narrow", sans-serif';
    g.fillText('ROUND', W / 2, 96);
    g.fillStyle = TXT; g.font = 'bold 122px Impact, "Arial Narrow", sans-serif';
    g.fillText(String(round), W / 2, 208);

    // what is waiting for you THIS round — round N fields N knights
    knightMark(g, W / 2, 282, 54, round);
    g.fillStyle = TXT; g.font = 'bold 19px Impact, "Arial Narrow", sans-serif';
    g.fillText(round + (round === 1 ? ' HOLLOW KNIGHT' : ' HOLLOW KNIGHTS'), W / 2, 350);
    g.fillStyle = RED; g.font = '16px system-ui, sans-serif';
    g.fillText(cleared.length ? 'STILL COMING' : 'WAITING FOR YOU', W / 2, 374);

    // the record so far, kept small — the big number is the point
    g.strokeStyle = 'rgba(107,74,47,0.55)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(48, 400); g.lineTo(W - 48, 400); g.stroke();

    g.fillStyle = DIM; g.font = '15px system-ui, sans-serif';
    if (!cleared.length) {
      g.fillText('Nothing has fallen yet tonight.', W / 2, 430);
    } else {
      g.fillStyle = TXT; g.font = 'bold 17px Impact, "Arial Narrow", sans-serif';
      g.fillText(cleared.length + (cleared.length === 1 ? ' ROUND CLEARED' : ' ROUNDS CLEARED') +
                 '  ·  ' + felled + ' FELLED', W / 2, 428);
      var who = (CHLOE.data.characters || {})[last.by] || {};
      g.fillStyle = DIM; g.font = '14px system-ui, sans-serif';
      g.fillText('round ' + last.round + ' fell to ' + (who.name || last.by || 'you') +
                 (last.hpMax ? ' — ' + last.hpLeft + '/' + last.hpMax + ' life left' : ''),
                 W / 2, 452);
    }
    g.textAlign = 'left';
    return c;
  }

  /* A helm silhouette per knight felled, drawn small so a wide round still
     fits the frame. */
  function knightMark(g, cx, cy, size, count) {
    var n = Math.min(count, 6);
    var step = Math.min(size, 250 / n);
    var startX = cx - (n - 1) * step / 2;
    for (var i = 0; i < n; i++) {
      var x = startX + i * step, s = step * 0.42;
      g.fillStyle = '#0a0709';
      g.strokeStyle = 'rgba(229,23,63,0.75)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x - s * 0.6, cy - s);
      g.quadraticCurveTo(x, cy - s * 1.35, x + s * 0.6, cy - s);
      g.lineTo(x + s * 0.52, cy + s * 0.55);
      g.quadraticCurveTo(x, cy + s * 1.15, x - s * 0.52, cy + s * 0.55);
      g.closePath();
      g.fill(); g.stroke();
      // the empty visor - the whole point of "hollow"
      g.fillStyle = 'rgba(229,23,63,0.9)';
      g.fillRect(x - s * 0.42, cy - s * 0.25, s * 0.84, s * 0.16);
    }
    if (count > n) {
      g.fillStyle = DIM; g.font = 'bold 17px Impact, sans-serif';
      g.textAlign = 'left';
      g.fillText('+' + (count - n), cx + (n * step) / 2 + 6, cy + 6);
      g.textAlign = 'center';
    }
  }

  /* ---------------- stage: the board that announces the fight ----------- */
  /* §24. The south poster stopped being a second knight dossier and became
     this: where the NEXT fight happens, so walking into the room tells you
     what floor you are about to stand on before you engage.

     stage(stageDef, round, knightCount) — every argument optional:
       stageDef    a CHLOE.data.stages entry, or its id as a string, or
                   omitted to resolve it from the round via stagePick
       round       omitted -> party.state.runStats.round (default 1)
       knightCount omitted -> round, because round N fields N knights (§20)
     The engine passes all three when it already knows them (it resolves the
     stage before the arena builds anyway); the room router can call it bare.
     Reading state itself when asked to is deliberate — trophy() does the same,
     and it is what keeps the board from drifting out of step with the round
     counter hanging two walls away. */
  function stage(def, round, knightCount) {
    var W = 512, H = 700, c = make(W, H), g = c.getContext('2d');
    var ACC = ACCENT;
    var pt = CHLOE.engine.party;
    var rs = (pt && pt.state && pt.state.runStats) || {};

    if (round === undefined || round === null) { round = rs.round || 1; }
    round = Math.floor(round); if (!(round >= 1)) { round = 1; }
    if (typeof def === 'string') { def = (CHLOE.data.stages || {})[def] || null; }
    if (!def) {
      var pick = CHLOE.data.stagePick;
      def = pick ? pick.stageForRound(round) : null;
    }
    if (knightCount === undefined || knightCount === null) { knightCount = round; }
    knightCount = Math.max(0, Math.floor(knightCount) || 0);

    panel(g, W, H, 'WHERE IT HAPPENS', ACC);

    if (!def) {
      g.fillStyle = DIM; g.font = '22px system-ui, sans-serif';
      g.fillText('The night has not chosen yet.', 40, H / 2);
      return c;
    }

    /* §26 the picker row: ◀ NAME ▶. The arrows are real buttons — the room
       raycasts this sheet and steps CHLOE.data.stagePick when one is hit —
       so they are painted straight out of STAGE_ARROWS, and the name between
       them is whatever the pick currently resolves to. */
    var rowTop = STAGE_ARROWS.left.y0 * H, rowBot = STAGE_ARROWS.left.y1 * H;
    arrowBtn(g, STAGE_ARROWS.left, -1, W, H);
    arrowBtn(g, STAGE_ARROWS.right, 1, W, H);

    var name = (def.name || def.id || 'Somewhere').toUpperCase();
    var gap = (STAGE_ARROWS.right.x0 - STAGE_ARROWS.left.x1) * W - 24;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = TXT;
    fitPx(g, name, gap, 40, 22, 'Impact, "Arial Narrow", sans-serif');
    g.fillText(name, W / 2, (rowTop + rowBot) / 2);
    g.textBaseline = 'alphabetic';

    g.fillStyle = ACC; g.font = '19px system-ui, sans-serif';
    g.fillText('Round ' + round + '  ·  ' + sizeLine(def), W / 2, rowBot + 26);
    /* Which of the two is talking — the round cycle, or you. A board that
       hid a manual pick would have the player blaming the round counter for
       a floor they chose themselves three rounds ago. */
    var pk = CHLOE.data && CHLOE.data.stagePick;
    var mine = !!(pk && typeof pk.chosen === 'function' && pk.chosen() === def.id);
    g.fillStyle = DIM; g.font = '13px system-ui, sans-serif';
    g.fillText(mine ? 'YOUR PICK  ·  ◀ ▶ TO CHANGE THE FLOOR'
                    : '◀ ▶ CLICK TO CHOOSE THE FLOOR', W / 2, rowBot + 48);
    g.textAlign = 'left';

    var y = rowBot + 78;
    g.fillStyle = DIM; g.font = 'italic 17px system-ui, sans-serif';
    y = wrap(g, def.blurb || '', 36, y, W - 72, 24, 3);

    /* The knight row and the footer are anchored to the BOTTOM and the plan
       takes whatever is left, rather than everything flowing down from the
       blurb. A two-line blurb was already pushing the count into the footer,
       and a stage author writing a long one should cost the diagram a few
       pixels — never overlap the thing that says how many are coming. */
    var kY = H - 204;
    var box = { x: 36, y: y + 14, w: W - 72, h: Math.max(150, kY - 20 - (y + 14)) };
    plan(g, box, def);

    g.fillStyle = ACC; g.font = 'bold 20px Impact, sans-serif';
    g.fillText('WAITING FOR YOU', 36, kY);
    g.textAlign = 'center';
    knightMark(g, W / 2, H - 148, 46, knightCount);
    g.fillStyle = TXT; g.font = 'bold 19px Impact, "Arial Narrow", sans-serif';
    g.fillText(knightCount + (knightCount === 1 ? ' HOLLOW KNIGHT' : ' HOLLOW KNIGHTS'),
      W / 2, H - 92);
    g.textAlign = 'left';

    // what actually stops you at the edge — the two stages contain you by
    // different machinery (§24) and it changes how the edge behaves
    g.fillStyle = DIM; g.font = 'italic 14px system-ui, sans-serif';
    g.fillText(def.shape === 'round'
      ? 'The kerb turns you back. There is nothing beyond it.'
      : 'Stone stops you. Learn where it stands.', 36, H - 36);
    return c;
  }

  /* One picker button: a soft plate, an amber rule, and a triangle pointing
     the way it steps. dir < 0 points left. */
  function arrowBtn(g, r, dir, W, H) {
    var x = r.x0 * W, yTop = r.y0 * H;
    var w = (r.x1 - r.x0) * W, h = (r.y1 - r.y0) * H;
    var cx = x + w / 2, cy = yTop + h / 2;
    g.fillStyle = 'rgba(255,209,102,0.10)';
    g.fillRect(x, yTop, w, h);
    g.strokeStyle = ACCENT_DIM; g.lineWidth = 3;
    g.strokeRect(x, yTop, w, h);
    var tw = w * 0.30, th = h * 0.32;
    g.beginPath();
    if (dir < 0) {
      g.moveTo(cx - tw, cy);
      g.lineTo(cx + tw * 0.72, cy - th);
      g.lineTo(cx + tw * 0.72, cy + th);
    } else {
      g.moveTo(cx + tw, cy);
      g.lineTo(cx - tw * 0.72, cy - th);
      g.lineTo(cx - tw * 0.72, cy + th);
    }
    g.closePath();
    g.fillStyle = ACCENT; g.fill();
  }

  /* Shrink until it fits. The picker row is a fixed width between two
     buttons and a stage name is authored data, so the longest name loses
     points — never the arrows. Leaves the font set on the context. */
  function fitPx(g, text, maxW, startPx, minPx, family) {
    var px = startPx;
    for (;;) {
      g.font = 'bold ' + px + 'px ' + family;
      if (px <= minPx || g.measureText(text).width <= maxW) { return px; }
      px -= 2;
    }
  }

  /* The engine asks for the buttons rather than being told them, and gets a
     COPY: a caller that reached in and moved a hot spot would move the
     click target without moving the arrow anybody can see. */
  function stageArrows() {
    function box(r) { return { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }; }
    return { left: box(STAGE_ARROWS.left), right: box(STAGE_ARROWS.right) };
  }

  function sizeLine(def) {
    var a = def.arena || {};
    var area = def.area ? '~' + def.area + ' m²' : '';
    if (def.shape === 'round' && a.radius) {
      return Math.round(a.radius * 2) + ' m across' + (area ? '  ·  ' + area : '');
    }
    var b = a.bounds;
    if (b) {
      return Math.round(b.maxX - b.minX) + ' × ' + Math.round(b.maxZ - b.minZ) + ' m' +
             (area ? '  ·  ' + area : '');
    }
    return area || 'unmeasured';
  }

  /* Word wrap that returns the next free y, so the caller can lay out what
     follows. `maxLines` truncates with an ellipsis instead of running on: the
     blurb is meant to be one line (§24) and a board that swallows its own
     diagram to fit somebody's paragraph is worse than a clipped sentence. */
  function wrap(g, text, x, y, maxW, lh, maxLines) {
    var words = String(text).split(' '), line = '', lines = [], i;
    for (i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (g.measureText(test).width > maxW && line) { lines.push(line); line = words[i]; }
      else { line = test; }
    }
    if (line) { lines.push(line); }
    if (maxLines && lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = lines[maxLines - 1].replace(/[\s,.;:—-]+$/, '') + '…';
    }
    for (i = 0; i < lines.length; i++) { g.fillText(lines[i], x, y); y += lh; }
    return y;
  }

  /* ---- the plan diagram ----
     Top-down, world +X to the right and world +Z down the page, so the two
     spawn pips are placed from the SAME numbers the arena spawns from — a
     hand-drawn picture would be free to lie about which side you start on. */
  function plan(g, box, def) {
    var a = def.arena || {};
    var cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    var s, ox = 0, oz = 0;

    if (def.shape === 'round') {
      var R = Math.min(box.w, box.h) / 2 - 16;
      s = R / (a.radius || 14);
    } else {
      var b = a.bounds || { minX: -9, maxX: 9, minZ: -9, maxZ: 9 };
      ox = (b.minX + b.maxX) / 2; oz = (b.minZ + b.maxZ) / 2;
      s = Math.min((box.w - 32) / (b.maxX - b.minX), (box.h - 32) / (b.maxZ - b.minZ));
    }
    function px(x) { return cx + (x - ox) * s; }
    function pz(z) { return cy + (z - oz) * s; }

    if (def.shape === 'round') { drawRoundPlan(g, cx, cy, (a.radius || 14) * s, def); }
    else { drawNavePlan(g, px, pz, s, a.bounds); }

    if (def.playerSpawn) { pip(g, px(def.playerSpawn.x), pz(def.playerSpawn.z), '#9db4c0', 'YOU'); }
    if (def.knightSpawn) { pip(g, px(def.knightSpawn.x), pz(def.knightSpawn.z), RED, 'HIM'); }
  }

  function drawRoundPlan(g, cx, cy, r, def) {
    var bld = def.build || {};
    var floor = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    floor.addColorStop(0, 'rgba(150,150,158,0.22)');
    floor.addColorStop(1, 'rgba(90,92,102,0.10)');
    g.fillStyle = floor;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    // the kerb: the one thing on the whole stage
    g.strokeStyle = ACCENT_DIM; g.lineWidth = 5;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    // the rim pylons, drawn at their real count so the picture and the floor
    // agree about how many lights you can navigate by
    var pyl = bld.pylons || {}, n = pyl.count || 12, every = pyl.litEvery || 1;
    var pr = r * ((pyl.radius || 15.6) / ((def.arena && def.arena.radius) || 14));
    for (var i = 0; i < n; i++) {
      var ang = (i / n) * Math.PI * 2;
      var x = cx + Math.cos(ang) * pr, y = cy + Math.sin(ang) * pr;
      var lit = (i % every) === 0;
      g.fillStyle = lit ? '#ff8a2a' : 'rgba(255,138,42,0.35)';
      g.beginPath(); g.arc(x, y, lit ? 5 : 3, 0, Math.PI * 2); g.fill();
    }
  }

  /* The church from above: the long nave, the apse toward +X, and the block of
     stone in the middle that the navgrid bake proved was there (§20) — which
     is the whole reason the fight happens in the band to one side of it. */
  function drawNavePlan(g, px, pz, s, b) {
    if (!b) { return; }
    var x0 = px(b.minX), x1 = px(b.maxX), z0 = pz(b.minZ), z1 = pz(b.maxZ);
    var w = x1 - x0, h = z1 - z0;
    g.fillStyle = 'rgba(150,150,158,0.16)';
    g.beginPath();
    g.moveTo(x0, z0);
    g.lineTo(x1 - w * 0.10, z0);
    g.quadraticCurveTo(x1 + w * 0.06, z0 + h / 2, x1 - w * 0.10, z1);  // apse, +X
    g.lineTo(x0, z1);
    g.closePath();
    g.fill();
    g.strokeStyle = ACCENT_DIM; g.lineWidth = 4; g.stroke();
    // the rood screen / altar block: solid, dead centre, not walkable
    g.fillStyle = 'rgba(229,23,63,0.22)';
    g.strokeStyle = 'rgba(229,23,63,0.55)'; g.lineWidth = 2;
    g.fillRect(px(-1.6), pz(-1.4), 4.6 * s, 3.6 * s);
    g.strokeRect(px(-1.6), pz(-1.4), 4.6 * s, 3.6 * s);
    // two rows of columns, the pinch points you fight around
    g.fillStyle = 'rgba(200,200,210,0.35)';
    for (var i = 0; i < 4; i++) {
      var x = -6.5 + i * 4.2;
      g.beginPath(); g.arc(px(x), pz(-4.2), 3.5, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(px(x), pz(3.6), 3.5, 0, Math.PI * 2); g.fill();
    }
  }

  function pip(g, x, y, color, label) {
    g.fillStyle = color;
    g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2; g.stroke();
    g.fillStyle = color; g.font = 'bold 13px Impact, sans-serif';
    g.textAlign = 'center';
    g.fillText(label, x, y - 13);
    g.textAlign = 'left';
  }

  /* ---------------- TV: the how-to programme ---------------- */
  var CHAPTERS = [
    { t: 'THE LONG NIGHT', l: ['A programme in six parts.', '', 'Everything you need to survive', 'the Backstage Between.', '', 'Click the TV to turn the page.'] },
    { t: 'CH 1 — THE ROOM', l: ['WASD walks. The mouse looks —', 'click the room to take the view.', '', 'Ctrl or C crouches.', 'Space jumps. Shift sprints.', '', 'Left click closes your left hand,', 'right click the right one.'] },
    { t: 'CH 2 — YOUR HANDS', l: ['Anything glinting red can be taken.', '', 'Look at it, click, and your hand', 'reaches out and picks it up.', '', 'The vanity and the couch are', 'hiding something tonight.'] },
    { t: 'CH 3 — THE CHURCH', l: ['Walk into the thing in the room', 'and it drags you somewhere old.', '', 'The fight is REAL TIME.', 'Nothing waits for your turn.', '', 'Keys 1-9 are your abilities.'] },
    { t: 'CH 4 — DODGING', l: ['He tells you what is coming.', '', 'WIDE SLASH  -> crouch under it', 'OVERHEAD    -> step out of the lane', 'HOLLOW CHARGE -> move, now', '', 'SPACE evades and briefly', 'makes you untouchable.'] },
    { t: 'CH 5 — GETTING STRONGER', l: ['One road, walked by everyone.', '', 'Lv 1  your fists', 'Lv 2  Fire Tornado', 'Lv 3  Ash finds you', 'Lv 4  a second keybind', '', 'Reach the level, gain the row.', 'Nothing to spend.'] },
    { t: 'CH 6 — DYING', l: ['Nothing is saved. Ever.', '', 'If your leader falls and someone', 'is still standing, they take over', 'mid-swing and keep going.', '', 'When everyone falls, the night', 'starts again at level one.'] }
  ];

  function tv(chapter) {
    var W = 512, H = 384, c = make(W, H), g = c.getContext('2d');
    var ch = CHAPTERS[((chapter | 0) % CHAPTERS.length + CHAPTERS.length) % CHAPTERS.length];
    g.fillStyle = '#06080a'; g.fillRect(0, 0, W, H);
    // scanlines + a soft CRT glow
    var glow = g.createRadialGradient(W / 2, H / 2, 20, W / 2, H / 2, H);
    glow.addColorStop(0, 'rgba(120,200,255,0.10)');
    glow.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = glow; g.fillRect(0, 0, W, H);

    g.fillStyle = '#8fe3ff';
    g.font = 'bold 30px Impact, "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.fillText(ch.t, W / 2, 52);
    g.textAlign = 'left';
    g.fillStyle = '#cfeaff';
    g.font = '19px "Consolas", monospace';
    var y = 96;
    ch.l.forEach(function (line) { g.fillText(line, 42, y); y += 27; });

    g.fillStyle = '#6aa9c8'; g.font = '14px "Consolas", monospace';
    g.fillText('part ' + ((chapter | 0) % CHAPTERS.length + 1) + ' / ' + CHAPTERS.length, 42, H - 22);
    g.textAlign = 'right';
    g.fillText('click to continue', W - 42, H - 22);
    g.textAlign = 'left';

    for (var i = 0; i < H; i += 3) {
      g.fillStyle = 'rgba(0,0,0,0.16)';
      g.fillRect(0, i, W, 1);
    }
    return c;
  }

  return { mirror: mirror, poster: poster, tv: tv, trophy: trophy, stage: stage,
           stageArrows: stageArrows, chapterCount: CHAPTERS.length };
})();
