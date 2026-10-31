'use strict';

// The install() rules of CMakeLists.txt that decide which files of the repository go into the widget (Moonlight.wgt),
// for the test server (which serves what the build installs) and the package check (which finds unused files).
// Only the forms the CMakeLists.txt of this app uses are understood:
//   install(DIRECTORY <dir> DESTINATION widget [PATTERN "<glob>" EXCLUDE ...])
//   install(FILES <file> DESTINATION widget)

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readCMakeLists(repoRoot) {
  return fs.readFileSync(path.join(repoRoot || REPO_ROOT, 'CMakeLists.txt'), 'utf8').replace(/#[^\n]*/g, '');
}

// The folders installed into the widget, as { dir: 'wasm/static', excludes: ['en-US.json', ...] }
function installedDirectories(repoRoot) {
  const result = [];
  const pattern = /install\(\s*DIRECTORY\s+(\S+)\s+DESTINATION\s+widget((?:\s+PATTERN\s+"[^"]+"\s+EXCLUDE)*)\s*\)/g;
  let match;
  while ((match = pattern.exec(readCMakeLists(repoRoot))) !== null) {
    const excludes = [];
    match[2].replace(/PATTERN\s+"([^"]+)"\s+EXCLUDE/g, (all, glob) => excludes.push(glob));
    result.push({ dir: match[1].replace(/\/$/, ''), excludes });
  }
  return result;
}

// The single files installed into the widget (paths relative to the repository)
function installedFiles(repoRoot) {
  const result = [];
  const pattern = /install\(\s*FILES\s+([^\s$)]+)\s+DESTINATION\s+widget\s*\)/g;
  let match;
  while ((match = pattern.exec(readCMakeLists(repoRoot))) !== null) {
    result.push(match[1]);
  }
  return result;
}

// Whether a file or folder name matches a CMake PATTERN glob (CMake matches it against the end of the full path, which
// for the patterns used here is the name)
function matchesGlob(name, glob) {
  const regex = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(name);
}

// Whether a path relative to an installed folder is left out of the widget by one of its EXCLUDE patterns
function isExcluded(relativePath, excludes) {
  return relativePath.split(/[\\/]/).some((part) => excludes.some((glob) => matchesGlob(part, glob)));
}

module.exports = { installedDirectories, installedFiles, isExcluded, matchesGlob };
