/* CHLOE — data/elements.js (Progression v3, spec sec 12)
   11 damage types. CHLOE.data.types is authoritative; CHLOE.data.elements stays
   as a back-compat shim for un-migrated v1/v2 callers (old element names accepted
   everywhere via OLDMAP). Full chart + rationale documented in tools/typechart.md. */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.types = (function(){
  'use strict';

  var TYPES = ['physical','magical','lightning','fire','occult','blood','poison',
               'divine','virus','ghost','biological'];

  /* v1/v2 element names -> v3 types (spec-mandated migration). */
  var OLDMAP = { none:'physical', ember:'fire', volt:'lightning',
                 shadow:'occult', light:'divine', frost:'magical' };

  /* Sparse 11x11 chart: CHART[attacker][defender]; anything missing = 1.0.
     Every row has 2-3 offensive strengths (2.0) and 2-3 weaknesses (0.5).
     Mandatory anchors honored: occult<->divine mutual 2.0; ghost resists
     physical/blood/poison + takes 2.0 from divine/magical; biological takes 2.0
     from fire/poison/virus; virus takes 2.0 from fire/divine. */
  var CHART = {
    physical:   { lightning:2.0, occult:2.0,                magical:0.5, blood:0.5, ghost:0.5 },
    magical:    { physical:2.0, ghost:2.0,                  divine:0.5, virus:0.5 },
    lightning:  { physical:2.0, blood:2.0,                  occult:0.5, divine:0.5 },
    fire:       { poison:2.0, virus:2.0, biological:2.0,    occult:0.5, blood:0.5 },
    occult:     { magical:2.0, divine:2.0,                  virus:0.5, biological:0.5 },
    blood:      { fire:2.0, divine:2.0, virus:2.0,          physical:0.5, ghost:0.5 },
    poison:     { blood:2.0, biological:2.0,                physical:0.5, ghost:0.5 },
    divine:     { occult:2.0, virus:2.0, ghost:2.0,         physical:0.5, biological:0.5 },
    virus:      { blood:2.0, biological:2.0,                physical:0.5, fire:0.5, divine:0.5 },
    ghost:      { physical:2.0, ghost:2.0,                  occult:0.5, divine:0.5 },
    biological: { poison:2.0, biological:2.0,               physical:0.5, ghost:0.5 }
  };

  /* Statuses tied to types (buildup system, spec sec 12). */
  var STATUS_OF_TYPE = { fire:'burn', lightning:'shock', blood:'bleed', poison:'poisoned',
                         occult:'curse', virus:'infection', ghost:'haunt' };

  var LABELS = { physical:'Physical', magical:'Magical', lightning:'Lightning', fire:'Fire',
                 occult:'Occult', blood:'Blood', poison:'Poison', divine:'Divine',
                 virus:'Virus', ghost:'Ghost', biological:'Biological' };

  var ICONS = { physical:'⚔', magical:'✧', lightning:'⚡', fire:'🔥', occult:'🌑',
                blood:'🩸', poison:'☠', divine:'✦', virus:'🦠', ghost:'👻', biological:'🧬' };

  /* UI hint colors (type dots on move buttons / resistance grids). */
  var COLORS = { physical:'#9a939c', magical:'#8a63e8', lightning:'#f0d24a', fire:'#f06423',
                 occult:'#6a4a8c', blood:'#a11228', poison:'#4fae3d', divine:'#f2e6b3',
                 virus:'#57c7b8', ghost:'#9fb8c9', biological:'#c98d4a' };

  /* Any old/new/unknown name -> canonical v3 type. Unknown/empty -> 'physical'. */
  function migrate(t){
    t = (t == null ? 'physical' : String(t)).toLowerCase();
    if (OLDMAP.hasOwnProperty(t)) t = OLDMAP[t];
    return CHART.hasOwnProperty(t) ? t : 'physical';
  }

  /* multiplier(atkType, defender) -> number.
     defender: a plain type string (old or new names) OR an object
     { type, resists:{type:mult} } — an explicit resists entry overrides the chart.
     (Objects with only a legacy `element` field also work.) */
  function multiplier(atkType, defender){
    var atk = migrate(atkType);
    var defType, resists = null;
    if (defender && typeof defender === 'object'){
      defType = migrate(defender.type != null ? defender.type : defender.element);
      resists = defender.resists || null;
    } else {
      defType = migrate(defender);
    }
    if (resists){
      for (var k in resists){
        if (resists.hasOwnProperty(k) && typeof resists[k] === 'number' && migrate(k) === atk){
          return resists[k];
        }
      }
    }
    var row = CHART[atk];
    return (row && row.hasOwnProperty(defType)) ? row[defType] : 1.0;
  }

  return {
    list: TYPES,
    CHART: CHART,
    OLDMAP: OLDMAP,
    STATUS_OF_TYPE: STATUS_OF_TYPE,
    labels: LABELS,
    icons: ICONS,
    colors: COLORS,
    migrate: migrate,
    multiplier: multiplier
  };
})();

/* Back-compat shim: un-migrated v1/v2 callers keep working.
   multiplier delegates to types.multiplier (OLDMAP applied inside it);
   labels/icons carry both old and new keys because current UI files
   (battleui.js, menu.js, loadout.js) still read CHLOE.data.elements.labels. */
CHLOE.data.elements = (function(types){
  'use strict';
  var labels = {}, icons = {}, k;
  for (k in types.labels){ if (types.labels.hasOwnProperty(k)) labels[k] = types.labels[k]; }
  for (k in types.icons){ if (types.icons.hasOwnProperty(k)) icons[k] = types.icons[k]; }
  for (k in types.OLDMAP){
    if (types.OLDMAP.hasOwnProperty(k)){
      labels[k] = types.labels[types.OLDMAP[k]];
      icons[k]  = types.icons[types.OLDMAP[k]];
    }
  }
  labels.none = '—'; icons.none = '·'; /* neutral basic attacks keep their old look */
  return {
    list: types.list,
    labels: labels,
    icons: icons,
    multiplier: function(att, def){ return types.multiplier(att, def); }
  };
})(CHLOE.data.types);
