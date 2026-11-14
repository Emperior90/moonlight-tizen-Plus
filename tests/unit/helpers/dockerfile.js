'use strict';

// Reads a Dockerfile the way Docker does: one entry per instruction, with the comment lines dropped (also inside an
// instruction that continues over several lines) and the line continuations removed. Used by dockerfile-metadata.test.js
// and dockerfile-downloads.test.js, which run instructions of the Dockerfile of the repository with `sh`.

const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../../lib/dev-modules');

// The text of the Dockerfile of the repository
function readDockerfile() {
  return fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
}

// Return the instructions of a Dockerfile as { name, args, line }: the name in upper case (e.g. 'RUN'), the rest of
// the instruction joined to one line, and the number of the line it starts on
function dockerInstructions(text) {
  const instructions = [];
  let current = null;
  text.split(/\r?\n/).forEach((line, index) => {
    // Docker drops comment lines, also inside an instruction that continues over several lines
    if (/^\s*#/.test(line)) {
      return;
    }
    if (current === null) {
      const start = /^\s*([A-Za-z]+)\s+(.*)$/.exec(line);
      if (!start) {
        return;
      }
      current = { name: start[1].toUpperCase(), args: '', line: index + 1 };
      line = start[2];
    }
    if (/\\[ \t]*$/.test(line)) {
      current.args += line.replace(/\\[ \t]*$/, '');
    } else {
      current.args += line;
      instructions.push(current);
      current = null;
    }
  });
  return instructions;
}

// Return the RUN instructions of a Dockerfile as the shell commands Docker runs
function dockerRunCommands(text) {
  return dockerInstructions(text).filter((instruction) => instruction.name === 'RUN').map((instruction) => instruction.args);
}

module.exports = { readDockerfile, dockerInstructions, dockerRunCommands };
