'use strict';

// Pins the two local patches of the vendored moonlight-common-c about reference frame invalidation, and the places of
// the app that use them. Sunshine offers reference frame invalidation only with an encoder that can do it (its NVENC
// encoder), and GeForce Experience always; every other encoder answers an invalidation with a keyframe.
//  - LiHostSupportsReferenceFrameInvalidation() (Limelight.h, Misc.c) tells the app what the host offered in its answer
//    to DESCRIBE. The report of the session carries it (hostRfi of wasm/session_report.hpp, set by VidDecCleanup() in
//    wasm/wasmplayer.cpp), and the hint about recovery keyframes names the setting 'Reference frame invalidation' only
//    for such a host (getSessionReportHints() in wasm/platform/diagnostics.js; tests/unit/diagnostics.test.js and
//    tests/native/session_report_test.cpp read and write the field with tests/fixtures/session-reports.tsv).
//  - SdpGenerator.c lets the host pick its number of reference frames (maxNumReferenceFrames 0) only when reference
//    frame invalidation is really used, i.e. the host offered it as well. Upstream sends 0 whenever the decoder declares
//    the capability, which made the setting change the stream on hosts where it can't recover anything.
//    tests/native/sdp_reference_frames_test.c runs the SDP for both kinds of host.
// A later update of the vendored copy would drop the patches unnoticed, so this file checks their code. It also pins
// the help text of the setting, which says in every language where the setting works.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'pt-BR'];
const HELP_TEXT = '- Recovers from packet loss without a full keyframe, which avoids traffic spikes and blurry frames. ' +
  'Only works when the PC encodes with an NVIDIA graphics card; with others it changes nothing. ' +
  'Disable it if artifacts remain after a frame drop.';

test('moonlight-common-c tells the app what the host offered for reference frame invalidation', () => {
  const header = read('moonlight-common-c/src/Limelight.h');
  assert.match(header, /\/\/ Moonlight Plus: returns whether the host of the current connection offered reference frame invalidation[^\n]*\n(\/\/[^\n]*\n)+bool LiHostSupportsReferenceFrameInvalidation\(void\);\n/);
  const misc = read('moonlight-common-c/src/Misc.c');
  assert.match(misc, /bool LiHostSupportsReferenceFrameInvalidation\(void\) \{\s+return ReferenceFrameInvalidationSupported;\s+\}/);
  // The flag is what the answer of the host to DESCRIBE holds, read before the SDP of the stream is made and sent
  const rtsp = read('moonlight-common-c/src/RtspConnection.c');
  const flag = rtsp.indexOf('ReferenceFrameInvalidationSupported = strstr(response.payload, "x-nv-video[0].refPicInvalidation") != NULL;');
  const describe = rtsp.indexOf('if (!requestDescribe(&response, &error)) {');
  const announce = rtsp.indexOf('if (!sendVideoAnnounce(&response, &error)) {');
  assert.ok(describe > 0 && flag > describe && announce > flag);
  assert.match(rtsp, /request\.payload = getSdpPayloadForStreamConfig\(rtspClientVersion, &payloadLength\);/);
});

