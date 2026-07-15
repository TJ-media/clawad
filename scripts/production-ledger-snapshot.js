'use strict';

const { readLedgerSnapshot } = require('./lib/production-compose');

try {
  console.log(JSON.stringify(readLedgerSnapshot('postgres'), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
