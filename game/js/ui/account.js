/* CHLOE — ui/account.js
   Account list / create (name + 4-digit PIN pad) / login with PIN pad. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.account = (function(){
  'use strict';
  var ui, save;
  var mode = 'list';          // 'list' | 'create' | 'login'
  var pin = '';
  var pendingName = '';       // account being logged into / created
  var busy = false;

  function root(){ return ui.byId('screen-account'); }

  function open(){
    ui = CHLOE.ui; save = CHLOE.engine.save;
    mode = 'list'; pin = ''; pendingName = ''; busy = false;
    render();
    ui.show('account');
  }

  function render(err){
    var r = ui.clear(root());
    var card = ui.el('div', 'account-card');

    if (mode === 'list') renderList(card);
    else if (mode === 'create') renderCreate(card, err);
    else if (mode === 'login') renderLogin(card, err);

    r.appendChild(card);
  }

  /* ---------- list ---------- */
  function renderList(card){
    card.appendChild(ui.el('h2', null, 'Who’s playing?'));
    card.appendChild(ui.el('div', 'sub', 'Saves live in this browser. PIN keeps your sisters out.'));

    var accounts = save.accountList();
    var list = ui.el('div', 'account-list');
    if (!accounts.length) {
      list.appendChild(ui.el('div', 'account-empty', 'No accounts yet. Start your first night.'));
    }
    accounts.forEach(function(acc){
      var row = ui.el('button', 'account-row');
      row.appendChild(ui.el('span', 'nm', acc.name));
      row.appendChild(ui.el('span', 'meta', save.hasSave(acc.name) ? 'Continue ▸' : 'New night ▸'));
      row.addEventListener('click', function(){
        pendingName = acc.name; pin = ''; mode = 'login'; render();
      });
      list.appendChild(row);
    });
    card.appendChild(list);

    var actions = ui.el('div', 'account-actions');
    var create = ui.el('button', null, '+ New account');
    create.addEventListener('click', function(){ pendingName = ''; pin = ''; mode = 'create'; render(); });
    actions.appendChild(create);
    card.appendChild(actions);
  }

  /* ---------- PIN pad ---------- */
  function renderPinPad(card, onComplete){
    var dots = ui.el('div', 'pin-dots');
    for (var i = 0; i < 4; i++) {
      dots.appendChild(ui.el('div', 'pin-dot' + (i < pin.length ? ' on' : '')));
    }
    card.appendChild(dots);

    var pad = ui.el('div', 'pin-pad');
    var keys = ['1','2','3','4','5','6','7','8','9','C','0','⌫'];
    keys.forEach(function(k){
      var b = ui.el('button', null, k);
      b.addEventListener('click', function(){
        if (busy) return;
        if (k === 'C') pin = '';
        else if (k === '⌫') pin = pin.slice(0, -1);
        else if (pin.length < 4) pin += k;
        refreshDots(dots);
        if (pin.length === 4) onComplete();
      });
      pad.appendChild(b);
    });
    card.appendChild(pad);
    return dots;
  }
  function refreshDots(dots){
    for (var i = 0; i < dots.children.length; i++) {
      dots.children[i].className = 'pin-dot' + (i < pin.length ? ' on' : '');
    }
  }
  function failPin(msg){
    pin = '';
    busy = false;
    var card = root().querySelector('.account-card');
    if (card) {
      card.classList.remove('pinpad-shake');
      void card.offsetWidth; // restart animation
      card.classList.add('pinpad-shake');
    }
    render(msg);
  }

  /* ---------- create ---------- */
  function renderCreate(card, err){
    card.appendChild(ui.el('h2', null, 'New Account'));
    card.appendChild(ui.el('div', 'sub', 'Pick a name (1–16 chars) and a 4-digit PIN.'));

    var row = ui.el('div', 'form-row');
    row.appendChild(ui.el('label', null, 'Name'));
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 16;
    input.placeholder = 'e.g. Chloe';
    input.value = pendingName;
    input.addEventListener('input', function(){ pendingName = input.value; });
    row.appendChild(input);
    card.appendChild(row);

    var lab = ui.el('div', 'form-row');
    lab.appendChild(ui.el('label', null, 'PIN'));
    card.appendChild(lab);

    renderPinPad(card, function(){
      var name = (pendingName || '').trim();
      if (!save.validName(name)) { failPin('Name must be 1-16 characters.'); return; }
      busy = true;
      save.createAccount(name, pin).then(function(res){
        busy = false;
        if (!res.ok) { failPin(res.error || 'Could not create account.'); return; }
        ui.toast('Welcome, ' + res.name + '.');
        CHLOE.game.startNew();
      });
    });

    card.appendChild(ui.el('div', 'form-err', err || ''));
    var back = ui.el('button', 'link-btn', '‹ Back');
    back.addEventListener('click', function(){ mode = 'list'; pin = ''; render(); });
    card.appendChild(back);

    window.setTimeout(function(){ try { input.focus(); } catch(e){} }, 50);
  }

  /* ---------- login ---------- */
  function renderLogin(card, err){
    card.appendChild(ui.el('h2', null, pendingName));
    card.appendChild(ui.el('div', 'sub', 'Enter your 4-digit PIN.'));

    renderPinPad(card, function(){
      busy = true;
      save.login(pendingName, pin).then(function(res){
        if (!res.ok) { failPin(res.error || 'Wrong PIN.'); return; }
        busy = false;
        // cloud login + newest-save merge are silent no-ops in local mode
        save.cloudLogin();
        save.cloudLoad().then(function(blob){
          if (blob) CHLOE.game.continueFrom(blob);
          else CHLOE.game.startNew();
        });
      });
    });

    card.appendChild(ui.el('div', 'form-err', err || ''));
    var back = ui.el('button', 'link-btn', '‹ Back');
    back.addEventListener('click', function(){ mode = 'list'; pin = ''; render(); });
    card.appendChild(back);
  }

  return { open: open };
})();
