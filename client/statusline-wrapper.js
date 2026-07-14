#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { defaultDataDir } = require('./distribution-config');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || defaultDataDir();
const COMPOSITION_FILE = path.join(DATA, 'statusline-composition.json');
const PAUSE_FILE = path.join(DATA, 'paused');
const STATUSLINE = path.join(__dirname, 'statusline.js');
let timeoutMs = 500;
let clawadTimeoutMs = 1000;
let maxChars = 160;
try {
  const policy = require('../policy/policy').loadPolicy().statusLine;
  timeoutMs = policy.originalCommandTimeoutMs;
  clawadTimeoutMs = policy.clawadCommandTimeoutMs;
  maxChars = policy.maxOriginalOutputChars;
} catch {}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function parseCommand(command) {
  if (typeof command !== 'string' || !command.trim() || /[;&|`<>\r\n]|\$\(/.test(command)) return null;
  const parts = [];
  let value = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length && ['"', '\\'].includes(command[i + 1])) value += command[++i];
      else value += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) { if (value) { parts.push(value); value = ''; } }
    else value += ch;
  }
  if (quote) return null;
  if (value) parts.push(value);
  return parts.length ? { executable: parts[0], args: parts.slice(1) } : null;
}

function sanitizeTerminalOutput(value) {
  const input = String(value || '');
  let output = '';
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) !== 0x1b) {
      output += input[i];
      continue;
    }
    const kind = input[i + 1];
    if (kind === '[') {
      let end = i + 2;
      while (end < input.length && !/[\x40-\x7e]/.test(input[end])) end++;
      if (end >= input.length) break;
      const params = input.slice(i + 2, end);
      if (input[end] === 'm' && /^[0-9;]*$/.test(params)) output += input.slice(i, end + 1);
      i = end;
      continue;
    }
    if (kind === ']' || ['P', 'X', '^', '_'].includes(kind)) {
      const bellAllowed = kind === ']';
      let end = i + 2;
      while (end < input.length) {
        if (bellAllowed && input.charCodeAt(end) === 0x07) { end++; break; }
        if (input.charCodeAt(end) === 0x1b && input[end + 1] === '\\') { end += 2; break; }
        end++;
      }
      i = end - 1;
      continue;
    }
    let end = i + 1;
    while (end < input.length && /[\x20-\x2f]/.test(input[end])) end++;
    if (end < input.length) i = end;
  }
  return output;
}

function cleanOutput(value) {
  return sanitizeTerminalOutput(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, '')
    .trim();
}

function run(command, input) {
  const parsed = parseCommand(command);
  if (!parsed) return '';
  try {
    const result = spawnSync(parsed.executable, parsed.args, {
      input, encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs,
      env: process.env, maxBuffer: 64 * 1024,
    });
    return result.status === 0 ? cleanOutput(result.stdout) : '';
  } catch { return ''; }
}

const input = fs.readFileSync(0, 'utf8');
const composition = readJson(COMPOSITION_FILE, {});
const original = run(composition.originalCommand, input);
let clawad = '';
const paused = fs.existsSync(PAUSE_FILE);
if (!paused) {
  try {
    const result = spawnSync(process.execPath, [STATUSLINE], { input, encoding: 'utf8', shell: false, windowsHide: true, timeout: clawadTimeoutMs, env: process.env });
    if (result.status === 0) clawad = cleanOutput(result.stdout);
  } catch {}
}
const combined = [original, clawad].filter(Boolean).join(' | ').slice(0, maxChars);
console.log(paused ? original.slice(0, maxChars) : combined || 'clawad: 상태 준비 중');
