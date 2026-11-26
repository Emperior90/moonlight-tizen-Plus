'use strict';

// Every element that the views of wasm/platform/navigation.js name by its id exists: in wasm/index.html, or for the few
// that the app makes as it shows them, in the function that makes them (index.js). A view that names an id that is
// gone selects nothing, so its keys do nothing or throw (as the Wake PC dialog did in 2.1.0), and only a browser test
// that happens to open that view would see it. Since 2.3.5 (TEST-3); tests/browser/return-key.test.js presses RETURN
// in the views that no other test went back from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// The functions of navigation.js that take the id of an element as their first argument
const ID_FUNCTIONS = ['resolveElement', 'focusElement', 'clickElement', 'blurElement', 'mark', 'unmark', 'isPopupMenuActive',
  'closePopupMenu', 'selectHostsNavButton', 'getElementById', 'getOverlayMenuItems'];

// The ids that index.js makes when it shows them, with the function that makes each
const MADE_IN_JS = { updateAppBtn: 'updateAppButton', closeHostMenu: 'hostMenuDialog', closeHostDetails: 'hostDetailsDialog' };

// Drop the comments of a piece of JavaScript (whole-line and trailing ones, which hold apostrophes)
function stripComments(source) {
  return source.split('\n').map((line) => line.replace(/(^|[^:'"])\/\/.*$/, '$1')).join('\n');
}

// The part of the source from `start` to its matching closing parenthesis
function balancedCall(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '(') {
      depth++;
    } else if (source[i] === ')') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error('No end of the call at ' + start);
}

// The ids that navigation.js names, each with where: the argument of one of ID_FUNCTIONS, a selector $('#id…'), and
// the items of the lists of the views (new ListView(…)): a string that is an element of an array (after '[' or ',',
// or a branch of '? :'), or that goes into one with push()
function namedIds(source) {
  const code = stripComments(source);
  const ids = new Map();
  const add = (id, where) => {
    if (!ids.has(id)) {
      ids.set(id, []);
    }
    ids.get(id).push(where);
  };
  let match;
  const calls = new RegExp('\\b(' + ID_FUNCTIONS.join('|') + ")\\('([^']*)'", 'g');
  while ((match = calls.exec(code)) !== null) {
    add(match[2], match[1] + '()');
  }
  const selectors = /\$\('#([\w-]+)/g;
  while ((match = selectors.exec(code)) !== null) {
    add(match[1], '$()');
  }
  let start = 0;
  while ((start = code.indexOf('new ListView(', start)) >= 0) {
    const body = balancedCall(code, start + 'new ListView'.length);
    const line = code.slice(0, start).split('\n').length;
    const items = /(\[|,|\?|:|push\()\s*'([A-Za-z][\w-]*)'\s*(?=[,\]:)])/g;
    while ((match = items.exec(body)) !== null) {
      add(match[2], 'ListView of line ' + line);
    }
    start += body.length;
  }
  return ids;
}

// The source of a top-level function of a script, from its declaration to its closing brace at the start of a line
function functionSource(source, name) {
  const start = source.indexOf('\nfunction ' + name + '(');
  assert.ok(start >= 0, 'index.js has no function ' + name + '()');
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 3);
}

test('every id that the views of navigation.js name is an element of index.html or made by its function in index.js', () => {
  const html = read('wasm/index.html');
  const pageIds = new Set();
  let match;
  const idAttributes = /\bid="([^"]+)"/g;
  while ((match = idAttributes.exec(html)) !== null) {
    pageIds.add(match[1]);
  }
  const ids = namedIds(read('wasm/platform/navigation.js'));
  // The scan finds the ids (108 in 2.3.5), among them those of every kind of place
  assert.ok(ids.size >= 100, 'only ' + ids.size + ' ids found');
  ['cancelExitApp', 'continueAddHost', 'streamQuitPanel', 'selectResolution', 'navigationGuideBtn', 'decryptHostAudioBtn',
    'quitRunningAppBtn', 'continueWarning', 'closeDiagnosticLog'].forEach((id) => {
    assert.ok(ids.has(id), 'the scan misses ' + id);
  });
  const missing = [];
  ids.forEach((where, id) => {
    if (!pageIds.has(id) && !MADE_IN_JS[id]) {
      missing.push(id + ' (' + where.join(', ') + ')');
    }
  });
  assert.deepEqual(missing, []);

  // The ids made in JS: named by navigation.js, not in the page, and given by their function in index.js
  const index = read('wasm/platform/index.js');
  Object.keys(MADE_IN_JS).forEach((id) => {
    assert.ok(ids.has(id), id + ' is no longer named by navigation.js: drop it from MADE_IN_JS');
    assert.equal(pageIds.has(id), false, id + ' is in index.html now: drop it from MADE_IN_JS');
    assert.ok(functionSource(index, MADE_IN_JS[id]).indexOf("'" + id + "'") >= 0, MADE_IN_JS[id] + '() of index.js no longer makes ' + id);
  });
});

test('the scan of the ids sees a renamed id', () => {
  // A copy of navigation.js in which the Cancel button of Exit Moonlight has another name
  const source = read('wasm/platform/navigation.js');
  assert.ok(source.indexOf("'cancelExitApp'") >= 0);
  const renamed = namedIds(source.split("'cancelExitApp'").join("'cancelExitApplication'"));
  assert.equal(renamed.has('cancelExitApp'), false);
  assert.ok(renamed.has('cancelExitApplication'));
  assert.equal(read('wasm/index.html').indexOf('id="cancelExitApplication"'), -1);
  // Comments are no ids: the apostrophe of "doesn't" in the comment of the Advanced Settings list
  assert.equal(namedIds("view: new ListView(() => [\n  'a1',\n  // doesn't apply\n  'b2'\n])").size, 2);
});
