'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function distributionConfig() {
  return readJson(path.join(ROOT, 'distribution.json'), {});
}

function serverOrigin() {
  return process.env.CLAWAD_SERVER || distributionConfig().apiOrigin || 'http://localhost:3000';
}

function defaultDataDir() {
  return distributionConfig().apiOrigin ? path.join(os.homedir(), '.clawad') : path.join(ROOT, 'data');
}

function releaseManifestUrl() {
  return process.env.CLAWAD_RELEASE_MANIFEST_URL || distributionConfig().releaseManifestUrl || '';
}

module.exports = { defaultDataDir, distributionConfig, releaseManifestUrl, serverOrigin };
