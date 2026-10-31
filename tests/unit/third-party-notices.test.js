'use strict';

// Checks wasm/static/licenses/THIRD-PARTY-NOTICES.txt, which the widget gets with wasm/static, and the GPL-3.0 text
// LICENSE, which CMakeLists.txt installs into the widget: a .wgt is often passed on without the repository, and the
// licences of its parts ask for their notices in every copy (the binary clauses of BSD, MIT and NCSA, clauses 2 and 6
// of OpenSSL, section 4(a) of the Apache License 2.0 and section 4 of the GPL-3.0).
// - the header says what Moonlight Plus is, that it is free software under the GPL-3.0 WITHOUT ANY WARRANTY, where its
//   source is, and gives the copyright lines and the forks whose code was ported
// - every component of the package has an entry with its version and licence: the libraries that CMakeLists.txt
//   compiles and the ports it links (USE_CRYPTO, USE_SSL, USE_CURL), the Emscripten runtime, and the third-party files
//   of wasm/static
// - the licence texts are complete: the vendored ones (ENet, Opus, the header of rs.c) as in the repository, the others
//   by sentences from each text, with the ISC licence of the inet_ntop.c that the port of curl builds; the Apache License
//   2.0 once for both components that use it
// - the e-mail addresses of the licence texts as published (the SSLeay acknowledgment must be kept with them), and no
//   entry for Material Icons, whose glyphs the app no longer has

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { installedDirectories, installedFiles } = require('../lib/widget-files');

const NOTICES_FILE = 'wasm/static/licenses/THIRD-PARTY-NOTICES.txt';
const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const notices = () => read(NOTICES_FILE);
// Whitespace and line breaks don't count
const flat = (text) => text.replace(/\s+/g, ' ').trim();

// The entries "[n] Name ..." of the notices, as { number, text } up to the next entry
function entries() {
  const text = notices();
  const found = [];
  const pattern = /^\[(\d+)\] /gm;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.push({ number: Number(match[1]), start: match.index });
  }
  return found.map((entry, index) => ({
    number: entry.number,
    text: text.slice(entry.start, index + 1 < found.length ? found[index + 1].start : text.indexOf('\nLICENCE TEXTS\n')),
  }));
}
function entry(name) {
  const matching = entries().filter((item) => item.text.replace(/^\[\d+\] /, '').indexOf(name) === 0);
  assert.equal(matching.length, 1, 'one entry for ' + name);
  return matching[0].text;
}

test('the notices ship in the widget with the GPL-3.0 text, and common.js points to the Chromium licence', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, NOTICES_FILE)));
  const staticDir = installedDirectories(REPO_ROOT).find((item) => item.dir === 'wasm/static');
  assert.ok(staticDir, 'CMakeLists.txt installs wasm/static');
  assert.deepEqual(staticDir.excludes.filter((glob) => /licen|NOTICE|\.txt/i.test(glob)), []);
  assert.ok(installedFiles(REPO_ROOT).indexOf('LICENSE') >= 0, 'CMakeLists.txt installs LICENSE into the widget');
  assert.match(read('LICENSE'), /^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  // The header of Chromium stays as it is, with a pointer to its licence text
  assert.deepEqual(read('wasm/platform/common.js').split('\n').slice(0, 4), [
    '// Copyright (c) 2012 The Chromium Authors. All rights reserved.',
    '// Use of this source code is governed by a BSD-style license that can be',
    '// found in the LICENSE file.',
    '// The Chromium BSD license text is in static/licenses/THIRD-PARTY-NOTICES.txt.',
  ]);
});

