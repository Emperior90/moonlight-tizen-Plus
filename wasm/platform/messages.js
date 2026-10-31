/* eslint-disable */

const SyncFunctions = {
  // no parameters
  'makeCert': (...args) => Module.makeCert(...args),
  // cert, privateKey, myUniqueid
  'httpInit': (...args) => Module.httpInit(...args),
  /* host, httpPort, width, height, fps, bitrate, rikey, rikeyid, appversion, gfeversion, rtspurl, serverCodecModeSupport,
  framePacing, optimizeGames, rumbleFeedback, mouseEmulation, controllerMappings, audioBackend,
  audioConfig, audioSync, audioJitter, playHostAudio, decryptHostAudio, videoCodec, hdrMode, fullRange, gameMode,
  disableWarnings, performanceStats, refFrameInvalidation, hdrMetadata, controllerType */
  'startRequest': (...args) => Module.startStream(...args),
  // no parameters
  'stopRequest': (...args) => Module.stopStream(...args),
  // no parameters
  'cancelRequest': (...args) => Module.cancelRequest(...args),
  // no parameters
  'toggleStats': (...args) => Module.toggleStats(...args),
};

const AsyncFunctions = {
  // url, ppk, binaryResponse
  'openUrl': (id, url, ppk, binary) => Module.openUrl(id, url, ppk, binary),
  // no parameters
  'STUN': (...args) => Module.stun(...args),
  // serverMajorVersion, address, httpPort, randomNumber
  'pair': (...args) => Module.pair(...args),
  // macAddress, subnetBroadcast
  'wakeOnLan': (...args) => Module.wakeOnLan(...args),
};

var callbacks = {}
var callbacks_ids = 1;

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeBackendMessageText(text) {
  return String(text || '')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();
}

function replaceKnownStageLabels(text) {
  const stageLabels = [
    'none',
    'platform initialization',
    'name resolution',
    'audio stream initialization',
    'RTSP handshake',
    'control stream initialization',
    'video stream initialization',
    'input stream initialization',
    'control stream establishment',
    'video stream establishment',
    'audio stream establishment',
    'input stream establishment',
  ];

  const translatedStageLabels = [
    t('none'),
    t('platform initialization'),
    t('name resolution'),
    t('audio stream initialization'),
    t('RTSP handshake'),
    t('control stream initialization'),
    t('video stream initialization'),
    t('input stream initialization'),
    t('control stream establishment'),
    t('video stream establishment'),
    t('audio stream establishment'),
    t('input stream establishment'),
  ];

  const translateStages = (part) => {
    let result = part;
    stageLabels.forEach((label, i) => {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escapedLabel, 'gi'), translatedStageLabels[i]);
    });
    return result;
  };
  // The progress line of a stage (ClStageStarting() in wasm/connectionlistener.cpp, 'Starting RTSP handshake...') is
  // translated as a whole, so that each language puts the stage into a sentence of its own (e.g. 'Démarrage : …')
  // instead of a word for 'Starting' in front of it
  const progress = /^Starting (.+?)\.\.\.$/.exec(text);
  if (progress) {
    return t('Starting the %1$s...', translateStages(progress[1]));
  }
  return translateStages(text);
}

// Translate the audio lines of the performance stats (FormatAudioStreamStats() in wasm/audio_stream_stats.hpp), e.g.
// 'Audio stream: Opus 5.1 surround (6 channels), 5 ms packets, 512 kbps'
function replaceKnownAudioStatsLabels(text) {
  const layouts = {
    'Mono': t('Mono'),
    'Stereo': t('Stereo'),
    '5.1 surround': t('5.1 surround'),
    '7.1 surround': t('7.1 surround'),
  };
  return text
    .replace(/Audio stream: Opus (?:(Mono|Stereo|5\.1 surround|7\.1 surround) \()?(\d+) channels\)?, ([\d.]+) ms packets/g, function(match, layout, channels, packetMs) {
      const channelText = t('%1$s channels', channels);
      return t('Audio stream:') + ' Opus ' + (layout ? layouts[layout] + ' (' + channelText + ')' : channelText) + ', ' +
        t('%1$s ms packets', packetMs);
    })
    .replace(/Session audio packets lost by network:/g, t('Session audio packets lost by network:'))
    .replace(/Session audio decode errors:/g, t('Session audio decode errors:'))
    .replace(/TV audio player rejections:/g, t('TV audio player rejections:'));
}

// Translate the lines of the frame intervals (FormatFrameIntervalLine() in wasm/frame_intervals.hpp), e.g.
// 'Host frame intervals: deviation 0.47 ms, p95 17.0 ms, 0.0% off cadence'
function replaceKnownFrameIntervalLabels(text) {
  const labels = {
    'Host': t('Host frame intervals:'),
    'TV player': t('TV player frame intervals:'),
  };
  return text.replace(/(Host|TV player) frame intervals: deviation ([\d.]+) ms, p95 ([\d.]+) ms, ([\d.]+)% off cadence/g,
    function(match, source, deviation, p95, offCadence) {
      return labels[source] + ' ' + t('deviation %1$s ms, p95 %2$s ms, %3$s% off cadence', deviation, p95, offCadence);
    });
}

function replaceKnownStatsLabels(text) {
  return replaceKnownFrameIntervalLabels(replaceKnownAudioStatsLabels(text))
    .replace(/Video stream:/g, t('Video stream:'))
    .replace(/Codec:/g, t('Codec:'))
    .replace(/Incoming frame rate from network:/g, t('Incoming frame rate from network:'))
    .replace(/Decoding frame rate:/g, t('Decoding frame rate:'))
    .replace(/Rendering frame rate:/g, t('Rendering frame rate:'))
    .replace(/Bitrate: ([\d.]+) Mbps received, ([\d.]+) Mbps configured/g, function(match, received, configured) {
      return t('Bitrate: %1$s Mbps received, %2$s Mbps configured', received, configured);
    })
    .replace(/Host frame rate \(30 s\):/g, t('Host frame rate (30 s):'))
    .replace(/Host processing latency min\/max\/average:/g, t('Host processing latency min/max/average:'))
    .replace(/Frames dropped by your network connection:/g, t('Frames dropped by your network connection:'))
    .replace(/Average network latency:/g, t('Average network latency:'))
    .replace(/\bvariance:/g, t('variance:'))
    .replace(/\bN\/A\b/g, t('N/A'))
    .replace(/Average frame receive time:/g, t('Average frame receive time:'))
    .replace(/Average frame wait time:/g, t('Average frame wait time:'))
    .replace(/Average frame pacing delay:/g, t('Average frame pacing delay:'))
    .replace(/Average rendering time:/g, t('Average rendering time:'))
    .replace(/Pending frames:/g, t('Pending frames:'))
    .replace(/Session frames dropped by network:/g, t('Session frames dropped by network:'))
    .replace(/Session frames dropped by the TV:/g, t('Session frames dropped by the TV:'))
    .replace(/Session recovery keyframes:/g, t('Session recovery keyframes:'))
    .replace(/Session FEC recoveries:/g, t('Session FEC recoveries:'))
    .replace(/Worst FEC block:/g, t('Worst FEC block:'))
    .replace(/TV player rejections:/g, t('TV player rejections:'))
    .replace(/WASM heap top:/g, t('WASM heap top:'))
    .replace(/Slow connection to PC\.\nReduce your bitrate!/g, t('Slow connection to PC.\nReduce your bitrate!'));
}

