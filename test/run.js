/* Test runner: node test/run.js
 *  1. backend end-to-end tests (mocked Apps Script services) + approval workflow / roles / reminders
 *     + paper-form (FM-MR-58) checklist model / legacy rows / approvals table
 *  2. single-source-of-truth check: docs/assets/js/data.js === apps-script/Data.gs
 *  3. syntax check of every frontend JS file and every inline <script> in docs/
 *  4. appsscript.json manifest sanity
 *  5. browser transport (core.js: batching, fallback, read cache, hand-over) against the backend
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const failures = [];
let passed = 0;

// 1 ---------------------------------------------------------------------------
const t0 = Date.now();
const e2e = require('./e2e.test.js')();
passed += e2e.passed;
failures.push(...e2e.failures);
console.log(`backend e2e: ${e2e.passed} passed, ${e2e.failures.length} failed (${Date.now() - t0} ms)`);
const tw = Date.now();
const wf = require('./workflow.test.js')();
passed += wf.passed;
failures.push(...wf.failures);
console.log(`approval workflow e2e: ${wf.passed} passed, ${wf.failures.length} failed (${Date.now() - tw} ms)`);
const tf = Date.now();
const fm = require('./form.test.js')();
passed += fm.passed;
failures.push(...fm.failures);
console.log(`paper form (FM-MR-58) data model e2e: ${fm.passed} passed, ${fm.failures.length} failed (${Date.now() - tf} ms)`);

const ta = Date.now();
const at = require('./attach.test.js')();
passed += at.passed;
failures.push(...at.failures);
console.log(`checklist item files e2e: ${at.passed} passed, ${at.failures.length} failed (${Date.now() - ta} ms)`);

const td = Date.now();
const wdt = require('./workdone.test.js')();
passed += wdt.passed;
failures.push(...wdt.failures);
console.log(`work done (แจ้งเสร็จงาน) + merged approvals column e2e: ${wdt.passed} passed, ${wdt.failures.length} failed (${Date.now() - td} ms)`);

// 2 ---------------------------------------------------------------------------
const gsData = fs.readFileSync(path.join(ROOT, 'apps-script', 'Data.gs'), 'utf8');
const jsData = fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'js', 'data.js'), 'utf8');
if (gsData === jsData) passed++; else failures.push('docs/assets/js/data.js differs from apps-script/Data.gs — run: node tools/sync-data.js');

// 3 ---------------------------------------------------------------------------
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
const docsFiles = walk(path.join(ROOT, 'docs'));
let jsCount = 0, inlineCount = 0;
docsFiles.filter((f) => f.endsWith('.js')).forEach((f) => {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); passed++; jsCount++; } catch (e) {
    failures.push('syntax: ' + path.relative(ROOT, f) + '\n' + String(e.stderr || e.message));
  }
});
docsFiles.filter((f) => f.endsWith('.html')).forEach((f) => {
  const html = fs.readFileSync(f, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { new vm.Script(m[1], { filename: path.relative(ROOT, f) }); passed++; inlineCount++; } catch (e) {
      failures.push('inline script syntax: ' + path.relative(ROOT, f) + ': ' + e.message);
    }
  }
  // every local script/stylesheet reference must exist
  const refRe = /(?:src|href)="(?!https?:|data:|#|mailto:|javascript:)([^"?#]+)/g;
  while ((m = refRe.exec(html))) {
    const target = path.join(path.dirname(f), m[1]);
    if (fs.existsSync(target)) passed++; else failures.push('missing reference in ' + path.relative(ROOT, f) + ': ' + m[1]);
  }
});
['apps-script/Code.gs', 'apps-script/Auth.gs', 'apps-script/Permits.gs', 'apps-script/Setup.gs', 'apps-script/Data.gs'].forEach((f) => {
  try { new vm.Script(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f }); passed++; } catch (e) { failures.push('syntax: ' + f + ': ' + e.message); }
});
console.log(`frontend: ${jsCount} JS files + ${inlineCount} inline scripts syntax-checked`);

// 4 ---------------------------------------------------------------------------
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'appsscript.json'), 'utf8'));
if (man.timeZone === 'Asia/Bangkok' && man.runtimeVersion === 'V8' && man.webapp.executeAs === 'USER_DEPLOYING' && man.webapp.access === 'ANYONE_ANONYMOUS') passed++;
else failures.push('appsscript.json manifest settings');
const cfg = fs.readFileSync(path.join(ROOT, 'docs', 'config.js'), 'utf8');
// Either unconfigured (apiUrl: "") or pointing at a deployed Apps Script web app.
if (/window\.WP_CONFIG\s*=\s*\{\s*apiUrl:\s*"(|https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec)"\s*\}/.test(cfg)) passed++;
else failures.push('docs/config.js apiUrl must be "" or a script.google.com/macros/s/.../exec URL');

// 5 ---------------------------------------------------------------------------
(async () => {
const t1 = Date.now();
const fe = await require('./frontend.test.js')();
passed += fe.passed;
failures.push(...fe.failures);
console.log(`frontend transport: ${fe.passed} passed, ${fe.failures.length} failed (${Date.now() - t1} ms)`);

console.log(`\nTOTAL: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:\n- ' + failures.join('\n- '));
  process.exit(1);
}
})();