test('the header gives the licence, the missing warranty, the source and the copyright lines', () => {
  const header = flat(notices().slice(0, notices().indexOf('\nTHIRD-PARTY COMPONENTS\n')));
  assert.match(header, /Moonlight Plus is an unofficial fork of Moonlight Tizen for Samsung Smart TVs/);
  assert.match(header, /under the terms of the GNU General Public License as published by the Free Software Foundation, version 3/);
  assert.match(header, /WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE/);
  assert.match(header, /The full text of the GPL-3\.0 is in the file LICENSE at the top of the app package/);
  assert.ok(header.indexOf('Source code: https://github.com/Emperior90/moonlight-tizen-Plus') >= 0);
  ['Moonlight Tizen: Copyright (C) brightcraft and the contributors of Moonlight Tizen',
    'Copyright (C) the Moonlight Game Streaming Project',
    'libgamestream of Moonlight Embedded: Copyright (C) 2015 Iwan Timmer',
    'Copyright (c) 2015 Samsung Electronics',
    'Copyright (c) 2012 The Chromium Authors',
    'Moonlight Plus changes: Copyright (C) 2026 Emperior90, made with AI assistance',
  ].forEach((line) => assert.ok(header.indexOf(line) >= 0, line));
  // The forks whose code or translations were ported, all GPL-3.0
  assert.match(header, /CODE FROM OTHER FORKS OF MOONLIGHT TIZEN \(GPL-3\.0\)/);
  ['fidoboy/moonlight-tizen-ac3', 'mmadej20/moonlight-tizen-modern', 'samirmartins/moonlight-tizen', 'Diogo8500/moonlight-tizen',
    'waresz/moonlight-tizen'].forEach((fork) => assert.ok(header.indexOf('https://github.com/' + fork) >= 0, fork));
  assert.match(header, /Portions Copyright \(C\) fidoboy, mmadej20, samirmartins, Diogo8500, waresz/);
});

test('every component of the package has an entry with its version and licence', () => {
  const expected = [
    ['moonlight-common-c', /Licence: GPL-3\.0/],
    ['libgamestream', /GPL-3\.0, or \(at your option\) any later version/],
    ['platform.js of the Tizen port', /Licence: GPL-3\.0/],
    ['ENet 1.3.17', /Licence: MIT license/],
    ['Reed-Solomon', /Licence: BSD 2-Clause license/],
    ['Opus 1.5.2', /Licence: BSD 3-Clause license/],
    ['OpenSSL 1.1.1d', /Licence: OpenSSL License and original SSLeay License/],
    ['curl 7.68.0', /Licence: curl license \(MIT\/X derivative\); lib\/inet_ntop\.c: ISC license/],
    ['zlib 1.2.8', /Licence: zlib license/],
    ['Emscripten 1.39.4.7', /Licence: MIT license and University of Illinois\/NCSA Open Source License/],
    ['TizenTV Emscripten extensions', /Copyright 2020 Samsung Electronics[\s\S]*Licence: MIT license and University of Illinois\/NCSA/],
    ['musl libc', /Licence: MIT license/],
    ['libc++,', /Licence: University of Illinois\/NCSA Open Source License and MIT license/],
    ['libc++abi', /Licence: University of Illinois\/NCSA Open Source License and MIT license/],
    ['compiler-rt', /Licence: University of Illinois\/NCSA Open Source License and MIT license/],
    ['jQuery 2.2.0', /Licence: MIT license/],
    ['Material Design Lite 1.3.0', /Copyright 2015 Google, Inc\.[\s\S]*Licence: Apache License 2\.0/],
    ['Roboto 2.137', /Copyright 2011 Google Inc\. All Rights Reserved\.[\s\S]*Licence: Apache License 2\.0/],
    ['Manrope', /Copyright 2018 The Manrope Project Authors[\s\S]*SIL Open Font License 1\.1[\s\S]*static\/fonts\/Manrope-OFL\.txt/],
    ['common.js of the Native Client SDK', /Licence: BSD 3-Clause license of Chromium/],
  ];
  expected.forEach(([name, licence]) => assert.match(entry(name), licence, name));
  assert.deepEqual(entries().map((item) => item.number), expected.map((item, index) => index + 1));
  // The OpenSSL entry repeats its acknowledgments and names the open licence issue
  const openssl = flat(entry('OpenSSL 1.1.1d'));
  assert.ok(openssl.indexOf('This product includes software developed by the OpenSSL Project for use in the OpenSSL Toolkit (http://www.openssl.org/).') >= 0);
  assert.ok(openssl.indexOf('This product includes cryptographic software written by Eric Young (eay@cryptsoft.com).') >= 0);
  assert.match(openssl, /Known licence issue: the Free Software Foundation considers the OpenSSL\/SSLeay licence incompatible with the GPL/);
  assert.match(openssl, /OpenSSL 3 or mbedTLS/);
  // The port of curl builds its own inet_ntop.c (its curl_config.h has no HAVE_INET_NTOP), whose ISC licence asks for its
  // notice in all copies as well
  const curl = flat(entry('curl 7.68.0'));
  const isc = curl.slice(curl.indexOf('libcurl also contains lib/inet_ntop.c (original code by Paul Vixie)'));
  assert.ok(isc.length < curl.length, 'the paragraph about inet_ntop.c');
  ['Copyright (C) 1996-2019 Internet Software Consortium.',
    'Permission to use, copy, modify, and distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.',
    'THE SOFTWARE IS PROVIDED "AS IS" AND INTERNET SOFTWARE CONSORTIUM DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL INTERNET SOFTWARE CONSORTIUM BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.',
  ].forEach((sentence) => assert.ok(isc.indexOf(sentence) >= 0, 'inet_ntop.c: ' + sentence));
});

