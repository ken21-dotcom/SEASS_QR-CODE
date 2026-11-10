/* Audits the real token pairs in the shipped CSS against WCAG AA.
 * Reads variables.css + dark-style.css, resolves the custom properties
 * each rule actually depends on, and reports every failing pair.
 * Run: node tools/contrast-check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CSS = path.join(__dirname, '..', 'student-attendance-system', 'css');
const variables = fs.readFileSync(path.join(CSS, 'variables.css'), 'utf8');
const dark = fs.readFileSync(path.join(CSS, 'dark-style.css'), 'utf8');

/* ── colour maths ─────────────────────────────────────────────── */

function hexToRgb(hex) {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/* ── hue-preserving correction ─────────────────────────────────── */

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Find the *smallest* lightness change that makes `hex` reach `target` against
 * `bgHex`, holding hue and saturation fixed so the palette keeps its character.
 * `direction` says which way to move: 'darker' raises contrast against a light
 * background, 'lighter' lowers contrast against a dark one.
 *
 * Both directions bisect on lightness and keep the best passing candidate that
 * is closest to the original, so a 4.37:1 pair nudges to ~4.5 rather than
 * snapping to black.
 */
function correct(hex, bgHex, target, direction) {
  const [h, s] = rgbToHsl(...hexToRgb(hex));
  const startL = rgbToHsl(...hexToRgb(hex))[2];
  let lo = 0, hi = 1, best = null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const candidate = hslToHex(h, s, mid);
    const passes = contrast(candidate, bgHex) >= target;

    if (passes) {
      if (!best || Math.abs(mid - startL) < Math.abs(best.l - startL)) best = { hex: candidate, l: mid };
      // Passing: probe back toward the original lightness for a gentler fix.
      if (direction === 'darker') lo = mid; else hi = mid;
    } else {
      // Failing: we have to move further in the correction direction.
      if (direction === 'darker') hi = mid; else lo = mid;
    }
  }
  return best ? best.hex : hex;
}

/* ── token extraction ──────────────────────────────────────────── */

/**
 * Split a stylesheet into `{ selectors, body }` for every top-level rule.
 * Comment-stripped first so a selector mentioned in prose is never matched.
 */
function rules(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    // A declaration block, not a nested rule — skip to its close.
    const selectors = css.slice(i, open).trim();
    if (selectors.includes('}') || selectors.includes(';')) {
      i = open + 1;
      continue;
    }
    let depth = 0;
    let close = open;
    for (let j = open; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
    }
    out.push({ selectors, body: css.slice(open + 1, close) });
    i = close + 1;
  }
  return out;
}

/** Custom properties declared in the first rule whose selector list matches. */
function tokensWhere(source, test) {
  for (const rule of rules(source)) {
    if (!test(rule.selectors)) continue;
    const out = {};
    for (const m of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out[m[1]] = m[2].trim();
    }
    if (Object.keys(out).length) return out;
  }
  return {};
}

const rootLight = tokensWhere(variables, s => /(^|,)\s*:root\s*$/.test(s));
const rootDark = tokensWhere(dark, s => /\[data-theme="dark"\]/.test(s) && !/\.auth-|\.kiosk-/.test(s));
const authLight = tokensWhere(variables, s => /\.auth-page\s*$/.test(s));
const authDark = tokensWhere(dark, s => /\.auth-page\s*$/.test(s));

if (!Object.keys(rootDark).length) throw new Error('dark :root token block not found');
if (!Object.keys(authDark).length) throw new Error('dark .auth-page token block not found');

const light = rootLight;
const darkTheme = rootDark;
// The .auth-page palette is a separate scope. dark-style.css re-declares only
// *some* of --campus-* for dark, so the auth theme is authDark layered over
// authLight — merging it into the app tokens would wrongly apply the auth-only
// overrides (e.g. --color-border-focus) to every page.
const authTheme = { light: authLight, dark: { ...authLight, ...authDark } };

/** Resolve a token to a hex, or pass a literal hex straight through. */
function resolve(tokens, value) {
  if (!value) return null;
  if (value.startsWith('#')) return value;
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(tokens, tokens[ref[1]]) : null;
}

const tok = (tokens, name) => resolve(tokens, name.startsWith('--') ? tokens[name] : name);

/* ── the pairs the UI actually renders ─────────────────────────── */

