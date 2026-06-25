'use strict';

// Shared helpers used across modules. Money/date math lives here so it can't
// drift between modules — `round2` was previously redefined identically in a
// dozen files; one definition removes that duplication and the drift risk.

// Round to cents. The whole app treats money as plain dollars (numbers), so this
// is the canonical rounding used before storing or returning any computed amount.
const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { round2 };
