#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED = /(?:^|\/)(?:node_modules|vendor|dist|fixtures?)\/|\.d\.ts$|\.min\.js$/;
const DIRECTIVE = /^(?:\/\/\/\s*<reference|\/[/*]\s*(?:prettier-ignore|eslint-disable(?:-next-line|-line)?\s+[\w@/-]+|eslint-enable|@ts-expect-error\s+\S|@ts-nocheck\s+\S|biome-ignore|c8 ignore|istanbul ignore|node:coverage|@vitest-environment|[#@]__PURE__)|\/\*\*?\s*@jsx(?:ImportSource|Runtime|Frag)?\s)/;
const LICENSE = /\b(?:license|copyright|spdx-license-identifier)\b/i;
const LINK = /https?:\/\/\S*(?:\/issues\/\d+|\/pull\/\d+|rfc-editor\.org|datatracker\.ietf\.org|\/rfc\d+)/i;
const EXTERNAL = /^\/[/*]\s*external:\s*\S/;
const PUBLIC_DOC = /^\s*(?:export|module\.exports|exports\.)/;
const REGEX_AFTER_WORD = /(?:^|[^\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

export function findComments(text) {
  const comments = [];
  const templateDepth = [];
  let lastSignificant = '';
  let i = 0;
  const regexAllowed = () => {
    if (!lastSignificant) return true;
    const last = lastSignificant.at(-1);
    if (/[\w$]/.test(last)) return REGEX_AFTER_WORD.test(lastSignificant);
    return !/[)\]}'"`]/.test(last);
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (i === 0 && ch === '#' && next === '!') {
      i = text.indexOf('\n');
      if (i < 0) break;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      comments.push({ start: i, end: stop });
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      comments.push({ start: i, end: stop });
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < text.length && text[i] !== ch && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i++;
      lastSignificant = ch;
      continue;
    }
    if (ch === '`' || (ch === '}' && templateDepth.at(-1) === 0)) {
      if (ch === '}') templateDepth.pop();
      i++;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '$' && text[i + 1] === '{') { templateDepth.push(0); i += 2; break; }
        i++;
      }
      if (text[i] === '`') { i++; lastSignificant = '`'; }
      else lastSignificant = '{';
      continue;
    }
    if (ch === '{' && templateDepth.length) templateDepth[templateDepth.length - 1]++;
    if (ch === '}' && templateDepth.length) templateDepth[templateDepth.length - 1]--;
    if (ch === '/' && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < text.length && text[i] !== '\n') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(text[i] ?? '')) i++;
      lastSignificant = ')';
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (/[\w$]/.test(ch)) {
      const start = i;
      while (i < text.length && /[\w$]/.test(text[i])) i++;
      lastSignificant = (lastSignificant + ' ' + text.slice(start, i)).slice(-40);
      continue;
    }
    lastSignificant = ch;
    i++;
  }
  return comments;
}

const EXPORTED_BLOCK = /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|enum|namespace|const|function)\b/;

function insideExport(text, start) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  if (!/^\s+$/.test(text.slice(lineStart, start))) return false;
  const lines = text.slice(0, lineStart).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || /^[\s/*]/.test(line)) continue;
    return EXPORTED_BLOCK.test(line);
  }
  return false;
}

export function isAllowed(text, comment, isFirst) {
  const body = text.slice(comment.start, comment.end);
  if (DIRECTIVE.test(body) || EXTERNAL.test(body) || LINK.test(body)) return true;
  if (isFirst && LICENSE.test(body)) return true;
  if (!body.startsWith('/**')) return false;
  return PUBLIC_DOC.test(text.slice(comment.end, comment.end + 200)) || insideExport(text, comment.start);
}

export function lintText(text) {
  return findComments(text).filter((comment, index) => !isAllowed(text, comment, index === 0));
}

const IGNORED = existsSync('.lint-comments-ignore')
  ? readFileSync('.lint-comments-ignore', 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  : [];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(file => SOURCE.test(file) && !SKIPPED.test(file) && !IGNORED.some(prefix => file.startsWith(prefix)));
}

function lineColumn(text, offset) {
  const before = text.slice(0, offset).split('\n');
  return `${before.length}:${before.at(-1).length + 1}`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('lint-comments.mjs')) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : trackedFiles();
  const problems = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const comment of lintText(text)) {
      problems.push(`${file}:${lineColumn(text, comment.start)} ${text.slice(comment.start, comment.end).split('\n')[0].slice(0, 100)}`);
    }
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\nlint:comments: ${problems.length} comment(s). Make the code say it (names, types, tests) and delete the comment.`);
    console.error('Allowed: license header, /** */ on exports, issue/RFC links, tool directives, `// external: <vendor/platform constraint>`.');
    process.exit(1);
  }
  console.log('lint:comments: ok');
}