// scope: 'app' pairs use the :root tokens, 'auth' pairs use the .auth-page
// palette against the auth panel. `fix` says which side to correct when a
// pair fails: 'fg' for coloured text, 'bg' for a coloured fill.
const APP_PAIRS = [
  ['body text',         '--color-text-primary',        '--color-bg-card',            4.5, 'fg', 'darker',  'primary copy on cards'],
  // The muted token sits on three light grounds. The darkest of them
  // (#f4f8f6, the input fill) is the binding constraint, so fix to that one.
  ['muted text',        '--color-text-muted',          '--color-bg-input',           4.5, 'fg', 'darker',  'default secondary + label colour'],
  ['muted on card',     '--color-text-muted',          '--color-bg-card',            4.5, 'fg', 'darker',  ''],
  ['muted on app bg',   '--color-text-muted',          '--color-bg-app',             4.5, 'fg', 'darker',  'metadata outside cards'],
  ['heading text',      '--color-text-heading',        '--color-bg-card',            4.5, 'fg', 'darker',  'card + page headings'],
  ['success text',      '--color-text-success',        '--color-bg-card',            4.5, 'fg', 'darker',  ''],
  ['warning text',      '--color-text-warning',        '--color-bg-warning-light',   4.5, 'fg', 'darker',  'severity pill / icon'],
  ['danger text',       '--color-text-danger',         '--color-bg-danger-light',    4.5, 'fg', 'darker',  'suspension pill / icon'],
  ['probation text',    '--color-text-probation',      '--color-probation-bg',       4.5, 'fg', 'darker',  'probation pill / icon'],
  ['accent chip',       '--color-text-success',        '--color-bg-success-light',   4.5, 'fg', 'darker',  ''],
  // Activity-feed chips. These were raw hex in role-dashboard.css with no
  // dark-theme override; the info pair sat at 3.93:1 in light theme, under
  // the floor for its 12px glyph. Now tokenised, and checked in both themes.
  ['info chip',         '--color-text-info',           '--color-bg-info-light',      4.5, 'fg', 'darker',  'activity feed: enrollment icon'],
  ['violet chip',       '--color-text-violet',         '--color-bg-violet-light',    4.5, 'fg', 'darker',  'activity feed: status icon'],

  // Severity badges are fills with their own label colour (app-shell.css).
  // Each fill admits exactly one label, so the label flips per fill/theme
  // rather than the severity hue being muted.
  ['warning badge fill',   '#212529', '--color-badge-warning',    4.5, 'bg', 'darker',  'dark label on the fill'],
  ['probation badge fill', '#212529', '--color-badge-probation',  4.5, 'bg', 'darker',  'dark label (white would be 2.95:1)'],
  ['suspension badge fill', '#ffffff', '--color-badge-suspension', 4.5, 'bg', 'darker', 'white label in light theme', 'light'],
  ['suspension badge fill', '#212529', '--color-badge-suspension', 4.5, 'bg', 'darker', 'dark label in dark theme', 'dark'],

  // WCAG 1.4.11 non-text contrast: 3:1 for the control boundary a user must
  // be able to see. Card edges below are decorative, so they are advisory.
  ['input border',      '--color-border-input',        '--color-bg-card',            3.0, 'fg', 'darker', 'field boundary (required)'],
  ['focus ring',        '--color-border-focus',        '--color-bg-card',            3.0, 'fg', 'darker', 'focus indicator'],
  ['card border',       '--color-border-default',      '--color-bg-app',             3.0, 'fg', 'darker', 'decorative only (advisory)'],
];

const ADVISORY = new Set(['card border', 'fog boundary']);

