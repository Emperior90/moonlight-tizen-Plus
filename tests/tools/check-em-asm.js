#!/usr/bin/env node
'use strict';

// Checks the EM_ASM blocks of the native code for the limit of Emscripten 1.39, the toolchain of the Samsung build:
// its EM_ASM macros take the JavaScript code block as their first macro argument, and the C preprocessor ends a macro
// argument at the first comma outside parentheses. Braces and brackets don't protect a comma, so e.g.
// `var a = 1, b = 2;` or `[1, 2]` at the top level of the block splits it, which breaks the build only in the Docker
// image. String and character literals and comments do protect it, as the preprocessor sees them as single tokens.
//
// The check reads every EM_ASM-style macro call in wasm/ like the preprocessor does and fails when its first
// argument ends inside the braces of the code block.
//
// Usage: node tests/tools/check-em-asm.js [files...] (default: the C and C++ files in wasm/)

const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const MACRO_PATTERN = /\b((?:MAIN_THREAD_(?:ASYNC_)?)?EM_ASM(?:_INT|_DOUBLE|_ARGS|_INT_V|_DOUBLE_V)?)\s*\(/g;
const SOURCE_PATTERN = /\.(c|cc|cpp|h|hpp)$/;

// List the C and C++ files below a folder
function listSources(dir) {
  const files = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push.apply(files, listSources(full));
    } else if (SOURCE_PATTERN.test(entry.name)) {
      files.push(full);
    }
  });
  return files.sort();
}

// Return the line number of an offset in the source
function lineOf(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

// Read the first macro argument from just after the opening parenthesis, skipping literals and comments.
// Returns where it ends, how it ends (',' or ')') and the brace depth there, or null for an unterminated call.
function readFirstArgument(source, start) {
  let parens = 0;
  let braces = 0;
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      i++;
      while (i < source.length && source[i] !== ch && source[i] !== '\n') {
        i += source[i] === '\\' ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === '(') {
      parens++;
    } else if (ch === ')') {
      if (parens === 0) {
        return { end: i, terminator: ')', braces };
      }
      parens--;
    } else if (ch === ',' && parens === 0) {
      return { end: i, terminator: ',', braces };
    } else if (ch === '{') {
      braces++;
    } else if (ch === '}') {
      braces--;
    }
    i++;
  }
  return null;
}

// List the EM_ASM-style macro calls of a source with their macro, line and code block (the first macro argument, with
// its braces), skipping the definitions of the macros themselves and calls that are never closed
function findBlocks(source) {
  const blocks = [];
  let match;
  const pattern = new RegExp(MACRO_PATTERN.source, 'g');
  while ((match = pattern.exec(source)) !== null) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    if (/^\s*#\s*define\b/.test(source.slice(lineStart, match.index))) {
      continue;
    }
    const start = match.index + match[0].length;
    const argument = readFirstArgument(source, start);
    if (argument) {
      blocks.push({ macro: match[1], line: lineOf(source, match.index), code: source.slice(start, argument.end).trim() });
    }
  }
  return blocks;
}

// Check one file and return its problems
function checkFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const problems = [];
  let match;
  MACRO_PATTERN.lastIndex = 0;
  while ((match = MACRO_PATTERN.exec(source)) !== null) {
    // Skip the definitions of the macros themselves
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    if (/^\s*#\s*define\b/.test(source.slice(lineStart, match.index))) {
      continue;
    }
    const argument = readFirstArgument(source, match.index + match[0].length);
    const line = lineOf(source, match.index);
    if (!argument) {
      problems.push(`line ${line}: ${match[1]}( is never closed`);
    } else if (argument.braces !== 0) {
      problems.push(`line ${line}: the code block of ${match[1]} is split at line ${lineOf(source, argument.end)} by a '${argument.terminator}' ` +
        'outside parentheses, which Emscripten 1.39 reads as the end of the code block');
    }
  }
  return problems;
}

function main() {
  const files = process.argv.length > 2
    ? process.argv.slice(2).map((file) => path.resolve(file))
    : listSources(path.join(REPO_ROOT, 'wasm'));
  let blocks = 0;
  let failures = 0;
  files.forEach((file) => {
    const source = fs.readFileSync(file, 'utf8');
    const count = (source.match(MACRO_PATTERN) || []).length;
    blocks += count;
    const problems = checkFile(file);
    const name = path.relative(REPO_ROOT, file);
    if (problems.length > 0) {
      failures++;
      console.log(`not ok - ${name}`);
      problems.forEach((problem) => console.log(`  # ${problem}`));
    } else if (count > 0) {
      console.log(`ok - ${name} (${count} EM_ASM block${count === 1 ? '' : 's'})`);
    }
  });
  console.log(`# ${blocks} EM_ASM blocks in ${files.length} files checked, ${failures} file(s) with problems`);
  process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { checkFile, findBlocks };