function replaceKnownWolErrorLabels(text) {
  const wolErrorLabels = [
    'Invalid MAC address format',
    // kWakeOnLanUnknownMacError of wasm/wake_on_lan.hpp
    'The PC hasn\'t reported its MAC address (00:00:00:00:00:00)',
    'Failed to create socket',
    'Failed to enable broadcast',
    'Failed to send magic packet to MAC address',
    'Failed to send IPv6 magic packet to MAC address',
    'Unknown error'
  ];

  const translatedWolErrorLabels = [
    t('Invalid MAC address format'),
    t('The PC hasn\'t reported its MAC address (00:00:00:00:00:00)'),
    t('Failed to create socket'),
    t('Failed to enable broadcast'),
    t('Failed to send magic packet to MAC address'),
    t('Failed to send IPv6 magic packet to MAC address'),
    t('Unknown error')
  ];

  let translated = text;
  wolErrorLabels.forEach((label, i) => {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    translated = translated.replace(new RegExp(escapedLabel, 'gi'), translatedWolErrorLabels[i]);
  });

  return translated;
}

// The resolutions of the settings by their short names, for the compact statistics line
const COMPACT_STATS_RESOLUTIONS = {
  '854x480': '480p',
  '1280x720': '720p',
  '1920x1080': '1080p',
  '2560x1440': '1440p',
  '3200x1800': '1800p',
  '3840x2160': '4K',
};

// Read the figures of a 'StatCompactMsg: ' message (FormatCompactStatsMessage() in wasm/compact_stats.hpp), or return null
// for a text that is not such an object
function parseCompactStats(text) {
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && isFinite(data.w) && isFinite(data.h) && isFinite(data.fps) ? data : null;
  } catch (e) {
    return null;
  }
}

// Build the compact statistics line from its figures, e.g.
// '4K60 HEVC HDR · 59.9 fps · 74 Mb/s · RTT 3 ms · Net drops 0.1% · Wait+pacing 6.3 ms'
// (the stream, the frames handed to the video player per second, the bitrate received, the round-trip time, the frames
// lost on the network, and the time a frame waited for the video thread plus the frame pacing delay). A figure that is
// not known yet (null) is left out. The idea of a compact line comes from Artemis, StreamLight and moonlight-tv.
function formatCompactStatsLine(data) {
  const known = (value) => typeof value === 'number' && isFinite(value);
  const resolution = COMPACT_STATS_RESOLUTIONS[data.w + 'x' + data.h];
  const stream = [resolution ? resolution + data.fps : data.w + 'x' + data.h + '@' + data.fps, data.codec,
    data.hdr ? 'HDR' : data.bits === 10 ? '10-bit' : ''];
  const parts = [stream.filter((text) => !!text).join(' ')];
  if (known(data.rfps)) {
    parts.push(data.rfps.toFixed(1) + ' fps');
  }
  if (known(data.mbps)) {
    parts.push((data.mbps < 10 ? data.mbps.toFixed(1) : String(Math.round(data.mbps))) + ' Mb/s');
  }
  if (known(data.rtt)) {
    parts.push('RTT ' + data.rtt + ' ms');
  }
  if (known(data.drop)) {
    parts.push(t('Net drops') + ' ' + data.drop.toFixed(1) + '%');
  }
  if (known(data.delay)) {
    parts.push(t('Wait+pacing') + ' ' + data.delay.toFixed(1) + ' ms');
  }
  return parts.join(' \u00b7 ');
}

// The graph of the full statistics: one bar per second for the round-trip time and a red mark above it for a second with
// frames lost on the network, over the last 60 seconds, drawn on a small canvas above the text each time the text comes
// (about once per second). The points come with the text ('StatMsg: ', FormatFullStatsMessage() in
// wasm/compact_stats.hpp) instead of a message of their own each second, as in the graph of the fork of fidoboy
// (moonlight-tizen-ac3, GPL-3.0, 262477c and 5bc0c57), whose colour steps of the RTT for a local network (below 5 ms, 5 to
// 9 ms, 10 to 19 ms, 20 ms or more) come from its 441d5c0.
const STATS_GRAPH_SECONDS = 60;
const STATS_GRAPH_RTT_STEPS_MS = [5, 10, 20];
// Mint, amber, orange and red of the theme for the steps, grey for an RTT that isn't known
const STATS_GRAPH_RTT_COLORS = ['#2EE6A0', '#FFC547', '#FF8A4C', '#FF5C7A'];
const STATS_GRAPH_UNKNOWN_COLOR = '#8D96B8';
const STATS_GRAPH_DROP_COLOR = '#FF5C7A';
// The size of the canvas in CSS pixels (style.css): a label row, the lane of the drop marks and the bars
const STATS_GRAPH_WIDTH = 480;
const STATS_GRAPH_HEIGHT = 72;
const STATS_GRAPH_DROP_TOP = 24;
const STATS_GRAPH_BARS_TOP = 36;
// The points of the graph, oldest first: { rtt, lost } (rtt null while unknown), or null for a second without figures,
// e.g. while the video track was closed. The start of a stream and a change of the level empty it.
var statsGraphPoints = [];
// When the last point came, in ms, to find the seconds without figures before the next one
var statsGraphLastPointMs = 0;

