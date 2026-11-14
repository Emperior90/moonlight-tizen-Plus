'use strict';

// Checks the name of the directory that holds the box art of a host in the private storage of the app
// (getBoxArtDirName() of wasm/static/js/utils.js, used by NvHTTP.getBoxArt() and NvHTTP.clearBoxArt()). The directory
// was 'wgt-private/' plus the name of the host as the host sent it, for a host that isn't paired over plain HTTP from
// whatever device answered: getBoxArt() creates it and writes files into it, and clearBoxArt() deletes it with
// everything in it. A name such as '..' or '.' or one with a slash named another directory than the one meant, e.g.
// the private storage itself. Now letters and digits of every script, spaces, '_', '-' and '.' stay, every other
// character becomes '_', and a name of nothing but dots and spaces gives a name made of the unique ID of the host, so
// the directory is always one directory right below wgt-private, whatever the file system of the TV makes of '..'.
// The names of ordinary hosts map to themselves, so the box art that an earlier version cached stays in use.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { REPO_ROOT } = require('../lib/dev-modules');
const { createPlatformContext, plain } = require('./helpers/platform-loader');

const UID = 'F3E2D1C0-B9A8-4765-8432-10FEDCBA9876';

// A FileReader that turns a Blob into a data URL at once, as far as getBoxArt() needs it
function TestFileReader() {}
TestFileReader.prototype.readAsDataURL = function() {
  this.result = 'data:image/png;base64,iVBORw0KGgo=';
  if (this.onloadend) {
    this.onloadend();
  }
};

// utils.js with a file system of the TV that has no files and records what is asked of it, and a host that answers a
// box art download at once
function loadUtils() {
  const calls = [];
  const platform = createPlatformContext({
    globals: {
      crypto: webcrypto,
      Blob,
      FileReader: TestFileReader,
      sendMessage() {
        return Promise.resolve(new Uint8Array([1, 2, 3]));
      },
    },
  });
  platform.context.tizen.filesystem = {
    openFile(file, mode) {
      calls.push('openFile ' + mode + ' ' + file);
      if (mode === 'r') {
        throw new Error('NotFoundError');
      }
      return { writeData() {}, close() {} };
    },
    createDirectory(directory) {
      calls.push('createDirectory ' + directory);
    },
    deleteDirectory(directory, recursive) {
      calls.push('deleteDirectory ' + directory + ' ' + recursive);
    },
    deleteFile(file) {
      calls.push('deleteFile ' + file);
    },
    listDirectory(directory, onSuccess) {
      calls.push('listDirectory ' + directory);
      onSuccess([]);
    },
  };
  platform.load('wasm/static/js/utils.js');
  return { platform, calls, dirName: platform.get('getBoxArtDirName') };
}

test('the names of ordinary hosts are the names of their directories, as before', () => {
  const { dirName } = loadUtils();
  ['GAMING-PC', 'DESKTOP-4F7K2QX', 'gaming-pc', 'Living Room PC', 'My_PC', 'pc.lan', 'Office-MacBook-Pro.local', 'PC 2', 'a', 'UNKNOWN', '.hidden', 'a..b', '...a',
    'Büro-PC', 'ゲーミングPC', 'Игровой ПК', '게임용 PC', 'मेरा पीसी', '10.0.0.2', 'a'.repeat(64)].forEach((name) => {
    assert.equal(dirName(name, UID), name, name);
  });
});

