// Copies the single source of truth (apps-script/Data.gs) to the browser copy.
// Usage: node tools/sync-data.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'apps-script', 'Data.gs'), 'utf8');
fs.writeFileSync(path.join(root, 'docs', 'assets', 'js', 'data.js'), src);
console.log('docs/assets/js/data.js updated from apps-script/Data.gs');
