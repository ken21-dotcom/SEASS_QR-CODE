/* Finds CSS classes that no page or script ever references.
 *
 * The point is to catch stylesheets that outlived the markup they styled — a
 * retired page or a removed component leaves its rules behind, and they still
 * cost bytes on every load and mislead the next person editing the design.
 *
 * Every .html and .js under student-attendance-system is searched RECURSIVELY.
 * pages/ has three subdirectories (administrator/, ssc-officer/, student/), so a
 * non-recursive glob silently reports live classes as dead.
 *
 * Class names built at runtime are a known blind spot: `badge-${cls}` leaves the
 * prefix in the source, not the whole name. IGNORE holds the ones that are
 * genuinely assembled by string concatenation.
 *
 * Run: node tools/dead-css.js          report, exit 0
 *      node tools/dead-css.js --strict exit 1 if anything is reported
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'student-attendance-system');
const CSS = path.join(APP, 'css');

/* Classes assembled from a prefix plus a runtime value. The prefix is present in
 * the source, so a naive "does the name appear in a file" test misses these. */
const IGNORE = new Set([
  'sanction-severity-pill-warning',
  'sanction-severity-pill-probation',
  'sanction-severity-pill-suspension',
  'sanction-severity-icon-warning',
  'sanction-severity-icon-probation',
  'sanction-severity-icon-suspension',
]);

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full, exts, out);
    } else if (exts.some(e => entry.name.toLowerCase().endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/* ── class selectors referenced by the CSS ─────────────────────── */

function classesInCss(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set();

  // Split into rules so a class inside a selector list is captured with its rule.
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const prelude = css.slice(i, open).trim();
    if (prelude.includes('}') || prelude.includes(';')) { i = open + 1; continue; }

    let depth = 0, close = open;
    for (let j = open; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
    }

    // A class token is '.' followed by an identifier. The char before must not
    // be part of an identifier, so `foo.bar` does not yield "foo" twice and
    // decimals in values are not mistaken for selectors.
    for (const m of prelude.matchAll(/(^|[^\w.#-])\.(-?[_a-zA-Z][\w-]*)/g)) {
      names.add(m[2]);
    }
    i = close + 1;
  }
  return names;
}

/* ── everything the pages and scripts could reference ─────────── */

const assetFiles = walk(APP, ['.html', '.js']);
const haystack = assetFiles
  .map(f => fs.readFileSync(f, 'utf8'))
  .join('\n')
  .toLowerCase();

/* ── report ───────────────────────────────────────────────────── */

const cssFiles = fs.readdirSync(CSS).filter(f => f.endsWith('.css'));
const unused = new Map(); // class -> [files]

for (const file of cssFiles) {
  for (const cls of classesInCss(fs.readFileSync(path.join(CSS, file), 'utf8'))) {
    if (IGNORE.has(cls)) continue;
    if (haystack.includes(cls.toLowerCase())) continue;
    if (!unused.has(cls)) unused.set(cls, []);
    unused.get(cls).push(file);
  }
}

const total = [...cssFiles].length;
console.log(
  `Scanned ${total} stylesheets against ${assetFiles.length} pages/scripts ` +
  `(recursive).`
);

if (unused.size === 0) {
  console.log('No unreferenced classes found.');
  process.exit(0);
}

const sorted = [...unused.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`\n${sorted.length} class(es) referenced nowhere:\n`);
for (const [cls, files] of sorted) {
  console.log(`  .${cls.padEnd(42)} ${[...new Set(files)].join(', ')}`);
}
console.log('');
process.exit(process.argv.includes('--strict') ? 1 : 0);