// Split the text of a 'StatMsg: ' message into the point of the graph on its first line and the text of the full
// statistics after it: { point: { rtt, lost } or null, text }. A text without a point is shown as it is.
function parseFullStatsMessage(body) {
  const text = String(body);
  const lineEnd = text.indexOf('\n');
  if (text.charAt(0) !== '{' || lineEnd < 0) {
    return { point: null, text: text };
  }
  try {
    const data = JSON.parse(text.slice(0, lineEnd));
    const rtt = data && typeof data.rtt === 'number' && isFinite(data.rtt) && data.rtt > 0 ? data.rtt : null;
    const lost = data && typeof data.lost === 'number' && isFinite(data.lost) && data.lost > 0 ? data.lost : 0;
    return { point: data && typeof data === 'object' ? { rtt: rtt, lost: lost } : null, text: text.slice(lineEnd + 1) };
  } catch (e) {
    return { point: null, text: text };
  }
}

// The colour step of a round-trip time: 0 below 5 ms, 1 from 5 ms, 2 from 10 ms, 3 from 20 ms, or -1 while unknown
function getStatsGraphRttStep(rtt) {
  if (typeof rtt !== 'number' || !(rtt > 0)) {
    return -1;
  }
  let step = 0;
  STATS_GRAPH_RTT_STEPS_MS.forEach((limit) => {
    if (rtt >= limit) {
      step++;
    }
  });
  return step;
}

// Add a point to the graph at the time nowMs. A second or more without figures before it (the decoder thread sends
// them only while frames arrive) shows as gaps, and only the last 60 seconds stay.
function addStatsGraphPoint(point, nowMs) {
  if (statsGraphPoints.length > 0 && statsGraphLastPointMs > 0) {
    const missed = Math.min(STATS_GRAPH_SECONDS, Math.round((nowMs - statsGraphLastPointMs) / 1000) - 1);
    for (let i = 0; i < missed; i++) {
      statsGraphPoints.push(null);
    }
  }
  statsGraphPoints.push(point);
  statsGraphLastPointMs = nowMs;
  if (statsGraphPoints.length > STATS_GRAPH_SECONDS) {
    statsGraphPoints.splice(0, statsGraphPoints.length - STATS_GRAPH_SECONDS);
  }
}

// Forget the points of the graph
function resetStatsGraph() {
  statsGraphPoints = [];
  statsGraphLastPointMs = 0;
}

// The round-trip time at the top of the bars, in ms: 25 ms, or the next multiple of 25 ms above the highest RTT shown
function getStatsGraphScaleMs(points) {
  let highest = 0;
  points.forEach((point) => {
    if (point && point.rtt > highest) {
      highest = point.rtt;
    }
  });
  return Math.max(25, Math.ceil(highest / 25) * 25);
}

// Draw the points on the canvas of the graph: the label 'RTT' with the scale of the bars on the left and the legend of
// the drop marks on the right, then one slot per second with the newest on the right
function drawStatsGraph(canvas, points) {
  const context = canvas.getContext ? canvas.getContext('2d') : null;
  if (!context) {
    return;
  }
  // As many pixels as the screen has, so that the bars and labels stay sharp on a 4K TV
  const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  if (canvas.width !== Math.round(STATS_GRAPH_WIDTH * ratio)) {
    canvas.width = Math.round(STATS_GRAPH_WIDTH * ratio);
    canvas.height = Math.round(STATS_GRAPH_HEIGHT * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, STATS_GRAPH_WIDTH, STATS_GRAPH_HEIGHT);
  const scaleMs = getStatsGraphScaleMs(points);
  const barsHeight = STATS_GRAPH_HEIGHT - STATS_GRAPH_BARS_TOP;
  context.textBaseline = 'top';
  context.font = '700 15px Manrope, Roboto, sans-serif';
  context.fillStyle = '#FFFFFF';
  context.textAlign = 'left';
  context.fillText('RTT', 0, 0);
  context.fillStyle = STATS_GRAPH_UNKNOWN_COLOR;
  context.fillText('0–' + scaleMs + ' ms', context.measureText('RTT').width + 10, 0);
  context.textAlign = 'right';
  context.fillText(t('Net drops'), STATS_GRAPH_WIDTH, 0);
  context.fillStyle = STATS_GRAPH_DROP_COLOR;
  context.fillRect(STATS_GRAPH_WIDTH - context.measureText(t('Net drops')).width - 18, 3, 10, 10);
  // The top of the scale and the base line
  context.fillStyle = 'rgba(255, 255, 255, 0.16)';
  context.fillRect(0, STATS_GRAPH_BARS_TOP, STATS_GRAPH_WIDTH, 1);
  context.fillRect(0, STATS_GRAPH_HEIGHT - 1, STATS_GRAPH_WIDTH, 1);
  const slotWidth = STATS_GRAPH_WIDTH / STATS_GRAPH_SECONDS;
  const firstSlot = STATS_GRAPH_SECONDS - points.length;
  points.forEach((point, index) => {
    if (!point) {
      return;
    }
    const x = Math.round((firstSlot + index) * slotWidth) + 1;
    const width = Math.max(1, Math.round(slotWidth) - 2);
    const step = getStatsGraphRttStep(point.rtt);
    const height = step < 0 ? 2 : Math.max(2, Math.round(Math.min(1, point.rtt / scaleMs) * barsHeight));
    context.fillStyle = step < 0 ? STATS_GRAPH_UNKNOWN_COLOR : STATS_GRAPH_RTT_COLORS[step];
    context.fillRect(x, STATS_GRAPH_HEIGHT - height, width, height);
    if (point.lost > 0) {
      context.fillStyle = STATS_GRAPH_DROP_COLOR;
      context.fillRect(x, STATS_GRAPH_DROP_TOP, width, 6);
    }
  });
}

// Whether the figures of the performance statistics belong on the screen: only while a stream runs. The video decoder
// thread of the module can send one more 'StatMsg: ' or 'StatCompactMsg: ' after the end of the stream (until the stop
// thread ends it), which would show the overlay over the app list, and the one of a stream that ended without video
// would show over the launch screen of its retry (retryStreamAfterNoVideo() in index.js).
function isShowingStreamStats() {
  return isInGame === true && wasmSessionStarted === true;
}

// Show the performance statistics overlay with a text, as the compact line or as the full statistics with the graph of
// the given points above it (none for an empty list), or hide it while the text is empty. The text has an element of its
// own next to the canvas of the graph; a script that empties the overlay (e.g. at the start of a stream) removes both.
function showPerformanceStats(text, isCompact, graphPoints) {
  const overlay = document.getElementById('performance-stats');
  if (!overlay) {
    return;
  }
  overlay.classList.toggle('is-compact', !!isCompact);
  overlay.style.background = '';
  if (!text) {
    overlay.textContent = '';
    overlay.style.display = 'none';
    return;
  }
  let textElement = overlay.querySelector('.stats-text');
  let canvas = overlay.querySelector('.stats-graph');
  if (!textElement) {
    overlay.textContent = '';
    textElement = document.createElement('div');
    textElement.className = 'stats-text';
    overlay.appendChild(textElement);
    canvas = null;
  }
  textElement.textContent = text;
  if (graphPoints && graphPoints.length > 0) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'stats-graph';
      overlay.insertBefore(canvas, textElement);
    }
    drawStatsGraph(canvas, graphPoints);
  } else if (canvas) {
    overlay.removeChild(canvas);
  }
  overlay.style.display = 'inline-block';
}

