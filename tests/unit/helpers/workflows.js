'use strict';

// Reads the GitHub workflows of the repository (.github/workflows/*.yml) by their indentation, without a YAML parser
// (none is in the lockfile): the jobs, the steps of a job, a key of a block and the script of a step. The workflows use
// two spaces per level: the jobs at level 1 under `jobs:`, the keys of a job at level 2, its steps at level 3 (`- `) and
// the keys of a step at level 4.
// Used by workflow-pins.test.js and ci-workflows.test.js.

const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../../lib/dev-modules');

const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

// The file names of the workflows
function workflowFiles() {
  return fs.readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name)).sort();
}

function readWorkflow(name) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}

const indentOf = (line) => line.match(/^ */)[0].length;

// The lines of the block that starts after the line `index` (every later line indented deeper, blank lines and deeper
// comments included), without that line; a comment no deeper than the line ends the block, since it belongs to what
// follows it
function blockAfter(lines, index) {
  const indent = indentOf(lines[index]);
  const block = [];
  for (let i = index + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && indentOf(lines[i]) <= indent) {
      break;
    }
    block.push(lines[i]);
  }
  return block;
}

// The jobs of a workflow: { <id>: [lines of the job, without its key line] }, in their order
function jobs(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  if (start < 0) {
    return {};
  }
  const result = {};
  blockAfter(lines, start).forEach((line, index, block) => {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) {
      result[match[1]] = blockAfter(block, index);
    }
  });
  return result;
}

// The value of a key at the given indentation in some lines (the first one), or undefined
function keyValue(lines, indent, key) {
  const pattern = new RegExp('^ {' + indent + '}' + key.replace(/[-]/g, '\\-') + ':(.*)$');
  const line = lines.find((entry) => pattern.test(entry));
  return line === undefined ? undefined : pattern.exec(line)[1].trim();
}

// The block under a key at the given indentation (the first one), also of a literal block (`key: |`), or null
function keyBlock(lines, indent, key) {
  const pattern = new RegExp('^ {' + indent + '}' + key.replace(/[-]/g, '\\-') + ':\\s*(\\|[-+]?)?\\s*$');
  const index = lines.findIndex((entry) => pattern.test(entry));
  return index < 0 ? null : blockAfter(lines, index);
}

// The steps of a job (its lines from jobs()): a list of { lines, name, uses, with, env, run }, with the first line
// `- name: ...` or `- uses: ...` made `  name: ...`, so that every key of a step is at the same indentation (8)
function steps(jobLines) {
  const block = keyBlock(jobLines, 4, 'steps') || [];
  const result = [];
  block.forEach((line) => {
    if (/^ {6}- /.test(line)) {
      result.push({ lines: [line.replace(/^( {6})- /, '$1  ')] });
    } else if (result.length > 0) {
      result[result.length - 1].lines.push(line);
    }
  });
  result.forEach((step) => {
    step.name = keyValue(step.lines, 8, 'name');
    step.uses = keyValue(step.lines, 8, 'uses');
    step.with = keyBlock(step.lines, 8, 'with') || [];
    step.env = keyBlock(step.lines, 8, 'env') || [];
    step.run = runScript(step.lines);
  });
  return result;
}

// The script of a step: `run: |` with its block, unindented, or the value of a one-line `run:`, or null
function runScript(stepLines) {
  const index = stepLines.findIndex((line) => /^ {8}run:/.test(line));
  if (index < 0) {
    return null;
  }
  const value = stepLines[index].replace(/^ {8}run:\s*/, '');
  if (value !== '|') {
    return value;
  }
  const body = blockAfter(stepLines, index);
  while (body.length > 0 && body[body.length - 1].trim() === '') {
    body.pop();
  }
  const indent = Math.min.apply(null, body.filter((line) => line.trim() !== '').map(indentOf));
  return body.map((line) => line.slice(Math.min(indent, line.length))).join('\n');
}

// The entries of a YAML list block (`- value`), without quotes
function listItems(block) {
  return (block || []).filter((line) => /^\s*- /.test(line)).map((line) => line.replace(/^\s*- /, '').trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'));
}

module.exports = { WORKFLOWS_DIR, workflowFiles, readWorkflow, blockAfter, jobs, keyValue, keyBlock, steps, runScript, listItems };
