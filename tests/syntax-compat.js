// Fails if any app script uses JavaScript syntax newer than ES2019, which older
// iPhones (Safari 12.1–14) cannot parse — one such line blanks the whole app there.
// Usage: node tests/syntax-compat.js   (needs the `acorn` dev dependency)
const acorn = require('acorn');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const files = { 'lib.js': fs.readFileSync(path.join(ROOT, 'lib.js'), 'utf8'), 'sw.js': fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8') };
[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].forEach((m, i) => { files['index.html inline script #' + (i + 1)] = m[1]; });
let bad = 0;
for (const [name, src] of Object.entries(files)) {
    try { acorn.parse(src, { ecmaVersion: 2019, sourceType: 'script' }); console.log('  ✓ ' + name); }
    catch (e) { bad++; console.error(`  ✗ ${name}: ${e.message}\n    ${src.split('\n')[e.loc.line - 1].trim().slice(0, 160)}`); }
    // Regex look-behind parses as ES2018 but is a syntax error before Safari 16.4.
    if (/\(\?<[=!]/.test(src)) { bad++; console.error(`  ✗ ${name}: regex look-behind (unsupported before iOS 16.4)`); }
}
console.log(bad ? `\n✗ ${bad} problem(s)` : '\n✓ all scripts are ES2019-compatible');
process.exit(bad ? 1 : 0);