// Join each protocol to its port with a no-break space, so that a line never ends between 'TCP' and '48010'
function keepPortsTogether(ports) {
  return ports.replace(/(TCP|UDP) /g, '$1\u00a0');
}

// Translate the message of a connection stage that failed and the ports of the host PC it needs
// (FormatStageFailedMessage() in wasm/connection_ports.hpp), e.g. 'RTSP handshake failed (error 10060)'
function replaceKnownConnectionErrorLabels(text) {
  return text
    .replace(/^(.+) failed \(error (-?\d+)\)$/m, function(match, stage, errorCode) {
      return t('%1$s failed (error %2$s)', stage, errorCode);
    })
    .replace(/^Check that the firewall of the host PC and your router don't block these ports: (.+)$/m, function(match, ports) {
      return t('Check that the firewall of the host PC and your router don\'t block these ports: %1$s', keepPortsTogether(ports));
    });
}

function translateBackendMessage(text) {
  const normalized = normalizeBackendMessageText(text);

  let translated = t(normalized);
  translated = replaceKnownConnectionErrorLabels(translated);
  translated = replaceKnownStageLabels(translated);
  translated = replaceKnownStatsLabels(translated);

  return translated;
}

// Turn a text into the HTML of a dialog text (warningDialog() in index.js sets it as innerHTML): its characters as they
// are, and each line break as <br>, so that a blank line stays a paragraph break
function formatDialogText(text) {
  return escapeHTML(text).replace(/\n/g, '<br>');
}

// The requests of the one HTTP thread of the WebAssembly module (openUrl and pair), which run one at a time, each one
// once the one before it answered or timed out. A box art download waits behind every other request that comes in
// while it waits: opening a host with a cold box art cache queues the box art of every app (at most two at once,
// NvHTTP.getBoxArt() in utils.js), and the requests that start, resume or quit an app must not wait for them. Each
// entry is { boxArt, start(finish), drop(reason), cancel(reason) }: start() sends the request and calls finish() once
// it is settled, drop() settles a box art download that leaves the queue unsent, and cancel() cancels the one that
// runs. The idea comes from the fork of mmadej20 (moonlight-tizen-modern, GPL-3.0, f4eff8e); the queue is new.
var _httpQueue = [];
// The entry of the request that runs, or null
var _httpCurrent = null;
// The pairing request waiting in the JS queue, if any, so that canceling can keep it from starting
var _queuedPairing = null;

// Whether a request downloads box art (NvHTTP.getBoxArt() in utils.js), the only one for /appasset
function isBoxArtRequest(params) {
  return /\/appasset\?/.test(String(params[0]));
}

// Start the request at the front of the queue, unless one runs
function runNextHttpRequest() {
  if (_httpCurrent || _httpQueue.length === 0) {
    return;
  }
  var entry = _httpQueue.shift();
  var finished = false;
  var finish = function() {
    if (finished) {
      return;
    }
    finished = true;
    _httpCurrent = null;
    // After the handlers of the answer, so that a request that one of them sends (e.g. the refresh after /cancel in
    // NvHTTP.quitApp()) goes before the box art downloads that wait
    Promise.resolve().then(runNextHttpRequest);
  };
  _httpCurrent = entry;
  try {
    entry.start(finish);
  } catch (error) {
    // E.g. a module without the function: the request fails, and the ones behind it still run
    console.error('%c[messages.js, runNextHttpRequest]', 'color: gray;', 'Error: Failed to send an HTTP request:', error);
    if (entry.drop) {
      entry.drop(error);
    }
    finish();
  }
}

// Queue a request: a box art download at the end, any other request before the box art downloads that wait. The queue
// starts it after the code that sent it, so that a request sent right after a box art download still goes first.
function queueHttpRequest(entry) {
  var index = _httpQueue.length;
  if (!entry.boxArt) {
    while (index > 0 && _httpQueue[index - 1].boxArt) {
      index--;
    }
  }
  _httpQueue.splice(index, 0, entry);
  Promise.resolve().then(runNextHttpRequest);
}

// Drop the box art downloads that wait and cancel the one that runs, so that they reject with `reason`: when a stream
// starts (cancelBoxArtDownloads() in utils.js), they would only hold up the requests that start it
function dropBoxArtRequests(reason) {
  var dropped = _httpQueue.filter(function(entry) {
    return entry.boxArt;
  });
  _httpQueue = _httpQueue.filter(function(entry) {
    return !entry.boxArt;
  });
  dropped.forEach(function(entry) {
    entry.drop(reason);
  });
  if (_httpCurrent && _httpCurrent.boxArt) {
    _httpCurrent.cancel(reason);
  }
  return dropped.length;
}

/**
 * var sendMessage - Sends a message with arguments to the Wasm module
 *
 * @param  {String} method A named method
 * @param  {(String|Array)} params An array of options or a single string
 * @return {void}        The Wasm module calls back through the handleMessage method
 */
