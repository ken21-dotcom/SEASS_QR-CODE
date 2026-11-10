/* Tests for the kiosk QR scan pipeline.
 *
 * The scanner is continuous: the camera stays on and kiosk.js decides
 * which decode to process. These tests pin the contract that broke when
 * the tap-to-scan flow was replaced:
 *
 *   - the scan handler must never reference the old decodeDeferred
 *     promise (it caused a ReferenceError on every successful decode)
 *   - the QR payload must be analysed and validated before the API call
 *
 * Run: node tools/qr-scan.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const kioskSrc = fs.readFileSync(
  path.join(ROOT, 'student-attendance-system/js/kiosk.js'),
  'utf8'
);
const scannerSrc = fs.readFileSync(
  path.join(ROOT, 'student-attendance-system/js/qr-scanner.js'),
  'utf8'
);
const kioskCss = fs.readFileSync(
  path.join(ROOT, 'student-attendance-system/css/kiosk.css'),
  'utf8'
);

let pass = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) pass++;
  else failures.push(name + (detail !== undefined ? ' -> ' + detail : ''));
}

/* ── Lift the real payload analyser ─────────────────────────────── */

const patternSource = kioskSrc.match(/const QR_TOKEN_PATTERN = (\/[^\n]+\/);/);
ok('QR token pattern is declared', !!patternSource);

const QR_TOKEN_PATTERN = patternSource ? eval(patternSource[1]) : /$^/;
const analyzeQrText = eval(
  '(' + kioskSrc.match(/function analyzeQrText\(rawText\) \{[\s\S]*?\n  \}/)[0] + ')'
);

const token = 'v1.42.7.' + 'A'.repeat(43);

ok('raw dashboard token is accepted', analyzeQrText(token).valid === true);
ok('surrounding whitespace is ignored', analyzeQrText('  ' + token + '\n').valid === true);
ok('zero-width characters are ignored', analyzeQrText('\u200B' + token + '\uFEFF').valid === true);
ok('URL-wrapped token is accepted',
  analyzeQrText('https://attendly.local/qr?token=' + token).valid === true);
ok('URL-wrapped qrToken parameter is accepted',
  analyzeQrText('https://attendly.local/qr?qrToken=' + token).valid === true);
ok('empty payload is rejected', analyzeQrText('').valid === false);
ok('null payload is rejected', analyzeQrText(null).valid === false);
ok('old permanent token shape is rejected', analyzeQrText('A'.repeat(43)).valid === false);
ok('short token is rejected', analyzeQrText('v1.42.7.' + 'A'.repeat(42)).valid === false);
ok('overlong token is rejected', analyzeQrText('v1.42.7.' + 'A'.repeat(44)).valid === false);
ok('non-base64url characters are rejected', analyzeQrText('v1.42.7.' + 'A'.repeat(42) + '+').valid === false);
ok('missing event id is rejected', analyzeQrText('v1.42..' + 'A'.repeat(43)).valid === false);
ok('unrelated QR text is rejected', analyzeQrText('https://example.com').valid === false);
ok('returned token is trimmed',
  analyzeQrText('  ' + token + '  ').token === token);

/* ── The regression that broke continuous scanning ──────────────── */

ok('kiosk no longer references decodeDeferred',
  !/decodeDeferred/.test(kioskSrc));
ok('the continuous scan handler calls runQrScan',
  /function handleContinuousQrScan\([\s\S]*?runQrScan\(\)/.test(kioskSrc));
ok('the scan handler is passed to the scanner',
  /scanner\.start\(handleContinuousQrScan,/.test(kioskSrc));
ok('the scan handler ignores codes while a result is visible',
  /resultOverlay[\s\S]*?hidden\) return/.test(kioskSrc));
ok('the scan handler deduplicates a repeated code',
  /lastHandledQrText/.test(kioskSrc) && /QR_SCAN_REPEAT_WINDOW_MS/.test(kioskSrc));
ok('invalid payloads show the invalid_qr result',
  /analysis\.valid[\s\S]*?'invalid_qr'/.test(kioskSrc));
ok('runQrScan sends the analysed token, not the raw payload',
  /const decoded = analysis\.token;/.test(kioskSrc) &&
  /api\.qrCheckIn\(event\.id, decoded, scanMode\)/.test(kioskSrc));

/* ── Scanner wrapper guards ─────────────────────────────────────── */

ok('scanner invokes the handler through a try/catch',
  /currentOnScan\(String\(decodedText\)\)/.test(scannerSrc));
ok('scanner starts with a detected camera ID',
  /Html5Qrcode\.getCameras\(\)/.test(scannerSrc) &&
  /cameras\[0\]\.id/.test(scannerSrc));
ok('scanner uses the friend scanner configuration',
  /fps:\s*10/.test(scannerSrc) && /qrbox:\s*250/.test(scannerSrc));
ok('scanner does not force custom camera constraints',
  !/facingMode/.test(scannerSrc) && !/advanced/.test(scannerSrc));

/* ── Scanner mount ──────────────────────────────────────────────── */
ok('kiosk contains an html5-qrcode scan region',
  /id="qrRegion"/.test(fs.readFileSync(
    path.join(ROOT, 'student-attendance-system/pages/kiosk.html'), 'utf8'
  )));
ok('kiosk camera preview is mirrored visually only',
  /\.kiosk-qr-region\s+video[\s\S]*?transform:\s*scaleX\(-1\)/.test(kioskCss));

/* ── Report ────────────────────────────────────────────────────── */

if (failures.length === 0) {
  console.log(`  ${pass} QR scan assertions passed`);
  process.exit(0);
}
console.log(`  ${pass} passed, ${failures.length} FAILED:`);
for (const f of failures) console.log('    - ' + f);
process.exit(1);