test('the SDP lets the host pick its reference frames only when reference frame invalidation is used', () => {
  const sdp = read('moonlight-common-c/src/SdpGenerator.c');
  assert.match(sdp, /\/\/ Moonlight Plus: let the host pick its number of reference frames only when reference frame\n/);
  assert.match(sdp, /if \(isReferenceFrameInvalidationEnabled\(\)\) \{\s+err \|= addAttributeString\(&optionHead, "x-nv-video\[0\]\.maxNumReferenceFrames", "0"\);\s+\}\s+else \{\s+(\/\/[^\n]*\n\s+)*err \|= addAttributeString\(&optionHead, "x-nv-video\[0\]\.maxNumReferenceFrames", "1"\);/);
  // Nothing else of the SDP asks only the decoder
  assert.equal(sdp.indexOf('isReferenceFrameInvalidationSupportedByDecoder'), -1);
  assert.equal((sdp.match(/maxNumReferenceFrames/g) || []).length, 2);
  // Used means offered by the host and supported by the decoder
  const misc = read('moonlight-common-c/src/Misc.c');
  assert.match(misc, /bool isReferenceFrameInvalidationEnabled\(void\) \{\s+(\/\/[^\n]*\n\s+)*return ReferenceFrameInvalidationSupported && isReferenceFrameInvalidationSupportedByDecoder\(\);/);
  // The setting of the app declares the capability for HEVC and AV1, and nothing else of the module depends on it
  const main = read('wasm/main.cpp');
  assert.match(main, /if \(me->m_RefFrameInvalidationEnabled\) \{[\s\S]*?s_DrCallbacks\.capabilities \|= CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC \| CAPABILITY_REFERENCE_FRAME_INVALIDATION_AV1;/);
  ['wasm/main.cpp', 'wasm/wasmplayer.cpp'].forEach((file) => {
    const uses = read(file).replace(/\/\/.*$/gm, '').match(/m_RefFrameInvalidationEnabled/g) || [];
    assert.equal(uses.length, file === 'wasm/main.cpp' ? 2 : 0, file + ': the setting is stored and read once');
  });
});

test('the report of the session carries what the host offered, and the hint asks for it', () => {
  const player = read('wasm/wasmplayer.cpp');
  const cleanup = player.slice(player.indexOf('void MoonlightInstance::VidDecCleanup(void) {'));
  assert.match(cleanup, /report\.hostRfi = LiHostSupportsReferenceFrameInvalidation\(\);\s+const std::string reportMessage = FormatSessionReportMessage\(report\);/);
  const report = read('wasm/session_report.hpp');
  assert.match(report, /bool hostRfi = false;/);
  assert.match(report, /\\"audioOverloadedWindows\\":%u,\\"hostRfi\\":%u\}",/);
  assert.match(report, /report\.audioOverloadedWindows, report\.hostRfi \? 1u : 0u\);/);
  // The message is built in a buffer with room to spare, and one that doesn't fit is still not sent
  assert.match(report, /constexpr size_t kSessionReportMessageSize = 1024;/);
  assert.match(report, /char json\[kSessionReportMessageSize\];/);
  assert.match(report, /return length > 0 && length < static_cast<int>\(sizeof\(json\)\) \? std::string\(json\) : std::string\(\);/);
  const diagnostics = read('wasm/platform/diagnostics.js');
  assert.match(diagnostics, /hostRfi: data\.hostRfi === 1 \|\| data\.hostRfi === true,/);
  assert.match(diagnostics, /if \(report\.recoveryKeyframes >= 3 && report\.hostRfi && !opts\.refFrameInvalidation && \/\^\(HEVC\|AV1\)\/\.test\(report\.codec\)\) \{\s+hints\.push\('keyframes'\);/);
});

test('the help text of the setting says where it works, in every language', () => {
  const page = read('wasm/index.html');
  const option = page.slice(page.indexOf('<label data-i18n="Reference frame invalidation">'), page.indexOf('id="refFrameInvalidationMenu"'));
  assert.ok(option.indexOf('data-i18n="' + HELP_TEXT + '"') > 0, option);
  // The text of the element is the key
  assert.equal(option.split(HELP_TEXT).length - 1, 2);
  LOCALES.forEach((locale) => {
    const text = JSON.parse(read('wasm/static/locales/' + locale + '.json'))[HELP_TEXT];
    assert.equal(typeof text, 'string', locale);
    assert.match(text, /^- /, locale);
    assert.match(text, /NVIDIA/, locale);
    if (locale !== 'en-US') {
      assert.notEqual(text, HELP_TEXT, locale);
    }
    // The earlier text, which named no kind of PC, is gone
    assert.equal(Object.keys(JSON.parse(read('wasm/static/locales/' + locale + '.json')))
      .filter((key) => key.indexOf('- Recovers from packet loss without a full keyframe') === 0).length, 1, locale);
  });
});