test('every library that CMakeLists.txt builds or links, and every third-party file of wasm/static, is named', () => {
  const cmake = read('CMakeLists.txt').replace(/#[^\n]*/g, '');
  const targets = [];
  cmake.replace(/add_(?:library|executable)\((\S+)/g, (all, name) => targets.push(name));
  const entryOfTarget = { 'moonlight-rs': 'Reed-Solomon', 'moonlight-enet': 'ENet', 'moonlight-common-c': 'moonlight-common-c',
    libgamestream: 'libgamestream', opus: 'Opus', 'moonlight-wasm': 'Emscripten' };
  assert.deepEqual(targets.filter((name) => !entryOfTarget[name]), [], 'a target without an entry in this test');
  targets.forEach((name) => entry(entryOfTarget[name]));
  // The ports of the Samsung Emscripten SDK that the module links, and zlib, which the port of curl pulls in
  // (USE_PTHREADS is a setting of the Emscripten runtime, not a port)
  const ports = (cmake.match(/-s USE_[A-Z]+=1/g) || []).map((flag) => flag.replace(/^-s USE_|=1$/g, '')).filter((name) => name !== 'PTHREADS');
  assert.deepEqual(Array.from(new Set(ports)).sort(), ['CRYPTO', 'CURL', 'SSL']);
  entry('OpenSSL 1.1.1d');
  entry('curl 7.68.0');
  entry('zlib 1.2.8');
  // The third-party files of the widget: each is named in its entry
  const text = notices();
  ['static/js/jquery-2.2.0.min.js', 'static/js/material.min.js', 'static/css/material.min.css', 'static/fonts/Roboto-Regular_latin.woff2',
    'Roboto-Regular_latin-ext.woff2', 'static/fonts/Manrope-latin-wght.woff2', 'static/fonts/Manrope-OFL.txt', 'wasm/platform/common.js', 'res/platform.js']
    .forEach((file) => assert.ok(text.indexOf(file) >= 0, file));
  ['wasm/static/js/jquery-2.2.0.min.js', 'wasm/static/js/material.min.js', 'wasm/static/css/material.min.css',
    'wasm/static/fonts/Roboto-Regular_latin.woff2', 'wasm/static/fonts/Roboto-Regular_latin-ext.woff2', 'wasm/static/fonts/Manrope-latin-wght.woff2']
    .forEach((file) => assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), file));
  // The versions that the files themselves name
  assert.match(read('wasm/static/js/jquery-2.2.0.min.js'), /^\/\*! jQuery v2\.2\.0 /);
  assert.match(read('wasm/static/js/material.min.js'), /@version v1\.3\.0/);
  assert.match(read('opus/package_version'), /PACKAGE_VERSION="1\.5\.2"/);
  assert.match(read('moonlight-common-c/enet/ChangeLog'), /^ENet 1\.3\.17 /);
  // The glyphs of Material Icons are gone from the images, so the notices need no entry for them
  assert.doesNotMatch(text, /Material Icons|MaterialIcons/);
});

test('the vendored licence texts are complete, as in the repository', () => {
  const text = flat(notices());
  // ENet and Opus ship their licence files
  assert.ok(text.indexOf(flat(read('moonlight-common-c/enet/LICENSE'))) >= 0, 'the LICENSE of ENet');
  assert.ok(text.indexOf(flat(read('opus/COPYING'))) >= 0, 'the COPYING of Opus with its patent licenses');
  // The licence of the Reed-Solomon code is the header of rs.c
  const rs = read('moonlight-common-c/reedsolomon/rs.c');
  const header = rs.slice(rs.indexOf('/*\n') + 3, rs.indexOf('\n */')).split('\n').map((line) => line.replace(/^ \*( |$)/, '')).join('\n');
  assert.match(header, /^fec\.c -- forward error correction based on Vandermonde matrices/);
  assert.ok(text.indexOf(flat(header)) >= 0, 'the header of rs.c');
});

