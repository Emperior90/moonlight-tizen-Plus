#!/usr/bin/env node
'use strict';

// Checks the local links of the Markdown documents: every link or image that points into the repository must name a file
// or folder that exists, and a link to a heading (#anchor) must match a heading of the target document, with the anchors
// that GitHub derives from the headings. Links to web addresses are not fetched.
//
// It reads inline links and images ([text](target), ![alt](target)), reference definitions ([ref]: target) and the href
// and src attributes of HTML tags, and skips fenced code blocks and inline code.
//
// Usage: node tests/tools/check-markdown-links.js [files...] (default: README.md, CHANGELOG.md and the documents in docs/)

const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

// A target with a scheme (https:, mailto: ...) or a protocol-relative address points outside the repository
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

// List the Markdown files below a folder
function listMarkdown(dir) {
  const files = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push.apply(files, listMarkdown(full));
    } else if (entry.name.endsWith('.md')) {
      files.push(full);
    }
  });
  return files.sort();
}

// The documents that the check reads by default
function defaultFiles() {
  return ['README.md', 'CHANGELOG.md'].map((name) => path.join(REPO_ROOT, name))
    .filter((file) => fs.existsSync(file))
    .concat(listMarkdown(path.join(REPO_ROOT, 'docs')));
}

// Return the lines of a document with fenced code blocks blanked out, so that their content is neither a link nor a
// heading, while the line numbers stay the same
function stripCodeBlocks(source) {
  let fence = null;
  return source.split(/\r?\n/).map((line) => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) {
        fence = null;
      }
      return '';
    }
    if (match) {
      fence = match[1];
      return '';
    }
    return line;
  });
}

// Remove inline code from a line, keeping its length so that nothing inside it is read as a link
function stripInlineCode(line) {
  return line.replace(/(`+)[^`]*?\1/g, (code) => ' '.repeat(code.length));
}

// The anchor that GitHub gives a heading: the text as it is shown (without inline Markdown), lower-cased, without
// punctuation, with spaces turned into hyphens
function headingSlug(text) {
  const shown = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '')
    .replace(/(^|\W)_+|_+(?=\W|$)/g, '$1');
  return shown.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

// Return the anchors of the headings of a document, with the suffix -1, -2 ... that GitHub adds to repeated ones
function headingAnchors(source) {
  const anchors = new Set();
  const counts = {};
  stripCodeBlocks(source).forEach((line) => {
    const match = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (!match) {
      return;
    }
    const slug = headingSlug(match[1]);
    const count = counts[slug] || 0;
    counts[slug] = count + 1;
    anchors.add(count === 0 ? slug : slug + '-' + count);
  });
  // Explicit anchors of HTML tags
  const idPattern = /<[a-z][^>]*\s(?:id|name)="([^"]+)"/gi;
  let match;
  while ((match = idPattern.exec(source)) !== null) {
    anchors.add(match[1]);
  }
  return anchors;
}

// Return the link targets of a document as { line, target }
function extractLinks(source) {
  const links = [];
  stripCodeBlocks(source).forEach((rawLine, index) => {
    const line = stripInlineCode(rawLine);
    const patterns = [
      // Inline links and images, with an optional title after the target
      /!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g,
      // Reference definitions
      /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/g,
      // HTML attributes
      /<[a-z][^>]*\s(?:href|src)="([^"]*)"/gi,
    ];
    patterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        links.push({ line: index + 1, target: match[1] });
      }
    });
  });
  return links;
}

// Check the local links of one document and return its problems
function checkFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const problems = [];
  const anchorCache = {};
  const anchorsOf = (target) => {
    if (!anchorCache[target]) {
      anchorCache[target] = headingAnchors(target === file ? source : fs.readFileSync(target, 'utf8'));
    }
    return anchorCache[target];
  };

  extractLinks(source).forEach((link) => {
    const target = link.target;
    if (target === '' || EXTERNAL_TARGET.test(target)) {
      return;
    }
    const hashIndex = target.indexOf('#');
    const targetPath = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const anchor = hashIndex >= 0 ? target.slice(hashIndex + 1) : '';
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(targetPath.split('?')[0]);
    } catch (error) {
      problems.push(`line ${link.line}: '${target}' is not a valid address`);
      return;
    }
    // GitHub resolves a path that starts with / from the root of the repository
    const resolved = decodedPath === '' ? file
      : (decodedPath.startsWith('/') ? path.join(REPO_ROOT, decodedPath) : path.resolve(path.dirname(file), decodedPath));
    if (!fs.existsSync(resolved)) {
      problems.push(`line ${link.line}: '${target}' points to ${path.relative(REPO_ROOT, resolved) || '.'}, which doesn't exist`);
      return;
    }
    if (anchor !== '' && resolved.endsWith('.md') && fs.statSync(resolved).isFile()) {
      let decodedAnchor = anchor;
      try {
        decodedAnchor = decodeURIComponent(anchor);
      } catch (error) {
        // Compare the anchor as it is written
      }
      if (!anchorsOf(resolved).has(decodedAnchor.toLowerCase())) {
        problems.push(`line ${link.line}: '${target}' names the heading #${anchor}, which ${path.relative(REPO_ROOT, resolved)} doesn't have`);
      }
    }
  });
  return problems;
}

function main() {
  const files = process.argv.length > 2 ? process.argv.slice(2).map((file) => path.resolve(file)) : defaultFiles();
  let links = 0;
  let failures = 0;
  files.forEach((file) => {
    const name = path.relative(REPO_ROOT, file);
    const local = extractLinks(fs.readFileSync(file, 'utf8')).filter((link) => link.target !== '' && !EXTERNAL_TARGET.test(link.target));
    links += local.length;
    const problems = checkFile(file);
    if (problems.length > 0) {
      failures++;
      console.log(`not ok - ${name}`);
      problems.forEach((problem) => console.log(`  # ${problem}`));
    } else {
      console.log(`ok - ${name} (${local.length} local link${local.length === 1 ? '' : 's'})`);
    }
  });
  console.log(`# ${links} local links in ${files.length} Markdown files checked, ${failures} file(s) with problems`);
  process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { checkFile, extractLinks, headingAnchors, headingSlug, defaultFiles };
