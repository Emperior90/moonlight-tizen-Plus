// Diagnostics of Moonlight Plus: the report of the last session in System information, the diagnostic log of the current
// and the previous session (Settings > About > Diagnostic log), and the heartbeat of a stream that tells at the next start
// that the app ended during it. Everything stays on the TV: the log lives in memory only and is shown on the screen when
// the user opens it, with the PIN, the remote input keys and the RTSP address hidden, and the heartbeat is a tiny record
// in localStorage without any of them.
// The report at the end of a stream comes from the fork of samirmartins (moonlight-tizen, 1d8f2e3 and bcdcda5,
// diagnostics.js), in plain language instead of abbreviations. The log of the current and the previous session with the
// native lines of a ring that never blocks (wasm/diagnostic_log.hpp), the redaction and the heartbeat come from the fork of
// mmadej20 (moonlight-tizen-modern: diagnostic_logs.js, and stream_watchdog.js of c8e446d), kept in memory only.
// This script loads before the other scripts of the app, so that the log has their lines from the start.

// ===== Redaction =====

// Hide what must not be read off the screen or a photo of it: the remote input key and its id, the pairing PIN and
// secrets, the private key of the client certificate, the unique ID of the client (in the query of a request, as a
// 'name: value' pair, as 'client UID: …' of NvHTTP.toString(), as a JSON value of a stored setting or a host object, or
// as the value of its stored key), and the RTSP session URL of a stream, which holds the address and the ports of the
// host. Values that the app knows (hideDiagnosticValue()) are hidden wherever they appear.
const REDACTED_TEXT = '<hidden>';
const REDACTED_QUERY_KEYS = 'rikey|rikeyid|uniqueid|salt|clientcert|clientchallenge|serverchallengeresp|clientpairingsecret|pin';
function redactDiagnosticText(text) {
  return redactKnownValues(String(text === undefined || text === null ? '' : text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED_TEXT)
    .replace(/rtsp(?:enc|ru)?:\/\/[^\s'"<>]*/gi, 'rtsp://' + REDACTED_TEXT)
    .replace(new RegExp('([?&;](?:' + REDACTED_QUERY_KEYS + ')=)[^&\\s\'"]*', 'gi'), '$1' + REDACTED_TEXT)
    .replace(/(\\?"(?:rikey|rikeyid|uniqueid|clientUid|privateKey)\\?"\s*:\s*\\?")(?:\\\\|\\[^"]|[^"\\])*/gi, '$1' + REDACTED_TEXT)
    .replace(/(\b(?:rikey|rikeyid|uniqueid|pin)\b\s*(?:[:=]|is)\s*)[^\s,;&'"]+/gi, '$1' + REDACTED_TEXT)
    .replace(/(\bclient\s*UID\s*:\s*)[^\s,;&'"]+/gi, '$1' + REDACTED_TEXT)
    .replace(/(\b(?:uniqueid|cert)\b\s+with\s+(?:values?|data)\s*:\s*).*/gi, '$1' + REDACTED_TEXT)
    .replace(/(\bpin\b\D{0,24}?)\b\d{4,8}\b/gi, '$1' + REDACTED_TEXT));
}

// The values that redactDiagnosticText() hides wherever they appear, by name: the unique ID of the client once it is
// read or made, and the remote input key of the latest start (hideDiagnosticValue())
const diagnosticKnownValues = {};
function hideDiagnosticValue(name, value) {
  const text = String(value === undefined || value === null ? '' : value);
  // A short value could hide ordinary words or numbers
  if (text.length >= 8) {
    diagnosticKnownValues[name] = text;
  }
}
function redactKnownValues(text) {
  return Object.keys(diagnosticKnownValues).reduce(function(result, name) {
    return result.split(diagnosticKnownValues[name]).join(REDACTED_TEXT);
  }, text);
}

// ===== The diagnostic log =====

const DiagnosticLog = (function() {
  // Lines kept per session (the oldest go first), and the characters of a line
  const MAX_LINES = 600;
  const MAX_LINE_LENGTH = 400;
  // A line that repeats the one before within this time is counted instead of kept, like the native ring does
  const REPEAT_WINDOW_MS = 1000;
  // Messages of the module that come about once per second during a stream and only repeat the overlay: they would push
  // the useful lines out of the log
  const NOISE = /^\[messages\.js, handleMessage\] Message data: +(?:StatMsg|StatCompactMsg|controllerRumble): /;

  function newSession(reason) {
    return { startedAt: Date.now(), reason: reason, lines: [], dropped: 0, last: null };
  }

  // The previous session (or null) and the current one, and whether the console is captured already
  let previous = null;
  let current = newSession('start');
  let capturing = false;

  function push(session, line) {
    session.lines.push(line);
    if (session.lines.length > MAX_LINES) {
      session.lines.shift();
      session.dropped++;
    }
  }

  // Keep a line of the app ('js') at the given time, redacted and cut, unless it repeats the one before
  function add(time, source, level, text) {
    let clean = redactDiagnosticText(text).replace(/[\r\n\t]+/g, ' ').trim();
    if (clean.length > MAX_LINE_LENGTH) {
      clean = clean.slice(0, MAX_LINE_LENGTH - 1) + '…';
    }
    if (source === 'js' && NOISE.test(clean)) {
      return;
    }
    const last = current.last;
    if (last && last.source === source && last.text === clean && time - last.time < REPEAT_WINDOW_MS) {
      last.repeats++;
      return;
    }
    if (last && last.repeats > 0) {
      push(current, { time: last.time, source: last.source, level: '', text: '(the line before came ' + last.repeats + ' more times)' });
    }
    const line = { time: time, source: source, level: level || '', text: clean, repeats: 0 };
    push(current, line);
    current.last = line;
  }

  // Merge the lines of the module ('<time>\t<text>' per line, see wasm/diagnostic_log.hpp) into the current session by
  // their time. Both lists are in order, so one pass merges them (Array.prototype.sort of Chromium 69 is not stable).
  function addNative(batch) {
    if (typeof batch !== 'string' || batch === '') {
      return 0;
    }
    const nativeLines = [];
    batch.split('\n').forEach(function(record) {
      const tab = record.indexOf('\t');
      if (tab <= 0) {
        return;
      }
      const time = Number(record.slice(0, tab));
      let text = redactDiagnosticText(record.slice(tab + 1)).trim();
      if (text.length > MAX_LINE_LENGTH) {
        text = text.slice(0, MAX_LINE_LENGTH - 1) + '…';
      }
      nativeLines.push({ time: isFinite(time) ? time : Date.now(), source: 'native', level: '', text: text, repeats: 0 });
    });
    if (nativeLines.length === 0) {
      return 0;
    }
    const merged = [];
    let i = 0;
    let j = 0;
    while (i < current.lines.length || j < nativeLines.length) {
      if (j >= nativeLines.length || (i < current.lines.length && current.lines[i].time <= nativeLines[j].time)) {
        merged.push(current.lines[i++]);
      } else {
        merged.push(nativeLines[j++]);
      }
    }
    current.dropped += Math.max(0, merged.length - MAX_LINES);
    current.lines = merged.slice(-MAX_LINES);
    return nativeLines.length;
  }

  // Take the lines that the module logged since the last time (takeDiagnosticLog() of wasm/main.cpp), if it runs
  function takeNative() {
    try {
      if (typeof Module !== 'undefined' && Module && typeof Module.takeDiagnosticLog === 'function') {
        return addNative(Module.takeDiagnosticLog());
      }
    } catch (error) {
      add(Date.now(), 'js', 'W', 'Taking the lines of the native log failed: ' + error);
    }
    return 0;
  }

  // Start a new session, e.g. when a stream starts: the current one becomes the previous one, and the one before that
  // goes. The lines that the module logged until now still belong to the session that ends.
  function startSession(reason) {
    takeNative();
    previous = current;
    current = newSession(reason);
  }

  // The text of a console call: the style arguments of '%c' left out, an error as its message, an object as JSON
  function formatConsoleArguments(args) {
    const parts = [];
    let skipStyles = 0;
    for (let i = 0; i < args.length; i++) {
      let value = args[i];
      if (skipStyles > 0) {
        skipStyles--;
        continue;
      }
      if (typeof value === 'string') {
        if (value.indexOf('%c') >= 0) {
          skipStyles = value.split('%c').length - 1;
          value = value.split('%c').join('');
        }
        parts.push(value);
      } else if (value instanceof Error) {
        parts.push(value.name + ': ' + value.message);
      } else if (value !== null && typeof value === 'object') {
        let json = '';
        try {
          json = JSON.stringify(value);
        } catch (error) {
          json = '';
        }
        parts.push(json && json !== '{}' ? json.slice(0, 200) : String(value));
      } else {
        parts.push(String(value));
      }
    }
    return parts.join(' ');
  }

  // Keep the lines that the app writes to the console as well, without changing what the console gets
  function captureConsole(target) {
    if (capturing || !target) {
      return;
    }
    capturing = true;
    [['log', ''], ['info', ''], ['debug', ''], ['warn', 'W'], ['error', 'E']].forEach(function(entry) {
      const original = target[entry[0]];
      if (typeof original !== 'function') {
        return;
      }
      target[entry[0]] = function() {
        try {
          add(Date.now(), 'js', entry[1], formatConsoleArguments(arguments));
        } catch (error) {
          // The log must never disturb the console
        }
        return original.apply(target, arguments);
      };
    });
  }

  function pad(value, length) {
    return ('000' + value).slice(-length);
  }

  // One line as it is shown: the time of the TV, the source and the text, e.g. '20:15:03.120 native  RTSP handshake'
  function formatLine(line) {
    const date = new Date(line.time);
    const time = pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) + ':' + pad(date.getSeconds(), 2) + '.' +
      pad(date.getMilliseconds(), 3);
    return time + ' ' + (line.source === 'native' ? 'native' : 'app   ') + ' ' + (line.level ? line.level + ' ' : '') + line.text;
  }

  // The sessions as they are shown, oldest first: { title, lines } with the title names the start of the session
  function getSessions() {
    takeNative();
    const sessions = [];
    [previous, current].forEach(function(session) {
      if (!session) {
        return;
      }
      // A value that the app learnt after a line was kept is hidden in it as well (hideDiagnosticValue())
      const lines = session.lines.map(function(line) {
        return redactKnownValues(formatLine(line));
      });
      if (session.last && session.last.repeats > 0) {
        lines.push(formatLine({ time: session.last.time, source: session.last.source, level: '',
          text: '(the line before came ' + session.last.repeats + ' more times)' }));
      }
      if (session.dropped > 0) {
        lines.unshift('… ' + session.dropped + ' earlier lines are no longer kept');
      }
      sessions.push({ current: session === current, startedAt: session.startedAt, reason: session.reason, lines: lines });
    });
    return sessions;
  }

  return {
    add: function(text, level) {
      add(Date.now(), 'js', level, text);
    },
    addNative: addNative,
    takeNative: takeNative,
    startSession: startSession,
    captureConsole: captureConsole,
    formatConsoleArguments: formatConsoleArguments,
    formatLine: formatLine,
    getSessions: getSessions,
  };
})();

// ===== The report of the last session =====

// Read the totals of a stream from the message of the module (the JSON object of FormatSessionReportMessage() in
// wasm/session_report.hpp), or null for one that isn't one
function parseSessionReport(json) {
  let data = null;
  try {
    data = JSON.parse(json);
  } catch (error) {
    return null;
  }
  if (!data || typeof data !== 'object') {
    return null;
  }
  const number = (key) => (typeof data[key] === 'number' && isFinite(data[key]) && data[key] >= 0 ? data[key] : 0);
  return {
    durationMs: number('durationMs'),
    codec: typeof data.codec === 'string' ? data.codec : '',
    width: number('width'),
    height: number('height'),
    fps: number('fps'),
    bitrateKbps: number('bitrateKbps'),
    frames: number('frames'),
    networkDroppedFrames: number('networkDroppedFrames'),
    tvDroppedFrames: number('tvDroppedFrames'),
    videoResets: number('videoResets'),
    recoveryKeyframes: number('recoveryKeyframes'),
    fecRecoveredBlocks: number('fecRecoveredBlocks'),
    fecFailures: number('fecFailures'),
    heapTopMb: number('heapTopMb'),
    heapTotalMb: number('heapTotalMb'),
    heapGrowthMb: number('heapGrowthMb'),
  };
}

// The hints of a report in plain language, at most 3, most important first, as keys of SESSION_REPORT_HINTS. The options
// say whether reference frame invalidation was on, which a hint about recovery keyframes suggests otherwise.
function getSessionReportHints(report, options) {
  const opts = options || {};
  if (report.frames === 0) {
    return ['noVideo'];
  }
  const minutes = Math.max(1, report.durationMs / 60000);
  const networkPercent = report.networkDroppedFrames / report.frames * 100;
  const tvPercent = report.tvDroppedFrames / report.frames * 100;
  const hints = [];
  const network = networkPercent >= 0.5 && report.networkDroppedFrames >= 10;
  if (network) {
    hints.push('network');
  }
  if ((tvPercent >= 0.5 && report.tvDroppedFrames >= 10) || report.videoResets >= 3) {
    hints.push('tv');
  }
  if (report.recoveryKeyframes >= 3 && !opts.refFrameInvalidation && /^(HEVC|AV1)/.test(report.codec)) {
    hints.push('keyframes');
  }
  if (!network && (report.fecFailures > 0 || report.fecRecoveredBlocks / minutes >= 60)) {
    hints.push('fec');
  }
  if (report.heapTotalMb > 0 && report.heapTopMb >= report.heapTotalMb * 0.85) {
    hints.push('memory');
  }
  return hints.length > 0 ? hints.slice(0, 3) : ['ok'];
}

// The text of a hint of getSessionReportHints(), translated
function getSessionReportHintText(hint) {
  switch (hint) {
    case 'noVideo':
      return t('No video arrived from the PC in this session.');
    case 'network':
      return t('Many frames were lost on the network: use a cable or lower the bitrate.');
    case 'tv':
      return t('The TV could not keep up with the video: lower the bitrate, the resolution or the frame rate.');
    case 'keyframes':
      return t('The PC often sent whole frames again after a loss: turn on Reference frame invalidation in the Advanced Settings.');
    case 'fec':
      return t('Error correction repaired many lost packets: the network is near its limit, so a cable or a lower bitrate gives more headroom.');
    case 'memory':
      return t('The memory of the app is nearly full: restart the app before the next long session.');
    default:
      return t('No problems found in this session.');
  }
}

// A number with the separators of the language of the app, with the given number of decimals (none by default)
function formatReportNumber(value, decimals) {
  const locale = typeof window !== 'undefined' && window.i18n && typeof window.i18n.getLocale === 'function' ? window.i18n.getLocale() : undefined;
  const digits = decimals || 0;
  try {
    return Number(value).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  } catch (error) {
    return Number(value).toFixed(digits);
  }
}

// The lines of a report for System information, translated (t() of i18n.js), e.g.
//   Last session: 12 min 34 s, HEVC Main10, 3840x2160, 60 FPS, 75 Mbps
//   Frames lost on the network: 3 of 45,240 (0.01%)
//   Frames dropped by the TV: 0, video resets: 0, recovery keyframes: 0
//   FEC repairs: 12 blocks, 0 failed
//   WASM heap at the end: 61 of 128 MB (+1 MB in this session)
//   Hint: No problems found in this session.
function describeSessionReport(report, options) {
  if (!report) {
    return [t('Last session: %1$s', t('None yet'))];
  }
  const seconds = Math.round(report.durationMs / 1000);
  const duration = seconds >= 60 ? t('%1$s min %2$s s', Math.floor(seconds / 60), seconds % 60) : t('%1$s s', seconds);
  const stream = report.frames > 0 ?
    [report.codec, report.width + 'x' + report.height, report.fps + ' FPS'].filter(Boolean).join(', ') : t('No video');
  const percent = formatReportNumber(report.frames > 0 ? report.networkDroppedFrames / report.frames * 100 : 0, 2);
  const lines = [
    t('Last session: %1$s', duration + ', ' + stream + ', ' + formatReportNumber(report.bitrateKbps / 1000, report.bitrateKbps % 1000 === 0 ? 0 : 1) + ' Mbps'),
    t('Frames lost on the network: %1$s of %2$s (%3$s%)', formatReportNumber(report.networkDroppedFrames),
      formatReportNumber(report.frames), percent),
    t('Frames dropped by the TV: %1$s, video resets: %2$s, recovery keyframes: %3$s', formatReportNumber(report.tvDroppedFrames),
      formatReportNumber(report.videoResets), formatReportNumber(report.recoveryKeyframes)),
    t('FEC repairs: %1$s blocks, %2$s failed', formatReportNumber(report.fecRecoveredBlocks), formatReportNumber(report.fecFailures)),
    t('WASM heap at the end: %1$s of %2$s MB (+%3$s MB in this session)', report.heapTopMb, report.heapTotalMb, report.heapGrowthMb),
  ];
  getSessionReportHints(report, options).forEach(function(hint) {
    lines.push(t('Hint: %1$s', getSessionReportHintText(hint)));
  });
  return lines;
}

// ===== The heartbeat of a stream =====

// While a stream runs, a tiny record in localStorage says so and when the stream was last alive. A stream that ends in
// any way the app sees (it ended, its start was cancelled, the app went to the background) marks it idle, and one in the
// background hidden, since the TV may close a hidden app. A record still marked as streaming at the next start means
// that the app ended during the stream: it crashed or froze and was closed, or the TV was switched off. That is reported
// once, since the diagnostic log of that session was in memory only.
// Each beat also takes the lines of the native log, so that its ring doesn't overflow during a long stream, and notes a
// beat that came much too late, i.e. a main thread that was blocked.
const StreamHeartbeat = (function() {
  const STORAGE_KEY = 'moonlightStreamHeartbeat';
  const INTERVAL_MS = 5000;
  const STALL_MS = 2500;
  let timer = null;
  let startedAt = 0;
  let lastBeat = 0;

  function write(record) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch (error) {
      // The heartbeat is an aid: storage problems must never affect the stream
    }
  }

  function read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  // A stream in the background counts as hidden: the TV may close Moonlight then, which is no crash
  function isHidden() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  function beat() {
    const now = Date.now();
    if (lastBeat && now - lastBeat > INTERVAL_MS + STALL_MS && !isHidden()) {
      DiagnosticLog.add('The main thread was blocked for about ' + (now - lastBeat - INTERVAL_MS) + ' ms during the stream', 'W');
    }
    lastBeat = now;
    DiagnosticLog.takeNative();
    write({ state: isHidden() ? 'hidden' : 'streaming', startedAt: startedAt, lastBeat: now });
  }

  // Note at once when the app goes to the background or comes back during a stream
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function() {
      if (timer !== null) {
        beat();
      }
    });
  }

  // A stream starts
  function start() {
    stop(null);
    startedAt = Date.now();
    lastBeat = 0;
    beat();
    timer = setInterval(beat, INTERVAL_MS);
  }

  // The stream ended in a way the app saw
  function stop(reason) {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (reason !== null) {
      write({ state: 'idle', endedAt: Date.now(), reason: String(reason || '') });
    }
  }

  // Check at the start of the app whether it ended during a stream the last time, and mark that as reported, so that it
  // is reported only once. Returns { lastBeat, minutes } of that stream, or null.
  function takePreviousRun() {
    const record = read();
    if (!record || record.state !== 'streaming') {
      return null;
    }
    write({ state: 'idle', endedAt: record.lastBeat, reason: 'reported at the next start' });
    const lastBeatTime = Number(record.lastBeat) || 0;
    const startTime = Number(record.startedAt) || lastBeatTime;
    return { lastBeat: lastBeatTime, minutes: Math.max(0, Math.round((lastBeatTime - startTime) / 60000)) };
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    INTERVAL_MS: INTERVAL_MS,
    start: start,
    stop: stop,
    takePreviousRun: takePreviousRun,
  };
})();

// ===== The dialog of the diagnostic log =====

// How far UP and DOWN scroll the log
const DIAGNOSTIC_LOG_SCROLL_PX = 240;

// Show the log of the current and the previous session (Settings > About > Diagnostic log), scrolled to its end. The
// text goes in as text, never as HTML.
function showDiagnosticLog() {
  const box = document.getElementById('diagnosticLogText');
  box.textContent = '';
  DiagnosticLog.getSessions().forEach(function(session) {
    const title = document.createElement('div');
    title.className = 'log-session-title';
    const start = new Date(session.startedAt);
    const startText = start.toLocaleTimeString ? start.toLocaleTimeString() : String(start);
    title.textContent = session.current ? t('This session, since %1$s', startText) : t('Previous session, since %1$s', startText);
    const lines = document.createElement('div');
    lines.className = 'log-session-lines';
    lines.textContent = session.lines.length > 0 ? session.lines.join('\n') : t('No lines yet');
    box.appendChild(title);
    box.appendChild(lines);
  });
  $('#diagnosticLogDialogOverlay').css('display', 'flex');
  document.getElementById('diagnosticLogDialog').showModal();
  isDialogOpen = true;
  Navigation.push(Views.DiagnosticLogDialog);
  box.parentElement.scrollTop = box.parentElement.scrollHeight;
  console.log('%c[diagnostics.js, showDiagnosticLog]', 'color: teal;', 'Showing the diagnostic log.');
}

// The scroll area of the log is the content of its dialog
function scrollDiagnosticLog(direction) {
  document.getElementById('diagnosticLogText').parentElement.scrollTop += direction * DIAGNOSTIC_LOG_SCROLL_PX;
}

function closeDiagnosticLog() {
  $('#diagnosticLogDialogOverlay').css('display', 'none');
  document.getElementById('diagnosticLogDialog').close();
  document.getElementById('diagnosticLogText').textContent = '';
  isDialogOpen = false;
  Navigation.pop();
  Navigation.switch();
}

// Keep the console lines of the app from now on
DiagnosticLog.captureConsole(typeof console !== 'undefined' ? console : null);
