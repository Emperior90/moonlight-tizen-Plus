'use strict';

// Pins what the app says about the bitrate since 2.3.1, in every language:
// - no text advises to raise the bitrate as long as no frames drop. The help text of the setting 'Video bitrate' and the
//   advice of the optimal settings dialog over Wi-Fi say instead what more bitrate costs: every frame takes longer to
//   arrive, about 0.6 to 0.8 ms more latency per 10 Mbps. That figure comes from one measurement (a 4K stream at 60 FPS
//   over 5 GHz Wi-Fi), so every text that names it words it as 'about' and says where it was measured;
// - the help text explains in one phrase why the statistics show less as received than the bitrate that is set: it
//   includes error correction and audio (about 9 % less with 5 % error correction);
// - the two lines of the full statistics that show the price of a bitrate, as FormatVideoStats() of wasm/wasmplayer.cpp
//   writes them: the bitrate line, whose received figure is the video alone while the configured one also holds the
//   error correction and the audio (named FEC there, as in the other lines of the statistics, to keep the line short:
//   the longest line sets the width of the overlay), and the frame receive time with its share of the time between two
//   frames. replaceKnownStatsLabels() of wasm/platform/messages.js translates both as a whole;
// - the hints of the Last session report that name the bitrate only ever say to lower it;
// - the presets, caps and warning thresholds of the bitrate are what they were (tv_profile.js is not part of this).
// The figures of the lines are pinned by tests/native/stats_overlay_test.cpp, the report by diagnostics.test.js, and the
// texts in the real page by tests/browser/video-defaults.test.js, optimal-settings-dialog.test.js and stats-overlay.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const LOCALES = ['de-DE', 'es-ES', 'fr-FR', 'pt-BR'];
const readLocale = (name) => JSON.parse(read('wasm/static/locales/' + name + '.json'));
const english = readLocale('en-US');

// A t() that translates with a locale file like i18n.js does
function translator(locale) {
  const messages = readLocale(locale);
  return (key, ...values) => {
    const text = Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key;
    return text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  };
}

const HELP = '- A higher bitrate improves the picture less and less, but every frame takes longer to arrive: about 0.6 to 0.8 ms more latency ' +
  'per 10 Mbps, measured on one fast Wi-Fi connection. Lower it when frames are lost. It includes error correction and audio, so the ' +
  'statistics show about 9% less as received (with 5% error correction).';
const RAISE = 'Raise the bitrate only if fast scenes look blocky, up to %1$s Mbps: every 10 Mbps more add about 0.6 to 0.8 ms of latency, ' +
  'measured on one fast Wi-Fi connection.';
const AT_LIMIT = 'This is the highest bitrate recommended for the video decoder of this TV. More would also add latency: about 0.6 to 0.8 ms ' +
  'per 10 Mbps, measured on one fast Wi-Fi connection.';
// The word for 'about' of each language, and its decimal comma
const ABOUT = { 'de-DE': 'etwa', 'es-ES': '(?:unos|alrededor de)', 'fr-FR': 'environ', 'pt-BR': 'cerca de' };

test('no text advises to raise the bitrate as long as no frames drop', () => {
  const keys = Object.keys(english);
  // The three texts of 2.3.0 are gone from the app and from every language
  ['- Increase for better image quality or decrease to improve performance on slower connections.',
    'If the performance statistics show no dropped frames, you can raise the bitrate up to %1$s Mbps.',
    'This is the highest bitrate recommended for the video decoder of this TV, so raise it only if the performance statistics show no dropped frames.',
  ].forEach((key) => {
    assert.ok(!keys.includes(key), key);
    LOCALES.forEach((locale) => assert.ok(!Object.prototype.hasOwnProperty.call(readLocale(locale), key), locale + ': ' + key));
  });
  ['wasm/index.html', 'wasm/platform/index.js', 'wasm/platform/tv_profile.js', 'wasm/platform/messages.js', 'wasm/platform/menus.js',
    'wasm/platform/diagnostics.js'].forEach((file) => {
    assert.doesNotMatch(read(file), /show no dropped frames|Increase for better image quality/, file);
  });
  // No text ties a higher bitrate to the absence of dropped frames
  const raising = keys.filter((key) => /\b(raise|increase)\b[^.]*\bbitrate\b|\bbitrate\b[^.]*\b(raise|increase)\b/i.test(key));
  raising.forEach((key) => assert.doesNotMatch(key, /no (dropped|lost) frames|until frames|as long as/i, key));
  // The one text that says when to raise it gives a reason to (a blocky picture) and the price
  assert.deepEqual(raising.filter((key) => /^Raise the bitrate/.test(key)), [RAISE]);
});