var sendMessage = function(method, params) {
  if (SyncFunctions[method]) {
    // Starting a request resets the cancel flag in C++, so a canceled pairing request
    // that is still waiting in the JS queue must not start afterwards
    if (method === 'cancelRequest' && _queuedPairing) {
      _queuedPairing.canceled = true;
    }
    return new Promise(function(resolve, reject) {
      const ret = SyncFunctions[method](...params);
      if (ret.type === "resolve") {
        resolve(ret.ret);
      } else {
        reject(ret.ret);
      }
    });
  } else if (method === 'openUrl') {
    // We MUST enforce the timeout in JavaScript because Emscripten's libcurl wrapper
    // completely ignores native timeouts (e.g., CURLOPT_CONNECTTIMEOUT) and relies on
    // the browser's native XHR timeout, which can take up to 1 minute.
    var timeout_ms = params[3] || 0;

    return new Promise(function(resolve, reject) {
      var url = params[0];
      var isFinished = false;
      var timeoutId = null;
      var finishRequest = null;
      // Settle the request once, and unlock the JS queue if it runs
      var settle = function(settleWith, value) {
        if (isFinished) {
          return;
        }
        isFinished = true;
        if (timeoutId) clearTimeout(timeoutId);
        settleWith(value);
        if (finishRequest) {
          finishRequest();
        }
      };

      queueHttpRequest({
        boxArt: isBoxArtRequest(params),
        start: function(finish) {
          finishRequest = finish;
          if (timeout_ms > 0) {
            timeoutId = setTimeout(function() {
              if (!isFinished) {
                console.warn('%c[messages.js, sendMessage]', 'color: gray;', 'Warning: HTTPS request timed out, canceling C++ HTTP request for URL:', url);
                SyncFunctions['cancelRequest']();
                settle(reject, -1); // GS_FAILED
              }
            }, timeout_ms);
          }

          const id = callbacks_ids++;
          callbacks[id] = {
            'resolve': function(msg) {
              settle(resolve, msg);
            },
            'reject': function(err) {
              settle(reject, err);
            }
          };

          AsyncFunctions['openUrl'](id, ...params);
        },
        drop: function(reason) {
          settle(reject, reason);
        },
        cancel: function(reason) {
          console.log('%c[messages.js, sendMessage]', 'color: gray;', 'Canceling the box art download that runs.');
          SyncFunctions['cancelRequest']();
          settle(reject, reason);
        }
      });
    });
  } else if (method === 'pair') {
    // Pairing runs on the same C++ HTTP thread as openUrl and waits until the PIN is entered on the host,
    // so it must wait in the same JS queue. Otherwise an openUrl request queued behind it would time out
    // and its cancelRequest would abort the pairing request instead.
    var pairing = { canceled: false };
    _queuedPairing = pairing;

    return new Promise(function(resolve, reject) {
      queueHttpRequest({
        boxArt: false,
        start: function(finish) {
          if (_queuedPairing === pairing) {
            _queuedPairing = null;
          }
          // Don't start a pairing request that was canceled while it was waiting in the queue
          if (pairing.canceled) {
            reject(-1); // GS_FAILED
            finish();
            return;
          }

          const id = callbacks_ids++;
          callbacks[id] = {
            'resolve': function(msg) {
              resolve(msg);
              finish(); // Unlock the JS queue
            },
            'reject': function(err) {
              reject(err);
              finish(); // Unlock the JS queue
            }
          };

          AsyncFunctions['pair'](id, ...params);
        }
      });
    });
  } else {
    return new Promise(function(resolve, reject) {
      const id = callbacks_ids++;
      callbacks[id] = {
        'resolve': resolve,
        'reject': reject
      };

      AsyncFunctions[method](id, ...params);
    });
  }
}

// Run one step of a handler that the native code reaches (handleMessage(), handlePromiseMessage()), and log what it
// throws instead of passing it on, so that a failing step doesn't keep the steps after it from running: e.g. an error
// in closeStreamMenu() at the end of a stream left the app in the stream view. Returns what the step returned, or
// undefined after an error. The native calls themselves catch as well (PostToJs() in wasm/main.cpp); the idea comes
// from the fork of mmadej20 (moonlight-tizen-modern, gamepad_sampling.hpp of 0b2d840).
function runGuarded(name, step) {
  try {
    return step();
  } catch (e) {
    console.error('%c[messages.js, ' + name + ']', 'color: gray;', 'Error: ' + name + ' failed:', e);
    return undefined;
  }
}

// Settle the promise of a request that the native code answered (PostPromiseMessage() in wasm/main.cpp). The callback
// is taken off the list first, so that one that throws doesn't stay there, and an answer that no request waits for
// any more is only logged.
var handlePromiseMessage = function(callbackId, type, msg) {
  var callback = callbacks[callbackId];
  delete callbacks[callbackId];
  if (!callback || typeof callback[type] !== 'function') {
    console.warn('%c[messages.js, handlePromiseMessage]', 'color: gray;', 'Warning: No request waits for the answer ' + type + ' of request ' + callbackId + '.');
    return;
  }
  runGuarded('handlePromiseMessage', function() {
    callback[type](msg);
  });
}

/**
 * leaveStreamView - Leaves the stream view and returns to the app list, after a stream ended or its start was cancelled
 *
 * @param  {Object} host The host of the stream
 * @param  {boolean} quitApp Whether to quit the app on the host first ('Quit app on the PC' of the
 *     Stream Menu)
 * @return {void}
 */
