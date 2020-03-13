#!/usr/bin/env node

require('dotenv').config();
const { collectRepos, cleanReportFolder, makeReports } = require('./index');

const args = process.argv.slice(2);

const fns = [];

if ((!args.includes('report') && !args.includes('clean')) || args.includes('collect')) {
  fns.push(collectRepos);
}

if (args.includes('clean')) {
  fns.push(cleanReportFolder);
}

if (args.includes('report')) {
  fns.push(makeReports);
}

(async function() {
  for (const fn of fns) {
    await fn();
  }
})();
