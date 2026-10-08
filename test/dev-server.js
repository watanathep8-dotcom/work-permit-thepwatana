/* Local preview of docs/ (no Google account needed).
 *
 *   node test/dev-server.js [port]            → docs/ + in-memory mocked Apps Script API at /api
 *   node test/dev-server.js [port] --no-api   → docs/ exactly as shipped (apiUrl empty → Thai banner)
 *   node test/dev-server.js [port] --latency=2000 → delay every API response (feel the real Apps Script round-trip)
 *   GET /__api-log[?reset=1]                  → API calls made so far (to count round-trips per page view)
 *
 * With the mock API, config.js is rewritten on the fly to point at /api and the
 * backend is set up with the test-only admin + reset passwords below (in-memory, lost on exit),
 * plus approvers "resp" (ผู้รับผิดชอบงาน) and "area" (เจ้าของพื้นที่) with DEV_APPROVER_PASSWORD.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGas } = require('./gas-mock');

const DEV_ADMIN_PASSWORD = 'dev-admin-pass'; // test fixture for the in-memory mock only
const DEV_RESET_PASSWORD = 'dev-reset-pass'; // test fixture (Script Property WP_RESET_PASSWORD) for the mock only
const DEV_APPROVER_PASSWORD = 'dev-approver-pass'; // test fixture: users resp / area of the mock only
const port = Number(process.argv[2]) || 8765;
const noApi = process.argv.includes('--no-api');
const latencyArg = process.argv.find((a) => a.startsWith('--latency='));
const LATENCY = latencyArg ? Number(latencyArg.split('=')[1]) || 0 : 0; // simulate Apps Script round-trip time (ms)
const DOCS = path.join(__dirname, '..', 'docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

let gas = null;
if (!noApi) {
  gas = createGas();
  gas.load(path.join(__dirname, '..', 'apps-script'), ['Data.gs', 'Code.gs', 'Auth.gs', 'Permits.gs', 'Setup.gs']);
  gas.propStore.WP_INITIAL_ADMIN_PASSWORD = DEV_ADMIN_PASSWORD;
  gas.context.setupSystem();
  delete gas.propStore.WP_INITIAL_ADMIN_PASSWORD;
  gas.propStore.WP_RESET_PASSWORD = DEV_RESET_PASSWORD; // enables reset / edit / delete in the preview
  // approval workflow fixtures (in-memory only): ผู้รับผิดชอบงาน "resp" + เจ้าของพื้นที่ "area"
  const call = (o) => JSON.parse(gas.context.doPost({ postData: { contents: JSON.stringify(o) } }).getContent());
  const s = call({ action: 'login', username: 'admin', password: DEV_ADMIN_PASSWORD }).data.session;
  call({ action: 'user_save', session: s, username: 'resp', fullname: 'สมศักดิ์ ผู้รับผิดชอบงาน', roles: ['responsible'], email: 'resp@example.com', password: DEV_APPROVER_PASSWORD });
  call({ action: 'user_save', session: s, username: 'area', fullname: 'อารี เจ้าของพื้นที่', roles: ['area_owner'], email: 'area@example.com', password: DEV_APPROVER_PASSWORD });
  call({ action: 'logout', session: s });
}

// Request log for measuring round-trips per page view: GET /__api-log (?reset=1 clears it).
const apiLog = [];
const describe = (method, body, params) => {
  let a = '';
  try { a = method === 'POST' ? JSON.parse(body || '{}') : params; } catch { return method + ' ?'; }
  const sub = Array.isArray(a.calls) ? '[' + a.calls.map((c) => c && c.action).join(',') + ']' : '';
  return method + ' ' + String(a.action || '') + sub;
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (gas && url.pathname === '/__api-log') {
    const out = JSON.stringify(apiLog);
    if (url.searchParams.get('reset')) apiLog.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(out);
    return;
  }
  if (gas && url.pathname === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      apiLog.push({ t: Date.now(), call: describe(req.method, body, Object.fromEntries(url.searchParams)) });
      const out = req.method === 'POST'
        ? gas.context.doPost({ postData: { contents: body } })
        : gas.context.doGet({ parameter: Object.fromEntries(url.searchParams) });
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(out.getContent());
      }, LATENCY);
    });
    return;
  }
  if (gas && url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'] });
    res.end(`window.WP_CONFIG = { apiUrl: "http://localhost:${port}/api" };\n`);
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(DOCS, p));
  if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`docs/ on http://localhost:${port}/ ${noApi ? '(no API)' : '(mock API at /api)'}`));