test('the help text of the bitrate setting names the latency price and why the statistics show less as received', () => {
  const html = read('wasm/index.html');
  const row = html.slice(html.indexOf('<label data-i18n="Video bitrate">'), html.indexOf('<div id="videoBitrateMenu">'));
  assert.ok(row.length > 0, 'the row of the bitrate setting');
  assert.ok(row.indexOf('data-i18n="' + HELP + '"') > 0, row);
  assert.equal(english[HELP], HELP);
  // What more bitrate costs, as a measurement and not as a promise
  assert.match(HELP, /every frame takes longer to arrive: about 0\.6 to 0\.8 ms more latency per 10 Mbps, measured on one fast Wi-Fi connection\./);
  // When to lower it
  assert.match(HELP, /Lower it when frames are lost\./);
  // One phrase for the gap between the set bitrate and the received figure of the statistics
  assert.match(HELP, /It includes error correction and audio, so the statistics show about 9% less as received \(with 5% error correction\)\./);
  LOCALES.forEach((locale) => {
    const text = readLocale(locale)[HELP];
    assert.match(text, /^- /, locale);
    assert.match(text, new RegExp(ABOUT[locale] + ' (?:de )?0,6 (?:bis|a|à) 0,8 ms\\b[^.]*\\b10 Mbps'), locale + ': ' + text);
    assert.match(text, new RegExp(ABOUT[locale] + ' (?:un )?9[  ]?%'), locale + ': ' + text);
    assert.match(text, /5[  ]?%/, locale + ': ' + text);
    assert.match(text, /WLAN|Wi-Fi/, locale + ': ' + text);
    assert.match(text, /Audio|audio|áudio/, locale + ': ' + text);
    assert.match(text, /Fehlerkorrektur|corrección de errores|correction d’erreurs|correção de erros/, locale + ': ' + text);
  });
  // In German 'weniger als empfangen' would read as 'less than received', so the sentence puts 'als empfangen' first
  assert.match(readLocale('de-DE')[HELP], /als empfangen zeigt die Statistik daher etwa 9 % weniger \(bei 5 % Fehlerkorrektur\)\.$/);
  assert.doesNotMatch(readLocale('de-DE')[HELP], /weniger als/);
});

test('the optimal settings dialog names the latency price of a higher bitrate over Wi-Fi', () => {
  const index = read('wasm/platform/index.js');
  const wifi = index.slice(index.indexOf("} else if (connectionType === 'wifi') {"), index.indexOf("message += t('The network connection type of the TV could not be detected"));
  assert.ok(wifi.length > 0, 'the Wi-Fi advice of the dialog');
  assert.ok(wifi.indexOf("message += t('" + RAISE + "', raiseLimit);") > 0, wifi);
  assert.ok(wifi.indexOf("message += t('" + AT_LIMIT + "');") > 0, wifi);
  // The limit of the advice is still where the bitrate warning of the TV starts
  assert.match(wifi, /const raiseLimit = bitrateRaiseLimit\(optimalSettings\.resolution, optimalSettings\.frameRate, tvCapabilities\);/);
  [RAISE, AT_LIMIT].forEach((key) => {
    assert.equal(english[key], key);
    LOCALES.forEach((locale) => {
      const text = readLocale(locale)[key];
      assert.match(text, new RegExp(ABOUT[locale] + ' (?:de )?0,6 (?:bis|a|à) 0,8 ms'), locale + ': ' + text);
      assert.match(text, /10 Mbps/, locale + ': ' + text);
      assert.match(text, /WLAN|Wi-Fi/, locale + ': ' + text);
    });
  });
});

