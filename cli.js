#!/usr/bin/env node

require('dotenv').config();
const { collect, clean, report, authors } = require('./index');

const args = process.argv.slice(2);

const fns = [];

if ((!args.includes('report') && !args.includes('clean')) || args.includes('collect')) {
  fns.push(collect);
}

if (args.includes('clean')) {
  fns.push(clean);
}

if (args.includes('report')) {
  fns.push(report);
}

(async function() {
  for (const fn of fns) {
    await fn();
  }
})();
