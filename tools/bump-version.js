#!/usr/bin/env node
/* CHLOE — tools/bump-version.js
   Bumps the version the game displays (game/js/data/version.js).

   Usage:
     node tools/bump-version.js                 bump build   (every push)
     node tools/bump-version.js --minor 24      new spec section: minor=24, build=0
     node tools/bump-version.js --label "Name"  rename the drop
     node tools/bump-version.js --print         show the current version, change nothing

   It rewrites ONLY the `minor:`, `build:`, `date:` and `label:` lines, by
   targeted regex rather than reserialising the file, so the comments and the
   string()/full() helpers can never be clobbered by the bumper. Exits non-zero
   if a field it was asked to change could not be found — a silent no-op here
   would mean shipping a build whose version lies about being new. */
'use strict';
var fs = require('fs');
var path = require('path');

var FILE = path.join(__dirname, '..', 'game', 'js', 'data', 'version.js');
var argv = process.argv.slice(2);
function flag(name) { var i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] || ''); }

var src = fs.readFileSync(FILE, 'utf8');
function read(field) {
  var m = src.match(new RegExp('(' + field + '\ *:\ *)([0-9]+)'));
  return m ? parseInt(m[2], 10) : null;
}
function setNum(field, value) {
  var re = new RegExp('(' + field + '\ *:\ *)([0-9]+)');
  if (!re.test(src)) { console.error('bump-version: could not find numeric field "' + field + '"'); process.exit(1); }
  src = src.replace(re, '$1' + value);
}
function setStr(field, value) {
  var re = new RegExp("(" + field + "\ *:\ *')([^']*)(')");
  if (!re.test(src)) { console.error('bump-version: could not find string field "' + field + '"'); process.exit(1); }
  src = src.replace(re, '$1' + String(value).replace(/'/g, '') + '$3');
}

var major = read('major'), minor = read('minor'), build = read('build');
if (major === null || minor === null || build === null) {
  console.error('bump-version: version.js is missing major/minor/build'); process.exit(1);
}

if (argv.indexOf('--print') !== -1) { console.log('v' + major + '.' + minor + '.' + build); process.exit(0); }

var newMinor = flag('--minor');
if (newMinor !== null && newMinor !== '') {
  minor = parseInt(newMinor, 10);
  if (isNaN(minor)) { console.error('bump-version: --minor needs a number'); process.exit(1); }
  build = 0;                       // a new spec section restarts the build count
} else {
  build += 1;
}
setNum('minor', minor);
setNum('build', build);

/* Local date, not UTC: the version line is read by a human looking at the
   title screen, and a build made at 01:00 CEST showing "yesterday" reads as
   stale even though it is minutes old. */
var d = new Date();
var pad = function (n) { return (n < 10 ? '0' : '') + n; };
setStr('date', d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));

var label = flag('--label');
if (label !== null && label !== '') setStr('label', label);

fs.writeFileSync(FILE, src);
console.log('v' + major + '.' + minor + '.' + build);
