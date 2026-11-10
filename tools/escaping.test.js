/* Tests for the shared escaping helpers in student-attendance-system/js/ui.js.
 *
 * These assert the XSS defences hold against payloads that would break out
 * of an HTML text or attribute context. The helpers are evaluated directly
 * out of the source so the test can never drift from the implementation.
 *
 * Run: node tools/escaping.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const uiPath = path.join(__dirname, '..', 'student-attendance-system', 'js', 'ui.js');
const src = fs.readFileSync(uiPath, 'utf8');

// Lift the real implementations out of the file. Wrapping in parentheses
// turns the declaration into an expression so eval() returns the function.
const lift = (name) => eval('(' + src.match(new RegExp('function ' + name + '[\\s\\S]*?\\n}'))[0] + ')');
const escapeHtml = lift('escapeHtml');
const safeToken = lift('safeToken');

let pass = 0;
const failures = [];

function ok(name, condition) {
  if (condition) pass++;
  else failures.push(name);
}

/* ── escapeHtml ─────────────────────────────────────────────────── */

const TAG_PAYLOAD = `"><img src=x onerror=alert(1)>`;
const ATTR_PAYLOAD = `" onmouseover="alert(1)`;

const escapedTag = escapeHtml(TAG_PAYLOAD);
ok('escapes double quote', !escapedTag.includes('"'));
ok('escapes single quote', !escapedTag.includes("'"));
ok('escapes <', !escapedTag.includes('<'));
ok('escapes >', !escapedTag.includes('>'));
ok('escapes & in a payload containing one', escapeHtml('a&b').includes('&amp;'));
ok('all five characters escaped in one payload',
  escapeHtml(`&<>"'`).includes('&amp;') &&
  escapeHtml(`&<>"'`).includes('&lt;') &&
  escapeHtml(`&<>"'`).includes('&gt;') &&
  escapeHtml(`&<>"'`).includes('&quot;') &&
  escapeHtml(`&<>"'`).includes('&#39;'));
ok('& is escaped before <, so no double-decoding', escapeHtml('&lt;') === '&amp;lt;', escapeHtml('&lt;'));

ok('null becomes empty string', escapeHtml(null) === '');
ok('undefined becomes empty string', escapeHtml(undefined) === '');
ok('0 is preserved, not falsy-dropped', escapeHtml(0) === '0');
ok('empty string stays empty', escapeHtml('') === '');
ok('numbers are coerced', escapeHtml(42) === '42');

// Attribute context: the escaped output must not be able to close the quote
// and introduce a new attribute.
ok('attribute payload neutralised', !escapeHtml(ATTR_PAYLOAD).includes('" '));

// Escaping must not double-encode existing entities into something that
// renders as raw markup.
ok('does not leave raw angle brackets', !/>\s*script/i.test(escapeHtml('<script>alert(1)</script>')));

/* ── safeToken ──────────────────────────────────────────────────── */

const ALLOWED = ['present', 'late', 'absent', 'excused'];

ok('allowlisted token passes through', safeToken('present', ALLOWED) === 'present');
ok('unknown token is replaced', safeToken('unknown', ALLOWED) === 'unknown');
ok('empty string is rejected', safeToken('', ALLOWED) === 'unknown');
ok('null is rejected', safeToken(null, ALLOWED) === 'unknown');
ok('undefined is rejected', safeToken(undefined, ALLOWED) === 'unknown');
ok('number is rejected', safeToken(1, ALLOWED) === 'unknown');
ok('object is rejected', safeToken({}, ALLOWED) === 'unknown');
ok('array is rejected', safeToken(ALLOWED, ALLOWED) === 'unknown');
ok('empty allowlist rejects everything', safeToken('present', []) === 'unknown');

// The critical case: an attacker-controlled value used as a CSS class token.
const breakout = safeToken('x" onload="alert(1)', ALLOWED);
ok('attribute breakout in token is neutralised', breakout === 'unknown', breakout);
ok('rejected token contains no quote', !breakout.includes('"'));

const withQuotes = safeToken('pre"sent', ALLOWED);
ok('token with embedded quote rejected', withQuotes === 'unknown', withQuotes);

// Composed into a real class attribute, nothing extra may leak through.
const cls = 'status-badge ' + safeToken(TAG_PAYLOAD, ALLOWED);
ok('composed class attribute stays inert', !cls.includes('"') && !cls.includes('<'), cls);

/* ── Report ─────────────────────────────────────────────────────── */

if (failures.length === 0) {
  console.log(`  ${pass} escaping assertions passed`);
  process.exit(0);
}
console.log(`  ${pass} passed, ${failures.length} FAILED:`);
for (const f of failures) console.log('    - ' + f);
process.exit(1);
