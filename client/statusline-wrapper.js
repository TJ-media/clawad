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

const OSC_CLOSE = '\x1b]8;;\x1b\\';
const SGR_RESET = '\x1b[0m';

function safeHyperlinkUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !/[\u0000-\u001f\u007f]/.test(value) ? url.href : null;
  } catch {
    return null;
  }
}

function sanitizeTerminalOutput(value, allowHyperlinks = false) {
  const input = String(value || '');
  let output = '';
  let hyperlinkOpen = false;
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
      let terminatorLength = 0;
      while (end < input.length) {
        if (bellAllowed && input.charCodeAt(end) === 0x07) { terminatorLength = 1; break; }
        if (input.charCodeAt(end) === 0x1b && input[end + 1] === '\\') { terminatorLength = 2; break; }
        end++;
      }
      if (kind === ']' && terminatorLength > 0 && allowHyperlinks) {
        const match = input.slice(i + 2, end).match(/^8;;(.*)$/);
        if (match) {
          if (!match[1] && hyperlinkOpen) {
            output += OSC_CLOSE;
            hyperlinkOpen = false;
          } else {
            const url = safeHyperlinkUrl(match[1]);
            if (url) {
              if (hyperlinkOpen) output += OSC_CLOSE;
              output += `\x1b]8;;${url}\x1b\\`;
              hyperlinkOpen = true;
            }
          }
        }
      }
      i = terminatorLength > 0 ? end + terminatorLength - 1 : input.length;
      continue;
    }
    let end = i + 1;
    while (end < input.length && /[\x20-\x2f]/.test(input[end])) end++;
    if (end < input.length) i = end;
  }
  if (hyperlinkOpen) output += OSC_CLOSE;
  return output;
}

function cleanOutput(value, allowHyperlinks = false) {
  return sanitizeTerminalOutput(value, allowHyperlinks)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, '')
    .trim();
}

function terminalTokens(value) {
  const input = String(value || '');
  const tokens = [];
  for (let i = 0; i < input.length;) {
    const sgr = input.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (sgr) {
      tokens.push({ raw: sgr[0], width: 0, kind: 'sgr' });
      i += sgr[0].length;
      continue;
    }
    const osc = input.slice(i).match(/^\x1b\]8;;[^\x1b]*\x1b\\/);
    if (osc) {
      tokens.push({ raw: osc[0], width: 0, kind: osc[0] === OSC_CLOSE ? 'link-close' : 'link-open' });
      i += osc[0].length;
      continue;
    }
    const [character] = Array.from(input.slice(i));
    tokens.push({ raw: character, width: 1, kind: 'text' });
    i += character.length;
  }
  return tokens;
}

function truncateTerminalOutput(value, maxVisibleChars) {
  const tokens = terminalTokens(value);
  let output = '';
  let width = 0;
  let linkOpen = false;
  let hasSgr = false;
  for (const token of tokens) {
    if (token.width && width + token.width > maxVisibleChars) break;
    output += token.raw;
    width += token.width;
    if (token.kind === 'link-open') linkOpen = true;
    if (token.kind === 'link-close') linkOpen = false;
    if (token.kind === 'sgr') hasSgr = true;
  }
  if (linkOpen) output += OSC_CLOSE;
  if (hasSgr) output += SGR_RESET;
  return output;
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
    if (result.status === 0) clawad = cleanOutput(result.stdout, true);
  } catch {}
}
let combined = '';
if (paused) {
  combined = truncateTerminalOutput(original, maxChars);
} else if (original && clawad) {
  const separator = ' | ';
  const clawadBudget = Math.ceil((maxChars - separator.length) * 3 / 5);
  const originalBudget = maxChars - separator.length - clawadBudget;
  combined = `${truncateTerminalOutput(original, originalBudget)}${separator}${truncateTerminalOutput(clawad, clawadBudget)}`;
} else {
  combined = truncateTerminalOutput(original || clawad, maxChars);
}
console.log(combined || (paused ? '' : 'clawad: 상태 준비 중'));