function leaveStreamView(host, quitApp) {
  // Each of these steps on its own, so that the video is removed and the app list shows also when one of them fails
  // The stream ended in a way the app saw, which its heartbeat notes (diagnostics.js)
  if (typeof StreamHeartbeat !== 'undefined') {
    runGuarded('StreamHeartbeat.stop', function() { StreamHeartbeat.stop('the stream ended'); });
  }
  // Stop the rumble that the host left on, which would otherwise keep being played
  runGuarded('Rumble.stopAll', function() { Rumble.stopAll(); });
  // Let the screensaver of the TV work again, since the menus are static
  runGuarded('setTvScreenSaver', function() { setTvScreenSaver(true); });
  // Release the audio scheduler of the Web Audio backend, which is a no-op for the EMSS backend
  runGuarded('stopAudioScheduler', function() { stopAudioScheduler(); });
  // Remove the on-screen overlays
  $('#connection-warnings, #performance-stats').css('display', 'none');
  // Remove the video stream now
  $('#listener').removeClass('fullscreen');
  $('#loadingSpinner').css('display', 'none');
  $('#loadingSpinnerMessage').text('');
  $('body').css('backgroundColor', '');
  $('#wasm_module').css('display', 'none');
  if (!host) {
    return;
  }
  // Show that the app list is on its way, since the refresh can wait behind a launch request that is still in flight
  if (typeof setUiView === 'function') {
    setUiView('loading');
  }
  $('#wasmSpinner').css('display', 'inline-block');
  $('#wasmSpinnerLogo').hide();
  $('#wasmSpinnerMessage').text(t('Loading Apps...'));
  if (quitApp) {
    // Quit the app on the host, which then shows the app list without it, or with it and the reason it still runs
    stopGame(host, function() {
      // Scroll to the current game row
      Navigation.switch();
      // Switch to Apps view
      if (!window.isDialogOpen) {
        Navigation.change(Views.Apps);
      }
    });
    return;
  }
  // Refresh the server info to update the current game and app list
  host.refreshServerInfo().then(function(ret) {
    // Return to the app list with new current game
    showApps(host).then(() => {
      // Scroll to the current game row
      Navigation.switch();
      // Switch to Apps view
      if (!window.isDialogOpen) {
        Navigation.change(Views.Apps);
      }
    });
  }, function(failedRefreshInfo) {
    console.error('%c[messages.js, leaveStreamView]', 'color: gray;', 'Error: Failed to refresh server info! Returned error was: ' + failedRefreshInfo + '!');
    // Return to the app list anyway
    showApps(host).then(() => {
      // Scroll to the current game row
      Navigation.switch();
      // Switch to Apps view
      if (!window.isDialogOpen) {
        Navigation.change(Views.Apps);
      }
    });
  });
}

// Video format that the TV rejected when the current stream added its video track (the 'VideoTrackRejected: ' message
// of wasm/video_track_rejection.hpp), for the message of the stream termination with error -200 that follows it, or
// null. The start of a stream clears it (startGame() in index.js).
var rejectedVideoTrack = null;
// The ports of the host PC that the cause of the next stream termination points to (the 'TerminationPortsMsg: ' of
// ClConnectionTerminated() in wasm/connectionlistener.cpp), e.g. 'UDP 47998, UDP 48000' when no video arrived. The
// start of a stream clears it (startGame() in index.js).
var terminationBlockedPorts = '';

// Read the video format of a 'VideoTrackRejected: ' message, e.g. 'AV1 Main10,3840,2160,60', into
// { codec, width, height, fps }, or return null for a text in another format
function parseVideoTrackRejection(text) {
  const match = /^([^,]+),(\d+),(\d+),(\d+)$/.exec(String(text).trim());
  if (!match) {
    return null;
  }
  return { codec: match[1], width: parseInt(match[2], 10), height: parseInt(match[3], 10), fps: parseInt(match[4], 10) };
}

// Tell the user which video format the TV rejected when the stream added its video track, and what to change: HEVC
// instead of AV1, or instead of H.264, which Samsung TVs generally decode only up to 1080p at 60 FPS (High Level 4.2),
// so with H.264 also a resolution up to 1080p, or a lower frame rate for a stream that is already within 1080p, and
// otherwise a lower resolution or frame rate, and HDR off for a 10-bit stream
function showVideoTrackRejection(rejection) {
  const codec = rejection.codec;
  console.warn('%c[messages.js, showVideoTrackRejection]', 'color: gray;', 'Warning: The TV rejected the video track: ' + codec + ' at ' + rejection.width + 'x' + rejection.height + '@' + rejection.fps);
  if (codec.indexOf('AV1') === 0) {
    snackbarLogLong('The TV rejected %1$s at %2$sx%3$s@%4$s FPS. Choose HEVC as the video codec.', codec, rejection.width, rejection.height, rejection.fps);
  } else if (codec === 'H.264' && (rejection.width > 1920 || rejection.height > 1080)) {
    snackbarLogLong('The TV rejected %1$s at %2$sx%3$s@%4$s FPS. Choose HEVC as the video codec, or a resolution up to 1080p.', codec, rejection.width, rejection.height, rejection.fps);
  } else if (codec === 'H.264') {
    snackbarLogLong('The TV rejected %1$s at %2$sx%3$s@%4$s FPS. Choose HEVC as the video codec, or lower the frame rate.', codec, rejection.width, rejection.height, rejection.fps);
  } else if (codec.indexOf('Main10') >= 0) {
    snackbarLogLong('The TV rejected %1$s at %2$sx%3$s@%4$s FPS. Turn off HDR, or lower the resolution or frame rate.', codec, rejection.width, rejection.height, rejection.fps);
  } else {
    snackbarLogLong('The TV rejected %1$s at %2$sx%3$s@%4$s FPS. Lower the resolution or frame rate.', codec, rejection.width, rejection.height, rejection.fps);
  }
}

/**
 * handleMessage - Handles messages from the Wasm module
 *
 * @param  {Object} msg An object given by the Wasm module
 * @return {void}
 */
function handleMessage(msg) {
  // A handler that throws is logged, and the app goes on (see runGuarded())
  runGuarded('handleMessage', function() {
    dispatchMessage(msg);
  });
}

// Tell the user why a stream ended, unless it ended normally
function showStreamTerminationMessage(errorCode, videoTrackRejection, blockedPorts) {
  switch (errorCode) {
    case 0: // ML_ERROR_GRACEFUL_TERMINATION
      break;
    case -100: // ML_ERROR_NO_VIDEO_TRAFFIC
      showNoVideoMessage(blockedPorts);
      break;
    case -101: // ML_ERROR_NO_VIDEO_FRAME
      snackbarLogLong('Your network connection isn\'t performing well. Reduce your video bitrate setting or try a faster connection.');
      break;
    case -102: // ML_ERROR_UNEXPECTED_EARLY_TERMINATION
      snackbarLogLong('Something went wrong on your host PC when starting the stream. Restart your host PC and try again.');
      break;
    case -103: // ML_ERROR_PROTECTED_CONTENT
      snackbarLogLong('An issue occurred on your host PC while starting the stream. Make sure you don\'t have any DRM-protected content open on your host PC.');
      break;
    case -104: // ML_ERROR_FRAME_CONVERSION
      snackbarLogLong('The host PC reported a fatal video encoding error. Try disabling HDR mode, changing the streaming resolution, or changing your host PC\'s display resolution.');
      break;
    case -200: // ERROR_VIDEO_SETUP_FAILED
      if (videoTrackRejection) {
        // Name the video format that the TV rejected and what to change
        showVideoTrackRejection(videoTrackRejection);
      } else {
        snackbarLogLong('The TV was unable to start the streaming with the selected video settings. Try reducing the resolution or frame rate and consider changing the codec.');
      }
      break;
    case -201: // ERROR_VIDEO_PLAYER_FAILED
      snackbarLogLong('The video player of the TV stopped with an error during the stream. Start the stream again; if it keeps happening, try a lower bitrate, resolution or frame rate.');
      break;
    default:
      // Name the error code, which a report of the problem needs
      snackbarLogLong('The connection to the PC was lost (error %1$s).', errorCode);
      break;
  }
}

