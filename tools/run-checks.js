/* Static verification for the ATTENDLY prototype.
 *
 * There is no browser test runner here, so this checks the things that
 * can be proven without one: every script parses, every stylesheet's
 * braces balance, every relative asset reference resolves on disk, and
 * the escaping and API boundary contracts hold.
 *
 * Run: npm test
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PAGES = path.join(ROOT, 'student-attendance-system', 'pages');

let failures = 0;

function section(name) {
  console.log('\n' + name);
}

function report(name, passed, detail) {
  if (passed) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (!filter || filter(full)) out.push(full);
  }
  return out;
}

/* ── 1. Every JavaScript file parses ────────────────────────────── */

section('JavaScript syntax');
const jsFiles = walk(path.join(ROOT, 'student-attendance-system', 'js'), (f) => f.endsWith('.js'));
for (const file of jsFiles) {
  const rel = path.relative(ROOT, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    report(rel, true);
  } catch (e) {
    report(rel, false, String(e.stderr || e.message).split('\n')[0]);
  }
}

section('Inline script blocks');
const htmlFiles = walk(PAGES, (f) => f.endsWith('.html'));
let inlineCount = 0;
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  blocks.forEach((m, i) => {
    const tmp = path.join(ROOT, '.syntax-check.tmp.js');
    fs.writeFileSync(tmp, m[1]);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (e) {
      report(`${path.basename(file)} block ${i + 1}`, false, String(e.stderr || e.message).split('\n')[0]);
    } finally {
      fs.unlinkSync(tmp);
    }
    inlineCount++;
  });
}
report(`${inlineCount} inline blocks across ${htmlFiles.length} pages parse`, true);

/* ── 2. Stylesheets balance ─────────────────────────────────────── */

section('CSS braces');
const cssFiles = walk(path.join(ROOT, 'student-attendance-system', 'css'), (f) => f.endsWith('.css'));
for (const file of cssFiles) {
  const css = fs.readFileSync(file, 'utf8');
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  report(path.basename(file), open === close, `${open} open / ${close} close`);
}

/* ── 3. PHP braces and parens balance ───────────────────────────── */

section('PHP braces');
const phpFiles = walk(path.join(ROOT, 'attendly-backend'), (f) => f.endsWith('.php'));
for (const file of phpFiles) {
  const php = fs.readFileSync(file, 'utf8');
  const o = (php.match(/\{/g) || []).length;
  const c = (php.match(/\}/g) || []).length;
  const po = (php.match(/\(/g) || []).length;
  const pc = (php.match(/\)/g) || []).length;
  report(path.relative(ROOT, file), o === c && po === pc, `braces ${o}/${c}, parens ${po}/${pc}`);
}

/* ── 4. Relative asset references resolve ───────────────────────── */

section('Asset references');
const sysRoot = path.join(ROOT, 'student-attendance-system');
const seen = new Set();
let missing = 0;
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const pageDir = path.dirname(path.relative(sysRoot, file));
  // Cache-busting query strings are stripped before touching the filesystem.
  const refs = [...html.matchAll(/(?:href|src)="((?:\.\.\/)+)(css|js|images)\/([^"?]+)(?:\?[^"]*)?"/g)];
  for (const ref of refs) {
    const up = (ref[1].match(/\.\.\//g) || []).length;
    let dir = pageDir;
    for (let i = 0; i < up; i++) dir = path.dirname(dir);
    const asset = path.join(dir, ref[2], ref[3]);
    if (seen.has(asset)) continue;
    seen.add(asset);
    if (!fs.existsSync(path.join(sysRoot, asset))) {
      report(`${path.basename(file)} -> ${asset}`, false, 'not found');
      missing++;
    }
  }
}
report(`${seen.size} unique local asset references resolve`, missing === 0);

section('No duplicate stylesheet loads');
const imported = [...fs.readFileSync(path.join(sysRoot, 'css', 'styles.css'), 'utf8')
  .matchAll(/@import '\.\/([^']+)'/g)].map((m) => m[1]);
let dupes = 0;
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const direct = [...html.matchAll(/href="\.\.\/css\/([a-z0-9-]+)\.css/g)].map((m) => m[1]);
  const overlap = direct.filter((d) => imported.includes(d));
  if (overlap.length) {
    report(`${path.basename(file)}`, false, `also loaded via styles.css: ${overlap.join(', ')}`);
    dupes++;
  }
}
report('no page loads a stylesheet that styles.css already imports', dupes === 0);

section('api.js load order');
let apiIssues = 0;
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const count = (html.match(/js\/api\.js/g) || []).length;
  const apiAt = html.indexOf('js/api.js');
  const dataAt = html.indexOf('js/data.js');
  if (count !== 1 || (apiAt !== -1 && dataAt !== -1 && apiAt > dataAt)) {
    report(`${path.basename(file)}`, false, `count=${count}`);
    apiIssues++;
  }
}
report('every page loads api.js exactly once, before data.js', apiIssues === 0);

section('No stale script filenames');
const allJs = fs.readFileSync(path.join(sysRoot, 'js', 'ui.js'), 'utf8');
let stale = 0;
for (const file of [...htmlFiles, ...jsFiles]) {
  const text = fs.readFileSync(file, 'utf8');
  if (/js\/admin\.js|js\/admin-panel\.js/.test(text)) {
    report(path.basename(file), false, 'references a renamed file');
    stale++;
  }
}
report('no references to admin.js / admin-panel.js', stale === 0);

/* ── 5. Behavioural suites ──────────────────────────────────────── */

for (const suite of ['tools/escaping.test.js', 'tools/api-contract.test.js', 'tools/hydration.test.js', 'tools/qr-scan.test.js', 'tools/data-storage.test.js', 'tools/first-run.test.js', 'tools/d5-ui.test.js', 'tools/global-search.test.js', 'tools/d6-id-normalization.test.js', 'tools/student-org.test.js', 'tools/student-attendance-rate.test.js', 'tools/weather.test.js']) {
  section(path.basename(suite));
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, suite)], { stdio: 'pipe' });
    for (const line of String(out).trim().split('\n')) console.log('  ' + line);
  } catch (e) {
    failures++;
    console.log(String(e.stdout || '') + String(e.stderr || e.message));
  }
}

/* ── Colour contrast ───────────────────────────────────────────
 * The colour pairs the UI actually renders are measured against WCAG AA in
 * both themes. Kept as its own step because a failure here is a design
 * regression, not a broken contract. Run it alone with:
 *   node tools/contrast-check.js --suggest
 */
section('contrast-check.js');
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools/contrast-check.js')], { stdio: 'pipe' });
  for (const line of String(out).trim().split('\n')) console.log('  ' + line);
} catch (e) {
  failures++;
  console.log(String(e.stdout || '') + String(e.stderr || e.message));
}

/* ── Summary ────────────────────────────────────────────────────── */

console.log('');
if (failures === 0) {
  console.log('All checks passed.');
  process.exit(0);
}
console.log(`${failures} check(s) failed.`);
process.exit(1);
