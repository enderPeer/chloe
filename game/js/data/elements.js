/* CHLOE — data/elements.js
   ember > frost > volt > ember (2.0x along the arrow, 0.5x against it).
   shadow <-> light deal 2.0x to each other. Everything else 1.0x. */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.elements = (function(){
  'use strict';
  var beats = { ember:'frost', frost:'volt', volt:'ember' };

  function multiplier(att, def){
    att = att || 'none'; def = def || 'none';
    if (att === 'none' || def === 'none') return 1.0;
    if (beats[att] === def) return 2.0;
    if (beats[def] === att) return 0.5;
    if ((att === 'shadow' && def === 'light') || (att === 'light' && def === 'shadow')) return 2.0;
    return 1.0;
  }

  return {
    list: ['none','ember','frost','volt','shadow','light'],
    labels: { none:'—', ember:'Ember', frost:'Frost', volt:'Volt', shadow:'Shadow', light:'Light' },
    icons:  { none:'·', ember:'🔥', frost:'❄', volt:'⚡', shadow:'🌑', light:'✦' },
    beats: beats,
    multiplier: multiplier
  };
})();
