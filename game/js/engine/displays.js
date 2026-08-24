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

  return { mirror: mirror, poster: poster, tv: tv, trophy: trophy,
           chapterCount: CHAPTERS.length };
})();
