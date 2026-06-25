'use strict';

// Pure-function tests for the categorizer — no DB needed.
const { test } = require('node:test');
const assert = require('node:assert');
const { categorize, merchant } = require('../categorize');

test('categorize maps known merchant keywords to the right category', () => {
  assert.equal(categorize('DOORDASH*WENDYS'), 'Food & Dining');
  assert.equal(categorize('TST* TONYS PIZZERIA'), 'Food & Dining');
  assert.equal(categorize('ZEL* SAM RIVERS'), 'P2P / People');
  assert.equal(categorize('VENMO PAYMENT'), 'P2P / People');
  assert.equal(categorize('SOME RANDOM UNKNOWN VENDOR XYZ'), 'Other');
});

test('Zelle in any common form is P2P, not Other', () => {
  assert.equal(categorize('ZEL JANE SMITH'), 'P2P / People');        // spaced "ZEL" (was leaking to Other)
  assert.equal(categorize('ZEL*SAM RIVERS'), 'P2P / People');        // asterisk form
  assert.equal(categorize('ZELLE TO JOHN DOE'), 'P2P / People');     // full word
  assert.equal(categorize('QUICKPAY WITH ZELLE'), 'P2P / People');   // Chase label
  // "hazel" / words merely containing zel must NOT trip the rule
  assert.equal(categorize('HAZELNUT COFFEE ROASTERS'), 'Food & Dining');
});

test('categorize is case-insensitive', () => {
  assert.equal(categorize('doordash'), categorize('DOORDASH'));
});

test('merchant() normalizes a noisy bank description to a stable label', () => {
  const a = merchant('DBT CRD 1234 TONYS PIZZERIA AUSTIN TX');
  const b = merchant('TONYS PIZZERIA AUSTIN #00123');
  assert.ok(a.length > 0 && a !== 'Unknown');
  // both should surface the merchant name, not the card/transaction noise
  assert.ok(/TONYS|PIZZERIA/i.test(a));
  assert.ok(/TONYS|PIZZERIA/i.test(b));
});

test('merchant() falls back to "Unknown" for empty/meaningless input', () => {
  assert.equal(merchant(''), 'Unknown');
});