test('the other licence texts are complete', () => {
  const text = flat(notices());
  // The licence of OpenSSL is a C comment, whose lines start with ' * '
  const withoutStars = flat(notices().replace(/^ ?\*(?: |$)/gm, ''));
  const texts = {
    'Apache License 2.0': ['Apache License Version 2.0, January 2004 http://www.apache.org/licenses/', 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
      '(a) You must give any other recipients of the Work or Derivative Works a copy of this License; and',
      '9. Accepting Warranty or Additional Liability.', 'END OF TERMS AND CONDITIONS', 'APPENDIX: How to apply the Apache License to your work.'],
    'OpenSSL License': ['Copyright (c) 1998-2019 The OpenSSL Project. All rights reserved.',
      '6. Redistributions of any form whatsoever must retain the following acknowledgment:',
      'THIS SOFTWARE IS PROVIDED BY THE OpenSSL PROJECT ``AS IS\'\' AND ANY EXPRESSED OR IMPLIED WARRANTIES'],
    'SSLeay License': ['Copyright (C) 1995-1998 Eric Young (eay@cryptsoft.com) All rights reserved.',
      'The licence and distribution terms for any publically available version or derivative of this code cannot be changed. i.e. this code cannot simply be copied and put under another distribution licence [including the GNU Public Licence.]'],
    'curl license': ['Copyright (c) 1996 - 2020, Daniel Stenberg, <daniel@haxx.se>, and many contributors, see the THANKS file.',
      'Permission to use, copy, modify, and distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.'],
    'zlib license': ['(C) 1995-2013 Jean-loup Gailly and Mark Adler', '3. This notice may not be removed or altered from any source distribution.'],
    'Emscripten (MIT and NCSA)': ['Emscripten is available under 2 licenses, the MIT license and the University of Illinois/NCSA Open Source License.',
      'Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.', 'Neither the names of Mozilla, nor the names of its contributors may be used to endorse',
      'Copyright Joyent, Inc. and other Node contributors.'],
    'musl': ['Copyright © 2005-2014 Rich Felker, et al.', 'The TRE regular expression implementation (src/regex/reg* and src/regex/tre*) is Copyright © 2001-2008 Ville Laurikari'],
    'libc++, libc++abi and compiler-rt (NCSA and MIT)': ['The libc++ library is dual licensed under both the University of Illinois "BSD-Like" license and the MIT license.',
      'The libc++abi library is dual licensed', 'The compiler_rt library is dual licensed', 'Developed by: LLVM Team University of Illinois at Urbana-Champaign http://llvm.org',
      'Neither the names of the LLVM Team, University of Illinois at Urbana-Champaign, nor the names of its contributors may be used to endorse'],
    'jQuery (MIT)': ['Copyright jQuery Foundation and other contributors, https://jquery.org/',
      'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.'],
    'Chromium (BSD)': ['Copyright (c) 2012 The Chromium Authors. All rights reserved. Redistribution and use in source and binary forms',
      '* Neither the name of Google Inc. nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.'],
    'Material Design Lite note': ['licensed under the Creative Commons Attribution International 4.0 License', 'https://creativecommons.org/licenses/by/4.0/legalcode'],
  };
  Object.keys(texts).forEach((name) => texts[name].forEach((sentence) => {
    const haystack = /^(OpenSSL|SSLeay)/.test(name) ? withoutStars : text;
    assert.ok(haystack.indexOf(flat(sentence)) >= 0, name + ': ' + sentence);
  }));
  // The Apache License 2.0 is printed once, after the components, for Material Design Lite and Roboto
  assert.equal(notices().split('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION').length, 2);
  assert.ok(notices().indexOf('\nLICENCE TEXTS\n') < notices().indexOf('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'));
});

test('the notices keep the e-mail addresses of the licence texts and name no model of the TV', () => {
  const text = notices();
  // The acknowledgments that the SSLeay licence requires to be kept, with their addresses as published
  assert.ok(flat(text).indexOf('This product includes cryptographic software written by Eric Young (eay@cryptsoft.com)') >= 0);
  assert.ok(flat(text).indexOf('This product includes software written by Tim Hudson (tjh@cryptsoft.com)') >= 0);
  assert.doesNotMatch(text, /\[at\]/);
  assert.doesNotMatch(text, /s90c/i);
});
