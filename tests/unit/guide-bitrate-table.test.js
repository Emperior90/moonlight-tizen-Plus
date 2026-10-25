'use strict';

// Checks that the table of recommended bitrates in docs/GUIDE.md (between the recommended-bitrates markers) says what the
// app applies: the resolution and frame rate of deriveOptimalSettings() and its bitrate for each connection, the end of
// the Wi-Fi ladder that the dialog suggests (bitrateRaiseLimit()) and the decoder cap where the bitrate warning starts
// (getDecoderCapMbps()), each for a simulated TV of the class. It also checks the Ethernet limits that the guide names.
// So a change of the TV profile in wasm/platform/tv_profile.js fails here until the guide is updated with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const tvMock = require('../browser/mocks/tv-mock');
const profile = require('../../wasm/platform/tv_profile');

const GUIDE = path.join(REPO_ROOT, 'docs', 'GUIDE.md');
const START_MARKER = '<!-- recommended-bitrates:start -->';
const END_MARKER = '<!-- recommended-bitrates:end -->';

// The simulated TV of each class of the table (see tests/browser/mocks/tv-mock.js). The app can't detect the refresh rate
// of the panel, so both 4K classes are the same untested 4K TV.
const TV_CLASSES = {
  'Full HD': { tv: 'fhd' },
  '4K, 60 Hz panel': { tv: 'uhd' },
  '4K, 120 Hz panel': { tv: 'uhd' },
  '8K': { tv: '8k' },
  'Samsung S90C (tested profile)': { tv: 's90c' },
};

// The columns of the table, in their order
const COLUMNS = ['TV class', 'Resolution and frame rate', 'Ethernet', 'Wi-Fi', 'Connection not detected', 'Wi-Fi ladder ends at',
  'Bitrate warning above'];

// Detect the capabilities of a simulated TV of a class, without the warnings of the detection
function capabilitiesOf(tvOptions) {
  const apis = tvMock.createTizenApis(tvMock.parseConfig('', tvOptions), (callback) => callback());
  return profile.detectTvCapabilities({ tizen: apis.tizen, webapis: apis.webapis, screen: { width: 1920, height: 1080 } });
}

// Split a row of a Markdown table into its cells
function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

// Read the table between the markers into its header and rows
function readTable() {
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const start = guide.indexOf(START_MARKER);
  const end = guide.indexOf(END_MARKER);
  assert.ok(start >= 0 && end > start, 'docs/GUIDE.md must keep the table between ' + START_MARKER + ' and ' + END_MARKER);
  const lines = guide.slice(start + START_MARKER.length, end).split(/\r?\n/).filter((line) => line.trim().startsWith('|'));
  assert.ok(lines.length >= 3, 'the table needs a header, a separator and rows');
  assert.match(lines[1], /^\|(\s*:?-+:?\s*\|)+$/, 'the second line of the table is its separator');
  return { header: cells(lines[0]), rows: lines.slice(2).map(cells) };
}

// Read a bitrate cell such as '75 Mbps'
function mbps(cell, what) {
  const match = /^(\d+(?:\.\d+)?) Mbps$/.exec(cell);
  assert.ok(match, what + ': "' + cell + '" is not a bitrate in Mbps');
  return Number(match[1]);
}

// Read a cell such as '3840 x 2160, 60 FPS' into the resolution value of the menu and the frame rate
function resolutionAndFps(cell, what) {
  const match = /^(\d+) x (\d+), (\d+) FPS$/.exec(cell);
  assert.ok(match, what + ': "' + cell + '" is not a resolution and frame rate');
  return { resolution: match[1] + ':' + match[2], frameRate: Number(match[3]) };
}

test('the table of recommended bitrates in the guide has the expected columns and every TV class', () => {
  const table = readTable();
  assert.deepEqual(table.header, COLUMNS);
  assert.deepEqual(table.rows.map((row) => row[0]), Object.keys(TV_CLASSES));
  table.rows.forEach((row) => assert.equal(row.length, COLUMNS.length, 'columns of the row ' + row[0]));
});

