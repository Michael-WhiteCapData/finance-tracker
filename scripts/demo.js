'use strict';

// One command to try the app with realistic FAKE data: seeds a separate
// `demo.db` (your real `finance.db` is never touched) and starts the server
// against it. Run with:  npm run demo  →  http://localhost:4317
const path = require('path');
process.env.FINANCE_DB = path.join(__dirname, '..', 'demo.db');
require('./seed-demo'); // populates demo.db (clears it first)
require('../server');   // starts the server bound to demo.db