test('every text that names the latency per 10 Mbps words it as about and says where it was measured', () => {
  const naming = Object.keys(english).filter((key) => /0\.6 to 0\.8 ms/.test(key));
  assert.deepEqual(naming.sort(), [HELP, RAISE, AT_LIMIT].sort());
  naming.forEach((key) => {
    assert.match(key, /about 0\.6 to 0\.8 ms/, key);
    assert.match(key, /measured on one fast Wi-Fi connection/, key);
    assert.doesNotMatch(key, /\b(always|exactly|guarantee|will add|adds exactly)\b/i, key);
  });
  // No text gives the figure without both numbers, in any language
  LOCALES.forEach((locale) => {
    const messages = readLocale(locale);
    Object.keys(messages).filter((key) => /0,6|0,8 ms/.test(messages[key])).forEach((key) => {
      assert.ok(naming.includes(key), locale + ': ' + messages[key]);
    });
  });
});

// The two lines as FormatVideoStats() writes them, with the figures of the session that the finding measured
const BITRATE_LINE = 'Bitrate: 146.27 Mbps video received, 160.0 Mbps configured (with FEC and audio)';
const RECEIVE_LINE = 'Average frame receive time: 8.65 ms (52% of the frame time)';

test('the sample lines of the bitrate and of the frame receive time are those of the native code', () => {
  const native = read('wasm/wasmplayer.cpp');
  assert.ok(native.includes('"Bitrate: %.2f Mbps video received, %.1f Mbps configured (with FEC and audio)\\n"'));
  assert.ok(native.includes('"Average frame receive time: %.2f ms (%.0f%% of the frame time)\\n"'));
  // The share is the receive time over the time between two frames of the stream: ms * FPS / 10 in percent
  assert.match(native, /const float receiveTimeMs = \(float\)stats\.totalReassemblyTime \/ stats\.decodedFrames;/);
  assert.match(native, /receiveTimeMs, receiveTimeMs \* s_Framerate \/ 10\.0f,/);
  assert.equal(Math.round(8.65 * 60 / 10), 52);
  // The received figure adds up the video frames alone
  assert.match(native, /total_bytes \+= decodeUnit->fullLength;/);
  assert.doesNotMatch(native, /Mbps received, %\.1f Mbps configured\\n/);
  // The bitrate line stays about as long as the other long lines of the statistics, in every language
  assert.ok(BITRATE_LINE.length <= 80, String(BITRATE_LINE.length));
  LOCALES.forEach((locale) => {
    const line = translator(locale)('Bitrate: %1$s Mbps video received, %2$s Mbps configured (with FEC and audio)', '146.27', '160.0');
    assert.ok(line.length <= 90, locale + ': ' + line.length);
  });
});

test('the full statistics translate the bitrate line and the share of the frame time as a whole', () => {
  const translate = (locale) => loadPlatformScripts(['wasm/platform/messages.js'], { globals: { t: translator(locale) } }).get('replaceKnownStatsLabels');
  // English keeps the lines
  assert.equal(translate('en-US')(BITRATE_LINE + '\n' + RECEIVE_LINE + '\n'), BITRATE_LINE + '\n' + RECEIVE_LINE + '\n');
  LOCALES.forEach((locale) => {
    const t = translator(locale);
    const lines = translate(locale)(BITRATE_LINE + '\n' + RECEIVE_LINE).split('\n');
    assert.equal(lines[0], t('Bitrate: %1$s Mbps video received, %2$s Mbps configured (with FEC and audio)', '146.27', '160.0'), locale);
    assert.equal(lines[1], t('Average frame receive time:') + ' 8.65 ms ' + t('(%1$s% of the frame time)', '52'), locale);
    // Nothing of the two lines stays English, and every number is still there
    assert.doesNotMatch(lines.join('\n'), /received|configured|error correction|with |frame receive|of the frame time/, locale);
    assert.deepEqual(lines[0].match(/\d+(?:\.\d+)?/g), ['146.27', '160.0'], locale);
    assert.deepEqual(lines[1].match(/\d+(?:\.\d+)?/g), ['8.65', '52'], locale);
    assert.match(lines[1], /52[  ]?%/, locale);
  });
  assert.equal(translate('de-DE')(BITRATE_LINE), 'Bitrate: 146.27 Mbps Video empfangen, 160.0 Mbps eingestellt (mit FEC und Audio)');
  assert.equal(translate('de-DE')(RECEIVE_LINE), 'Durchschnittliche Empfangszeit pro Frame: 8.65 ms (52 % der Zeit zwischen zwei Frames)');
  // A share above 100 % (a frame that takes longer than the time between two frames) is translated as well
  assert.equal(translate('de-DE')('Average frame receive time: 21.00 ms (126% of the frame time)'),
    'Durchschnittliche Empfangszeit pro Frame: 21.00 ms (126 % der Zeit zwischen zwei Frames)');
  // The line of a module without the share (2.3.0) keeps its label
  assert.equal(translate('de-DE')('Average frame receive time: 3.21 ms'), 'Durchschnittliche Empfangszeit pro Frame: 3.21 ms');
});