test('the table of recommended bitrates in the guide matches the TV profile of the app', () => {
  readTable().rows.forEach((row) => {
    const tvClass = row[0];
    const caps = capabilitiesOf(TV_CLASSES[tvClass]);
    const settings = {
      ethernet: profile.deriveOptimalSettings(caps, 'ethernet'),
      wifi: profile.deriveOptimalSettings(caps, 'wifi'),
      unknown: profile.deriveOptimalSettings(caps, 'unknown'),
    };

    const shown = resolutionAndFps(row[1], tvClass);
    Object.keys(settings).forEach((connection) => {
      assert.equal(settings[connection].resolution, shown.resolution, tvClass + ': resolution over ' + connection);
      assert.equal(settings[connection].frameRate, shown.frameRate, tvClass + ': frame rate over ' + connection);
    });
    assert.equal(mbps(row[2], tvClass + ', Ethernet'), settings.ethernet.bitrate, tvClass + ': Ethernet bitrate');
    assert.equal(mbps(row[3], tvClass + ', Wi-Fi'), settings.wifi.bitrate, tvClass + ': Wi-Fi bitrate');
    assert.equal(mbps(row[4], tvClass + ', connection not detected'), settings.unknown.bitrate, tvClass + ': bitrate without a detected connection');
    assert.equal(mbps(row[5], tvClass + ', ladder'), profile.bitrateRaiseLimit(shown.resolution, shown.frameRate, caps),
      tvClass + ': the highest bitrate the dialog suggests over Wi-Fi');
    assert.equal(mbps(row[6], tvClass + ', warning'), profile.getDecoderCapMbps(caps), tvClass + ': decoder cap');
    // The bitrate of the button never starts above the cap where the warning appears
    Object.keys(settings).forEach((connection) => {
      assert.ok(settings[connection].bitrate <= profile.getDecoderCapMbps(caps), tvClass + ': bitrate over ' + connection + ' within the cap');
    });
  });
});

test('the classes of the table are told apart as the guide says', () => {
  // Only the S90C row comes from a tested profile; the 4K rows can't differ, since the refresh rate isn't detected
  assert.equal(capabilitiesOf(TV_CLASSES['Samsung S90C (tested profile)']).profile.id, 'S90C');
  ['Full HD', '4K, 60 Hz panel', '4K, 120 Hz panel', '8K'].forEach((tvClass) => {
    assert.equal(capabilitiesOf(TV_CLASSES[tvClass]).profile, null, tvClass + ' has no tested profile');
  });
  const fhd = capabilitiesOf(TV_CLASSES['Full HD']);
  const eightK = capabilitiesOf(TV_CLASSES['8K']);
  assert.equal(fhd.is4k || fhd.is8k, false);
  assert.equal(eightK.is8k, true);
});

test('the Ethernet limits and standard presets named in the guide are those of the app', () => {
  const guide = fs.readFileSync(GUIDE, 'utf8');
  assert.ok(guide.indexOf('at most ' + profile.RECOMMENDED_ETHERNET_BITRATE + ' Mbps, because of the 100 Mbps port') >= 0,
    'the guide names the Ethernet limit of the recommendation');
  assert.ok(guide.indexOf('the app warns above ' + profile.ETHERNET_MAX_BITRATE + ' Mbps') >= 0, 'the guide names the Ethernet warning');
  assert.ok(guide.indexOf('at most ' + profile.UNKNOWN_CONNECTION_MAX_BITRATE + ' Mbps') >= 0, 'the guide names the limit without a detected connection');
  assert.ok(guide.indexOf(profile.getStandardPresetBitrate('1920:1080', 60) + ' Mbps for 1080p and ' +
    profile.getStandardPresetBitrate('3840:2160', 60) + ' Mbps for 4K at 60 FPS') >= 0, 'the guide names the standard presets');
  assert.ok(guide.indexOf('goes up to ' + profile.MAX_BITRATE_MBPS + ' Mbps') >= 0, 'the guide names the end of the slider');
});
