/* CHLOE — engine/save.js
   Accounts:  localStorage['chloe.accounts']  = { <lowername>: {name, pinHash, createdAt} }
   Saves:     localStorage['chloe.save.'+name] (name lowercased)
   Save blob v:3 (Progression v3): on top of v:2 loadouts it adds
     skillPoints:{charId:n}, tree:{charId:[nodeIds]}, and per-member sta/faith
     resource snapshots (hp stays = life, mp stays = magic).
   v:1/v:2 blobs are migrated silently on read — shape here (skillPoints seeded
   to level-1 per member, tree {}, sta/faith left for party.applyBlob to fill
   from base+growth), content in party.applyBlob (loadouts via
   progression.sanitizeLoadouts; tree node ids validated via
   tree.sanitizeState — unknown ids dropped, points refunded).
   pinHash = SHA-256(lower(name)+':'+pin) via WebCrypto (async, with pure-JS fallback
   so file:// contexts without crypto.subtle never throw).
   Cloud sync: only when CHLOE.data.config.apiUrl is non-empty; always fails silently. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.save = (function(){
  'use strict';

  var ACCOUNTS_KEY = 'chloe.accounts';
  var SAVE_PREFIX  = 'chloe.save.';
  var current = null; // {name, pinHash}

  function cfg(){ return (CHLOE.data && CHLOE.data.config) || {}; }

  /* ---------- storage helpers (never throw) ---------- */
  function lsGet(key){
    try { return window.localStorage.getItem(key); } catch(e){ return null; }
  }
  function lsSet(key, val){
    try { window.localStorage.setItem(key, val); return true; } catch(e){ return false; }
  }
  function jsonParse(str, fallback){
    if (!str) return fallback;
    try { return JSON.parse(str); } catch(e){ return fallback; }
  }

  /* ---------- SHA-256 ---------- */
  function sha256Hex(str){
    // WebCrypto path (async)
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      var buf = new TextEncoder().encode(str);
      return window.crypto.subtle.digest('SHA-256', buf).then(function(hash){
        var bytes = new Uint8Array(hash), hex = '';
        for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
        return hex;
      }).catch(function(){ return Promise.resolve(sha256HexSync(str)); });
    }
    return Promise.resolve(sha256HexSync(str));
  }

  // Compact pure-JS SHA-256 fallback (public-domain style implementation).
  function sha256HexSync(ascii){
    function rightRotate(v, a){ return (v >>> a) | (v << (32 - a)); }
    var mathPow = Math.pow, maxWord = mathPow(2, 32), result = '';
    var words = [], asciiBitLength = ascii.length * 8;
    var hash = [], k = [], primeCounter = 0;
    var isComposite = {}, candidate, i, j;
    for (candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    // UTF-8 encode
    ascii = unescape(encodeURIComponent(ascii));
    asciiBitLength = ascii.length * 8;
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16);
      var oldHash = hash.slice(0);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ (~e & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? w[i] : (
              w[i - 16]
              + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
              + w[i - 7]
              + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
            ) | 0);
        var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  function pinHashFor(name, pin){
    return sha256Hex(String(name).toLowerCase() + ':' + String(pin));
  }

  /* ---------- accounts ---------- */
  function accounts(){
    return jsonParse(lsGet(ACCOUNTS_KEY), {}) || {};
  }
  function writeAccounts(map){
    lsSet(ACCOUNTS_KEY, JSON.stringify(map));
  }
  function accountList(){
    var map = accounts(), out = [];
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(map[k]);
    out.sort(function(a, b){ return (b.createdAt || 0) - (a.createdAt || 0); });
    return out;
  }
  function validName(name){
    return typeof name === 'string' && name.length >= 1 && name.length <= 16;
  }
  function validPin(pin){
    return /^[0-9]{4}$/.test(String(pin));
  }

  function createAccount(name, pin){
    name = String(name || '').trim();
    if (!validName(name)) return Promise.resolve({ ok: false, error: 'Name must be 1-16 characters.' });
    if (!validPin(pin))   return Promise.resolve({ ok: false, error: 'PIN must be exactly 4 digits.' });
    var key = name.toLowerCase();
    var map = accounts();
    if (map[key]) return Promise.resolve({ ok: false, error: 'That name is already taken.' });
    return pinHashFor(name, pin).then(function(hash){
      map[key] = { name: name, pinHash: hash, createdAt: Date.now() };
      writeAccounts(map);
      current = { name: name, pinHash: hash };
      cloudRegister(); // fire & forget
      return { ok: true, name: name };
    });
  }

  function login(name, pin){
    var key = String(name || '').toLowerCase();
    var map = accounts();
    var acc = map[key];
    if (!acc) return Promise.resolve({ ok: false, error: 'No such account.' });
    return pinHashFor(acc.name, pin).then(function(hash){
      if (hash !== acc.pinHash) return { ok: false, error: 'Wrong PIN.' };
      current = { name: acc.name, pinHash: acc.pinHash };
      return { ok: true, name: acc.name };
    });
  }

  function logout(){
    current = null;
  }
  function getCurrent(){ return current; }

  /* ---------- save blobs ---------- */
  function saveKey(name){ return SAVE_PREFIX + String(name).toLowerCase(); }

  function buildBlob(){
    if (!current) return null;
    var party = CHLOE.engine.party, inv = CHLOE.engine.inventory;
    var blob = {
      v: 3,
      name: current.name,
      savedAt: Date.now(),
      party: [], activeId: null, inventory: {}, shards: 0, flags: {}, scene: null,
      loadouts: {}, skillPoints: {}, tree: {}
    };
    if (party && party.state) {
      var st = party.state;
      blob.party = st.members.map(function(m){
        return { id: m.id, level: m.level, xp: m.xp, hp: m.hp, mp: m.mp,
                 sta: (typeof m.stamina === 'number') ? m.stamina : 0,
                 faith: (typeof m.faith === 'number') ? m.faith : 0,
                 weaponId: m.weaponId };
      });
      blob.activeId = st.activeId;
      blob.shards = st.shards;
      blob.flags = st.flags || {};
      blob.scene = st.scene;
      try { blob.loadouts = JSON.parse(JSON.stringify(st.loadouts || {})); }
      catch(e){ blob.loadouts = {}; }
      try { blob.skillPoints = JSON.parse(JSON.stringify(st.skillPoints || {})); }
      catch(e){ blob.skillPoints = {}; }
      try { blob.tree = JSON.parse(JSON.stringify(st.tree || {})); }
      catch(e){ blob.tree = {}; }
    }
    if (inv) blob.inventory = inv.serialize();
    return blob;
  }

  /* Silent v1/v2 -> v3 migration + shape validation. Never throws, never warns.
     Loadout CONTENT is validated in party.applyBlob (rebuilds from defaults);
     tree node ids are validated there too via tree.sanitizeState (unknown ids
     dropped, points refunded). Pre-v3 blobs: skillPoints = level-1 per member
     (all points refunded), tree empty; sta/faith snapshots are absent and get
     filled from base+growth (life=hp, magic=mp mapping is implicit — the
     runtime keeps using hp/mp as the life/magic pools). */
  function migrate(blob){
    if (!blob || typeof blob !== 'object') return null;
    var wasPreV3 = !(blob.v >= 3);
    if (!Array.isArray(blob.party)) blob.party = [];
    if (!blob.inventory || typeof blob.inventory !== 'object' || Array.isArray(blob.inventory)) blob.inventory = {};
    if (!blob.flags || typeof blob.flags !== 'object' || Array.isArray(blob.flags)) blob.flags = {};
    if (!blob.loadouts || typeof blob.loadouts !== 'object' || Array.isArray(blob.loadouts)) blob.loadouts = {};
    if (!blob.skillPoints || typeof blob.skillPoints !== 'object' || Array.isArray(blob.skillPoints)) blob.skillPoints = {};
    if (!blob.tree || typeof blob.tree !== 'object' || Array.isArray(blob.tree)) blob.tree = {};
    if (wasPreV3) {
      // refund everything: points = level-1 each, tree stays empty
      for (var i = 0; i < blob.party.length; i++) {
        var p = blob.party[i];
        if (p && p.id && typeof blob.skillPoints[p.id] !== 'number') {
          blob.skillPoints[p.id] = Math.max(0, (p.level || 1) - 1);
        }
      }
    }
    blob.v = 3;
    return blob;
  }

  function hasSave(name){
    return !!lsGet(saveKey(name));
  }
  function readLocal(name){
    return migrate(jsonParse(lsGet(saveKey(name)), null));
  }
  function writeLocal(blob){
    if (!blob || !blob.name) return false;
    return lsSet(saveKey(blob.name), JSON.stringify(blob));
  }

  function saveNow(){
    var blob = buildBlob();
    if (!blob) return null;
    writeLocal(blob);
    cloudSave(blob); // fire & forget
    return blob;
  }
  // Autosave: called on scene change & battle end.
  function autosave(){
    return saveNow();
  }
  function deleteLocal(name){
    try { window.localStorage.removeItem(saveKey(name)); } catch(e){}
  }

  /* ---------- cloud sync (silent no-ops when apiUrl === '') ---------- */
  function api(){ var u = cfg().apiUrl; return (typeof u === 'string' && u.length) ? u.replace(/\/+$/, '') : ''; }

  function cloudPost(path, payload){
    var base = api();
    if (!base || !window.fetch) return Promise.resolve(null);
    try {
      return window.fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function(res){
        if (!res || !res.ok) return null;
        return res.json().catch(function(){ return null; });
      }).catch(function(){ return null; });
    } catch(e){ return Promise.resolve(null); }
  }

  function cloudRegister(){
    if (!current) return Promise.resolve(null);
    return cloudPost('/register', { name: current.name, pinHash: current.pinHash });
  }
  function cloudLogin(){
    if (!current) return Promise.resolve(null);
    return cloudPost('/login', { name: current.name, pinHash: current.pinHash });
  }
  function cloudSave(blob){
    if (!current) return Promise.resolve(null);
    blob = blob || buildBlob();
    if (!blob) return Promise.resolve(null);
    return cloudPost('/save', { name: current.name, pinHash: current.pinHash, save: blob });
  }
  // Resolves with the freshest blob (local vs cloud, by savedAt), merging cloud->local if newer.
  function cloudLoad(){
    if (!current) return Promise.resolve(null);
    var local = readLocal(current.name);
    return cloudPost('/load', { name: current.name, pinHash: current.pinHash }).then(function(res){
      var remote = res && res.save ? migrate(res.save) : null;
      if (remote && (!local || (remote.savedAt || 0) > (local.savedAt || 0))) {
        writeLocal(remote);
        return remote;
      }
      return local;
    });
  }

  return {
    sha256Hex: sha256Hex,
    pinHashFor: pinHashFor,
    accounts: accounts,
    accountList: accountList,
    validName: validName,
    validPin: validPin,
    createAccount: createAccount,
    login: login,
    logout: logout,
    getCurrent: getCurrent,
    hasSave: hasSave,
    readLocal: readLocal,
    writeLocal: writeLocal,
    deleteLocal: deleteLocal,
    buildBlob: buildBlob,
    migrate: migrate,
    saveNow: saveNow,
    autosave: autosave,
    cloudRegister: cloudRegister,
    cloudLogin: cloudLogin,
    cloudSave: cloudSave,
    cloudLoad: cloudLoad
  };
})();