test('a name never leaves the directory that is meant: no separator, no other character, not only dots', () => {
  const { dirName } = loadUtils();
  // A name of nothing but dots and spaces, or no name: a name made of the unique ID of the host
  ['..', '.', '...', '', ' ', '. .', ' .. ', undefined, null].forEach((name) => {
    assert.equal(dirName(name, UID), 'host-' + UID, JSON.stringify(name));
  });
  assert.equal(dirName('..', 'A1B2C3D4E5F60718'), 'host-A1B2C3D4E5F60718');
  // Without an ID that the app takes, still a plain name
  ['', undefined, '../x', '__proto__', 'a b'].forEach((uid) => assert.equal(dirName('..', uid), 'host-unknown', String(uid)));

  // Every other character becomes '_'
  const cases = {
    'a/b': 'a_b',
    'a\\b': 'a_b',
    '../..': '.._..',
    '../../etc/passwd': '.._.._etc_passwd',
    '..\\..\\x': '.._.._x',
    '/absolute': '_absolute',
    'C:\\Users': 'C__Users',
    'a:b': 'a_b',
    'a\u0000b': 'a_b',
    'a\nb\tc': 'a_b_c',
    'Kid\'s PC': 'Kid_s PC',
    'PC (4090)': 'PC _4090_',
    'a*b?c"d<e>f|g': 'a_b_c_d_e_f_g',
    '%2e%2e%2f': '_2e_2e_2f',
    'a%00': 'a_00',
    '~': '_',
    'PC😀': 'PC_',
    // Dots that are none of the file system: the one dot leader and the fullwidth full stop
    '\u2024\u2024': '__',
    '\uff0e\uff0e/x': '___x',
  };
  Object.keys(cases).forEach((name) => assert.equal(dirName(name, UID), cases[name], JSON.stringify(name)));

  // Whatever the name: one plain directory name of at most 64 characters, never '.', '..' or empty
  const hostile = Object.keys(cases).concat(['..', '.', '', 'x'.repeat(100000), '/'.repeat(300), '.'.repeat(300), '😀'.repeat(100), 'a'.repeat(63) + '𐌰𐌱',
    '\ud800', 'ä'.repeat(100), '. '.repeat(40)]);
  hostile.forEach((name) => {
    const result = dirName(name, UID);
    assert.match(result, /^[\p{L}\p{M}\p{N} _.-]{1,64}$/u, JSON.stringify(name.slice(0, 40)));
    assert.equal(/^[. ]*$/.test(result), false, JSON.stringify(name.slice(0, 40)));
    assert.equal(/[\ud800-\udbff]$/.test(result), false, JSON.stringify(name.slice(0, 40)));
  });
  // A very long name is cut
  assert.equal(dirName('x'.repeat(100000), UID), 'x'.repeat(64));
  assert.equal(dirName('GAMING-PC-' + 'x'.repeat(100), UID), 'GAMING-PC-' + 'x'.repeat(54));
});

test('the box art of a host is read, written and cleared in that directory only', async () => {
  for (const [hostname, directory] of [['GAMING-PC', 'wgt-private/GAMING-PC'], ['..', 'wgt-private/host-' + UID], ['.', 'wgt-private/host-' + UID],
    ['../../documents', 'wgt-private/.._.._documents'], ['a/b', 'wgt-private/a_b'], ['', 'wgt-private/host-' + UID]]) {
    const { platform, calls } = loadUtils();
    platform.context.__hostname = hostname;
    platform.context.__uid = UID;
    await platform.run(`(function() {
      var host = new NvHTTP('10.0.0.2', 'CLIENT');
      host.hostname = __hostname;
      host.serverUid = __uid;
      host.ppkstr = 'PPK';
      host._baseUrlHttps = 'https://10.0.0.2:47984';
      window.__host = host;
      return host.getBoxArt(7, false).then(function() { return host.clearBoxArt(); });
    })()`);
    assert.deepEqual(plain(calls), [
      'openFile r ' + directory + '/boxart-7.png',
      'createDirectory ' + directory,
      'openFile w ' + directory + '/boxart-7.png',
      'deleteDirectory ' + directory + ' true',
      'listDirectory documents',
    ], JSON.stringify(hostname));
  }
});

test('no path is built from the name of a host as it is', () => {
  const utils = fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/js/utils.js'), 'utf8');
  assert.equal((utils.match(/var boxArtDir = 'wgt-private\/' \+ getBoxArtDirName\(this\.hostname, this\.serverUid\);/g) || []).length, 2);
  // The private storage is named in these two places only, and the other scripts build no path of the file system
  assert.equal((utils.match(/'wgt-private/g) || []).length, 2);
  ['wasm/platform/index.js', 'wasm/platform/menus.js', 'wasm/platform/launcher.js', 'wasm/platform/navigation.js', 'wasm/static/js/mdns-browser/main.js'].forEach((file) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    assert.equal(/wgt-private/.test(source), false, file);
    assert.equal(/tizen\.filesystem\.\w+\([^)]*hostname/.test(source), false, file);
  });
  // The files of the Smart Hub previews are named after the ID of the app, a number (parseAppListEntry())
  assert.match(utils, /var previewFileName = SMART_HUB_PREVIEW_FILE_PREFIX \+ appId \+ '\.jpg';/);
});