// The auth screens sit on the cream panel (light) / #0f1a14 (dark).
// bg token is resolved inside the auth scope; omit it for the panel itself.
const AUTH_PAIRS = [
  ['heading',        '--campus-bark',       null,                4.5, 'fg', 'darker',  'login + sign-up heading'],
  ['subtext',        '--campus-fog-strong', null,                4.5, 'fg', 'lighter', 'login + sign-up subheading'],
  ['field label',    '--campus-fog-strong', null,                4.5, 'fg', 'lighter', 'uppercase field labels'],
  ['link',           '--campus-link',       null,                4.5, 'fg', 'lighter', 'links on the auth panel'],
  ['strength: risk', '--campus-risk',       null,                4.5, 'fg', 'lighter', 'sign-up strength meter'],
  ['submit label',   '#ffffff',             '--campus-green',    4.5, 'fg', 'darker',  'white on the solid green CTA'],
  // Input-group prefix and the reveal-password control sit on the *input* fill,
  // not the panel, and both the fill and the foreground are restyled per theme
  // (auth.css:680,721 set the light base; dark-style.css:601,632 the dark one).
  ['input prefix',   '--campus-fog-strong', '#ffffff', 4.5, 'fg', 'lighter', '@ / lock prefix', 'light'],
  ['input prefix',   '--campus-fog',        '#18251f', 4.5, 'fg', 'darker',  '@ / lock prefix', 'dark'],
  ['password toggle','--campus-fog-strong', '#f4f8f6', 4.5, 'fg', 'lighter', 'reveal control',  'light'],
  ['password toggle','--campus-fog',        '#18251f', 4.5, 'fg', 'darker',  'reveal control',  'dark'],
  // --campus-fog stays a boundary/decoration colour; 3:1 as non-text.
  ['fog boundary',   '--campus-fog',        null,       3.0, 'fg', 'darker',  'borders only (advisory)'],
];

const AUTH_PANEL = { light: '#f7f4ed', dark: '#0f1a14' };

const SUGGEST = process.argv.includes('--suggest');
let failures = 0;
let advisoryCount = 0;
let checks = 0;

for (const [themeName, appTokens, authTokens, panel] of [
  ['light', light, authTheme.light, AUTH_PANEL.light],
  ['dark', darkTheme, authTheme.dark, AUTH_PANEL.dark],
]) {
  console.log('\n' + themeName.toUpperCase() + ' THEME  (app pages / auth screens)');

  const rows = [
    ...APP_PAIRS.map(([l, f, b, m, fix, dir, n, only]) => ({ label: l, f, b, m, fix, dir, n, only, scope: 'app' })),
    ...AUTH_PAIRS.map(([l, f, b, m, fix, dir, n, only]) => ({ label: l + ' (auth)', f, b, m, fix, dir, n, only, scope: 'auth' })),
  ].filter(row => !row.only || row.only === themeName);

  for (const row of rows) {
    const tokens = row.scope === 'auth' ? authTokens : appTokens;
    const bgSpec = row.b && typeof row.b === 'object' ? row.b[themeName] : row.b;
    const fg = tok(tokens, row.f);
    const bg = bgSpec ? tok(tokens, bgSpec) : panel;
    if (!fg || !bg) {
      console.log(`  ??   ${row.label.padEnd(22)} unresolved (${row.f} / ${bgSpec})`);
      continue;
    }
    const ratio = contrast(fg, bg);
    checks++;
    const pass = ratio >= row.m;
    // Auth rows get an ' (auth)' label suffix, so match the advisory set on the
    // bare label.
    const baseLabel = row.label.replace(/ \(auth\)$/, '');
    const advisory = !pass && ADVISORY.has(baseLabel);
    if (!pass) { if (advisory) advisoryCount++; else failures++; }

    // Correct whichever side is the coloured one.
    let fixText = '';
    if (!pass) {
      const target = row.fix === 'bg' ? bg : fg;
      const other = row.fix === 'bg' ? fg : bg;
      const fixed = correct(target, other, row.m, row.dir);
      fixText = `  -> ${fixed} (${contrast(fixed, other).toFixed(2)}:1, was ${target})`;
    }

    const mark = pass ? 'ok  ' : advisory ? 'ADVIS' : 'FAIL';
    console.log(
      `  ${mark}  ${row.label.padEnd(22)} ${ratio.toFixed(2).padStart(6)}:1` +
      `  (min ${row.m})  ${fg} on ${bg}` +
      (row.n ? `  (${row.n})` : '') + fixText
    );
  }
}

console.log('');
if (advisoryCount) console.log(`${advisoryCount} advisory pair(s) below target (decorative only).`);
if (failures === 0) {
  console.log(`All ${checks} required contrast pairs pass.`);
  process.exit(0);
}
console.log(`${failures} of ${checks} required contrast pairs fail.` + (SUGGEST ? '' : '  (run with --suggest for corrected values)'));
process.exit(1);

