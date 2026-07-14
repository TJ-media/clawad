#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const data = process.argv[2] || path.join(ROOT, 'data');
const metadataFile = path.join(data, 'sync-schedule.json');

try {
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8').replace(/^\uFEFF/, ''));
  process.env.CLAWAD_DATA = data;
  if (metadata && typeof metadata.server === 'string') process.env.CLAWAD_SERVER = metadata.server;
} catch {
  console.error('자동 sync 설정을 읽을 수 없습니다. `npm run clawad:install`을 다시 실행하세요.');
  process.exit(1);
}

require('./sync');