// Tell the user that no video arrived from the host (ML_ERROR_NO_VIDEO_TRAFFIC), with the ports of the host PC that
// the connection named for it, if any
function showNoVideoMessage(blockedPorts) {
  if (blockedPorts) {
    snackbarLogLong('No video received from the PC. Check that the firewall of the host PC and your router don\'t block these ports: %1$s', keepPortsTogether(blockedPorts));
  } else {
    snackbarLogLong('No video received from the PC. Check the host PC\'s firewall and port forwarding rules.');
  }
}

function dispatchMessage(msg) {
  console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Message data: ', msg);
  // If it's a recognized event, notify the appropriate function
  if (msg.indexOf('streamTerminated: ') === 0) {
    // The stream is over: ignore further RED presses and late replies of its launch right away, not only once the
    // app list has loaded. This runs synchronously inside Module.stopStream(), before the next key press.
    isInGame = false;
    wasmSessionStarted = false;
    isStreamConnected = false;
    isStreamVideoTrackClosed = false;
    streamLaunchId++;
    var errorCode = parseInt(msg.replace('streamTerminated: ', ''));
    // A video format that the TV rejected belongs to this stream only
    var videoTrackRejection = rejectedVideoTrack;
    rejectedVideoTrack = null;
    // The ports named for this termination belong to this stream only
    var blockedPorts = terminationBlockedPorts;
    terminationBlockedPorts = '';
    var quitApp = quitAppAfterStream;
    quitAppAfterStream = false;
    streamMouseEmulationActive = false;
    // Each step on its own (runGuarded()), so that an error in one of them can't leave the app in the stream view.
    // The Stream Menu belongs to the stream, and 'Quit app on the PC' to this end of it (menus.js)
    runGuarded('closeStreamMenu', function() { closeStreamMenu(false); });
    // The bitrate entry of the Stream Menu ended the stream to resume it with a new bitrate: the launch screen shows
    // until it reconnects (resumeStreamAfterBitrateChange() in index.js)
    if (!quitApp && typeof resumeStreamAfterBitrateChange === 'function' && runGuarded('resumeStreamAfterBitrateChange', function() {
      return resumeStreamAfterBitrateChange(errorCode);
    }) === true) {
      // As for the retry below: the rumble of this session is ignored from now on, so stop what the host left on
      runGuarded('Rumble.stopAll', function() { Rumble.stopAll(); });
      return;
    }
    // No video arrived from the host at the start of the stream, e.g. since its display or encoder was still warming
    // up: start it once more without a word, and show the message below only if that fails as well
    // (retryStreamAfterNoVideo() in index.js)
    if (errorCode === -100 && !quitApp && typeof retryStreamAfterNoVideo === 'function' && runGuarded('retryStreamAfterNoVideo', function() {
      return retryStreamAfterNoVideo(blockedPorts);
    }) === true) {
      // Stop the rumble that the host left on, as leaveStreamView() does at the end of a stream: the retry is a new
      // session with a new controller, for which the host sends no 0, and the rumble of this one is ignored from now on
      runGuarded('Rumble.stopAll', function() { Rumble.stopAll(); });
      return;
    }
    runGuarded('leaveStreamView', function() { leaveStreamView(streamLaunchHost || api, quitApp); });
    // Show a termination snackbar message if the termination was unexpected
    runGuarded('showStreamTerminationMessage', function() {
      showStreamTerminationMessage(errorCode, videoTrackRejection, blockedPorts);
    });
  } else if (msg === 'Connection Established') {
    // A connection that completes after the user already stopped the stream or cancelled its start must neither
    // show the video nor turn the screensaver off in the menus
    if (isInGame !== true) {
      return;
    }
    isStreamConnected = true;
    // Keep the screensaver of the TV off during a session played only with a gamepad
    setTvScreenSaver(false);
    // Prepare the screen for video stream
    $('#loadingSpinner').css('display', 'none');
    $('body').css('backgroundColor', 'transparent');
    $('#wasm_module').css('display', '');
    $('#wasm_module').focus();
  } else if (msg.indexOf('ProgressMsg: ') === 0) {
    // Show progress message under loading spinner
    $('#loadingSpinnerMessage').text(translateBackendMessage(msg.replace('ProgressMsg: ', '')));
  } else if (msg.indexOf('CodecFallbackMsg: ') === 0) {
    // Tell the user that the host could only provide a fallback for the selected codec or HDR mode
    switch (msg.replace('CodecFallbackMsg: ', '')) {
      case 'HEVC':
        snackbarLogLong('The host PC can\'t encode the selected codec, so the stream uses HEVC instead.');
        break;
      case 'H264':
        snackbarLogLong('The host PC can\'t encode the selected codec, so the stream uses H.264 instead, which Samsung TVs generally decode only up to 1080p.');
        break;
      case 'SDR':
        snackbarLogLong('The host PC can\'t encode 10-bit video with this codec, so the stream runs without HDR.');
        break;
      default:
        break;
    }
  } else if (msg.indexOf('DialogMsg: ') === 0) {
    // Show dialog message using the warning dialog, which shows HTML: the line breaks of the message (e.g. the blank
    // line before the ports of a failed connection stage) become <br>, which the dialog would show as spaces otherwise
    warningDialog(t('Connection Error'), formatDialogText(translateBackendMessage(msg.replace('DialogMsg: ', ''))));
  } else if (msg.indexOf('TerminationPortsMsg: ') === 0) {
    // The connection is about to end for a cause that points to these ports of the host PC, which the termination
    // message that follows names
    terminationBlockedPorts = msg.replace('TerminationPortsMsg: ', '');
  } else if (msg.indexOf('VideoTrackRejected: ') === 0) {
    // The TV rejected every profile of the video track. Keep its video format for the stream termination with error
    // -200 that follows, which then names it.
    rejectedVideoTrack = parseVideoTrackRejection(msg.replace('VideoTrackRejected: ', ''));
  } else if (msg.indexOf('VideoTrackClosed: ') === 0) {
    // The TV closed the video track of the running stream, e.g. because another app took over the video decoder
    onStreamVideoTrackStateChanged(true, parseInt(msg.replace('VideoTrackClosed: ', ''), 10));
  } else if (msg === 'VideoTrackOpened') {
    // The TV reopened the video track of the running stream
    onStreamVideoTrackStateChanged(false, -1);
  } else if (msg === 'displayVideo') {
    // Show the video stream now
    $('#listener').addClass('fullscreen');
  } else if (msg.indexOf('NoWarningMsg: ') === 0) {
    // Hide the connection warnings overlay
    $('#connection-warnings').css('background', 'transparent');
    $('#connection-warnings').text('');
  } else if (msg.indexOf('WarningMsg: ') === 0) {
    // Show the connection warnings overlay
    $('#connection-warnings').css('background', 'rgba(0, 0, 0, 0.5)');
    $('#connection-warnings').text(translateBackendMessage(msg.replace('WarningMsg: ', '')));
  } else if (msg.indexOf('StatLevelMsg: ') === 0) {
    // The stats key (YELLOW, the Stream Menu, the gamepad or keyboard combo) stepped the performance statistics to their
    // next level: keep it as the setting, and hide the overlay until the figures of the new level arrive
    savePerformanceStatsLevel(parseInt(msg.replace('StatLevelMsg: ', ''), 10));
    showPerformanceStats('', false);
    // The graph starts again with the next figures of the full statistics, so that it never joins seconds that lie
    // apart
    resetStatsGraph();
    if (isStreamMenuOpen) {
      updateStreamMenu();
    }
  } else if (msg.indexOf('StatCompactMsg: ') === 0) {
    // The figures of the compact line, about once per second. Ones still on their way from another level are ignored,
    // and so are the last ones of a stream that is over (isShowingStreamStats())
    if (!isShowingStreamStats()) {
      return;
    }
    var compactStats = parseCompactStats(msg.replace('StatCompactMsg: ', ''));
    if (compactStats && getPerformanceStatsLevel() === PERFORMANCE_STATS_COMPACT) {
      showPerformanceStats(formatCompactStatsLine(compactStats), true);
    }
  } else if (msg.indexOf('StatMsg: ') === 0) {
    // The text of the full statistics, about once per second. Text still on its way from another level is ignored, and
    // so is the last one of a stream that is over (isShowingStreamStats()).
    if (!isShowingStreamStats() || getPerformanceStatsLevel() !== PERFORMANCE_STATS_FULL) {
      return;
    }
    // Show the performance statistics overlay, followed by the network connection of the TV if it's known
    // and the audio statistics of the Web Audio backend, under the graph with the point of this message
    var fullStats = parseFullStatsMessage(msg.replace('StatMsg: ', ''));
    if (fullStats.point) {
      addStatsGraphPoint(fullStats.point, Date.now());
    }
    var audioStatsLines = typeof getAudioStatsLines === 'function' ? getAudioStatsLines() : '';
    var backgroundStatsLine = typeof getBackgroundStatsLine === 'function' ? getBackgroundStatsLine() : '';
    showPerformanceStats(translateBackendMessage(fullStats.text) + (streamNetworkInfo ? '\n' + streamNetworkInfo : '') + (audioStatsLines ? '\n' + audioStatsLines : '') + (backgroundStatsLine ? '\n' + backgroundStatsLine : ''), false, statsGraphPoints);
    // Keep the Wi-Fi signal strength of the network connection current while the overlay is shown
    refreshStreamNetworkInfo();
  } else if (msg.indexOf('controllerRumble: ') === 0) {
    const eventData = msg.split(' ')[1].split(',');
    const gamepadIdx = parseInt(eventData[0]);
    const weakMagnitude = parseFloat(eventData[1]);
    const strongMagnitude = parseFloat(eventData[2]);
    // The WASM module keeps receiving the rumble of the host for a moment after the stream ended, until its connection
    // is torn down, and the host sends no 0 for a stream that is over. Such a late rumble would be replayed in the menus
    // without end, since the end of the stream already stopped every rumble, so only a running stream plays one.
    if (isInGame !== true || !wasmSessionStarted) {
      console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Ignoring the rumble for gamepad ' + gamepadIdx + ' that arrived after the end of the stream.');
      return;
    }
    // Play the rumble on the gamepad until the host sends 0 for both motors (see Rumble in gamepad.js)
    console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Playing rumble on gamepad ' + gamepadIdx + ' with weak magnitude ' + weakMagnitude + ' and strong magnitude ' + strongMagnitude + '...');
    Rumble.play(gamepadIdx, weakMagnitude, strongMagnitude);
  } else if (msg.indexOf('mouseEmulationOn') === 0) {
    // Show the new state of the mouse emulation in the Stream Menu while it's open, whose entry shows On and Off, or
    // else as a notice (e.g. after holding Start)
    streamMouseEmulationActive = true;
    if (isStreamMenuOpen) {
      console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Mouse emulation is activated (shown in the Stream Menu).');
      updateStreamMenu();
    } else {
      snackbarLogLong('Mouse emulation is activated');
    }
  } else if (msg.indexOf('mouseEmulationOff') === 0) {
    // Likewise for the mouse emulation that was switched off
    streamMouseEmulationActive = false;
    if (isStreamMenuOpen) {
      console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Mouse emulation is deactivated (shown in the Stream Menu).');
      updateStreamMenu();
    } else {
      snackbarLogLong('Mouse emulation is deactivated');
    }
  } else if (msg.indexOf('SessionReportMsg: ') === 0) {
    // The totals of the stream that ended, for the report of the last session in System information (index.js)
    keepSessionReport(msg.replace('SessionReportMsg: ', ''));
  } else if (msg === 'streamMenuRequested') {
    // A gamepad held Select + Start for the Stream Menu (wasm/gamepad.cpp)
    openStreamMenu();
  }
}
