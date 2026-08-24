/* CHLOE — tools/devserver.js
   Dependency-free static server for local checks. dev.ps1 prefers
   `npx http-server`; this exists because automated/browser harnesses run
   without npx on PATH and still need the game served over http:// (GLB and
   HDR loaders fail hard on file://).
   Usage: node tools/devserver.js [port]   -> http://localhost:8080/game/ */
var http = require('http'), fs = require('fs'), path = require('path'), url = require('url');
var root = path.resolve(__dirname, '..');
var port = parseInt(process.argv[2], 10) || 8080;
var TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.hdr': 'image/vnd.radiance',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.webp': 'image/webp', '.ico': 'image/x-icon' };
http.createServer(function (req, res) {
  var p = decodeURIComponent(url.parse(req.url).pathname);
  if (p.slice(-1) === '/') p += 'index.html';
  var file = path.join(root, p);
  // never serve outside the project, whatever the request says
  if (file.indexOf(root) !== 0) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
                         'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}).listen(port, function () {
  console.log('CHLOE dev server -> http://localhost:' + port + '/game/');
});