test('the hints of the Last session report that name the bitrate only say to lower it', () => {
  const app = loadPlatformScripts(['wasm/platform/diagnostics.js'], { globals: { t: translator('en-US') } });
  const text = app.get('getSessionReportHintText');
  const report = { durationMs: 1200000, fps: 60, hostProcessingLatencyX10: 84, hostFrameRateX100: 5984, hostFrameRateLowX100: 5090,
    hostWindows: 39, hostLowWindows: 12, audioLoadPeakMsPerS: 300 };
  const hints = ['noVideo', 'network', 'tv', 'audio', 'host', 'hostFrames', 'keyframes', 'fec', 'memory', 'hostRefresh', 'ok'];
  const naming = hints.filter((hint) => /bitrate/i.test(text(hint, report, {})));
  assert.deepEqual(naming, ['network', 'tv', 'fec']);
  naming.forEach((hint) => {
    assert.match(text(hint, report, {}), /lower the bitrate|a lower bitrate/, hint);
    assert.doesNotMatch(text(hint, report, {}), /raise|increase|higher/i, hint);
  });
  // The hint about a PC that delivered fewer frames names neither the bitrate nor the network
  assert.doesNotMatch(text('hostFrames', report, {}), /bitrate|network/i);
});

test('the presets, the caps and the warning thresholds of the bitrate are what they were', () => {
  // Only texts changed. tv-profile.test.js, video-warnings.test.js and guide-bitrate-table.test.js pin every preset and
  // cap by TV and connection; these are the values that the new texts stand next to.
  const app = loadPlatformScripts(['wasm/platform/tv_profile.js'], { tv: { tv: 's90c', conn: 'wifi' } });
  assert.deepEqual(plain(app.get('STANDARD_BITRATE_PRESETS')), {
    '854:480': { 30: 2, 60: 4, 90: 5, 120: 6 },
    '1280:720': { 30: 5, 60: 10, 90: 12, 120: 15 },
    '1920:1080': { 30: 10, 60: 20, 90: 25, 120: 30 },
    '2560:1440': { 30: 20, 60: 40, 90: 50, 120: 60 },
    '3200:1800': { 30: 30, 60: 60, 90: 75, 120: 90 },
    '3840:2160': { 30: 40, 60: 80, 90: 100, 120: 120 },
  });
  assert.deepEqual(['RECOMMENDED_ETHERNET_BITRATE', 'ETHERNET_MAX_BITRATE', 'UNKNOWN_CONNECTION_MAX_BITRATE', 'NETWORK_HEADROOM_FACTOR',
    'UHD_DECODER_CAP_MBPS', 'FHD_DECODER_CAP_MBPS', 'MAX_BITRATE_MBPS'].map((name) => app.get(name)), [75, 80, 80, 1.25, 80, 50, 250]);
  assert.match(read('wasm/index.html'), /<input type="range" id="bitrateSlider" class="mdl-slider mdl-js-slider" min="0\.5" max="250" step="0\.5" value="10">/);
  // The tested model: its presets stop at 100 Mbps, its warning starts above 150 Mbps, where the advice of the dialog ends
  const caps = app.get('detectTvCapabilities')();
  assert.equal(app.get('getDecoderCapMbps')(caps), 100);
  assert.equal(app.get('getBitrateWarningMbps')(caps), 150);
  assert.equal(app.get('bitrateRaiseLimit')('3840:2160', '60', caps), 150);
  assert.equal(app.get('recommendedBitrate')('3840:2160', '60', 'wifi', caps), 100);
  assert.equal(app.get('recommendedBitrate')('3840:2160', '60', 'ethernet', caps), 75);
});
