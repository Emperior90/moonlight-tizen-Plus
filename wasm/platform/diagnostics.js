// Diagnostics of Moonlight Plus: the report of the last session in System information, the diagnostic log of the current
// and the previous session (Settings > About > Diagnostic log), and the heartbeat of a stream that tells at the next start
// that the app ended during it. Everything stays on the TV: the log lives in memory only and is shown on the screen when
// the user opens it, with the PIN, the remote input keys, the RTSP address, the public IP address and the MAC addresses
// hidden, and the heartbeat is a tiny record in localStorage without any of them.
// The report at the end of a stream comes from the fork of samirmartins (moonlight-tizen, 1d8f2e3 and bcdcda5,
// diagnostics.js), in plain language instead of abbreviations. The log of the current and the previous session with the
// native lines of a ring that never blocks (wasm/diagnostic_log.hpp), the redaction and the heartbeat come from the fork of
// mmadej20 (moonlight-tizen-modern: diagnostic_logs.js, and stream_watchdog.js of c8e446d), kept in memory only.
// This script loads before the other scripts of the app, so that the log has their lines from the start, and the
// uncaught errors and unhandled promise rejections of all of them.

// ===== Redaction =====

// Hide what must not be read off the screen or a photo of it: the remote input key and its id, the pairing PIN and
// secrets, the private key of the client certificate, the unique ID of the client (in the query of a request, as a
// 'name: value' pair, as 'client UID: …' of NvHTTP.toString(), as a JSON value of a stored setting or a host object, or
// as the value of its stored key), and the RTSP session URL of a stream, which holds the address and the ports of the
// host. Values that the app knows (hideDiagnosticValue()) are hidden wherever they appear. A JSON value that a cut left
// without its closing quote is hidden up to the end of its line (a JSON string has no line break), so that the lines of
// NvHTTP.toString() that a console call often adds after a host object stay.
// Users post photos of the log on the public issue tracker, so it also hides what identifies their household on the
// internet or their devices: the public (external) IP address that STUN or the host reports ('external IP: …' of
// NvHTTP.toString(), a host object as JSON, <ExternalIP> of the server info, and its value wherever it appears once the
// app knows it, e.g. in the URL of a request to a host that doesn't answer: hideDiagnosticAddress()) and every MAC
// address. The all-zero MAC 00:00:00:00:00:00 stays, since it tells that a host never reported its MAC, which
// Wake-on-LAN needs. The local addresses, the addresses that the user entered and the names of the PCs stay as well:
// support needs them, and the bug form tells users to cover them.
const REDACTED_TEXT = '<hidden>';
const REDACTED_QUERY_KEYS = 'rikey|rikeyid|uniqueid|salt|clientcert|clientchallenge|serverchallengeresp|clientpairingsecret|pin';
const MAC_ADDRESS_PATTERN = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g;
const ZERO_MAC_ADDRESS_PATTERN = /^(?:00[:-]){5}00$/;
function redactDiagnosticText(text) {
  return redactKnownValues(String(text === undefined || text === null ? '' : text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED_TEXT)
    .replace(/rtsp(?:enc|ru)?:\/\/[^\s'"<>]*/gi, 'rtsp://' + REDACTED_TEXT)
    .replace(new RegExp('([?&;](?:' + REDACTED_QUERY_KEYS + ')=)[^&\\s\'"]*', 'gi'), '$1' + REDACTED_TEXT)
    .replace(/(\\?"(?:rikey|rikeyid|uniqueid|clientUid|privateKey|externalIP)\\?"\s*:\s*\\?")(?:\\\\|\\[^"\r\n]|[^"\\\r\n])*/gi, '$1' + REDACTED_TEXT)
    .replace(/(\b(?:rikey|rikeyid|uniqueid|pin)\b\s*(?:[:=]|is)\s*)[^\s,;&'"]+/gi, '$1' + REDACTED_TEXT)
    .replace(/(\bclient\s*UID\s*:\s*)[^\s,;&'"]+/gi, '$1' + REDACTED_TEXT)
    .replace(/(\bexternal[ \t]*IP[ \t]*:[ \t]*)[^\s,;&'"<]+/gi, '$1' + REDACTED_TEXT)
    .replace(/(\bexternal IPv4 address of [^\r\n]{0,80}? is\s+)[^\s,;&'"<]+/gi, '$1' + REDACTED_TEXT)
    .replace(/(<ExternalIP>)[^<]*/gi, '$1' + REDACTED_TEXT)
    .replace(MAC_ADDRESS_PATTERN, (mac) => (ZERO_MAC_ADDRESS_PATTERN.test(mac) ? mac : REDACTED_TEXT))
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

// The public IP addresses that STUN or a host reported, which redactDiagnosticText() hides wherever they appear, as
// patterns by address (hideDiagnosticAddress()): the rules above find the address only by its label, not in a URL, e.g.
// of a request to a host that doesn't answer. Only these addresses are hidden, not everything that looks like a public
// address (a GFE version such as 3.23.0.74 does), and only as a whole, so that 203.0.113.7 leaves 203.0.113.70 alone.
// A private, loopback or link-local address is never hidden, since support needs the local ones.
const diagnosticKnownAddresses = {};
const IPV4_ADDRESS_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_ADDRESS_PATTERN = /^(?=[0-9A-Fa-f:]*::|(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}$)[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}$/;
const LOCAL_ADDRESS_PATTERN = /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^(?:fe[89ab]|f[cd])|^::1?$/i;
function hideDiagnosticAddress(address) {
  const text = String(address === undefined || address === null ? '' : address).trim();
  const ipv4 = IPV4_ADDRESS_PATTERN.test(text);
  if ((!ipv4 && !IPV6_ADDRESS_PATTERN.test(text)) || LOCAL_ADDRESS_PATTERN.test(text) ||
    Object.prototype.hasOwnProperty.call(diagnosticKnownAddresses, text)) {
    return;
  }
  const escaped = text.replace(/[.]/g, '\\.');
  diagnosticKnownAddresses[text] = ipv4 ? new RegExp('(?<![\\d.])' + escaped + '(?!\\d|\\.\\d)', 'g')
    : new RegExp('(?<![0-9A-Fa-f:])' + escaped + '(?![0-9A-Fa-f]|:[0-9A-Fa-f:])', 'gi');
}

function redactKnownValues(text) {
  const withoutValues = Object.keys(diagnosticKnownValues).reduce(function(result, name) {
    return result.split(diagnosticKnownValues[name]).join(REDACTED_TEXT);
  }, text);
  return Object.keys(diagnosticKnownAddresses).reduce(function(result, address) {
    return result.replace(diagnosticKnownAddresses[address], REDACTED_TEXT);
  }, withoutValues);
}

// A line of the log keeps only the start of a long text, so only about that much of it is redacted: the rules ran over
// the whole text before it was cut, e.g. over every character of a large object or message, on the main thread of the
// TV, for each console call. A secret that the cut leaves half is no longer found by its rule, but it stays at the very
// end of the redacted start, as nothing after it is left to change. So the start is redacted with REDACTION_CUT_GUARD
// characters to spare (or more than the longest value of hideDiagnosticValue()), and taken again, four times as long,
// while the redaction shortened it so much that its end would fall within the kept part (e.g. a private key of a few
// hundred characters becomes '<hidden>'). redactDiagnosticStart(startOf, keep, finish) returns the redacted start (after
// finish(), e.g. joining its lines), of which the first `keep` characters are the same as of the whole text redacted.
// startOf(size) gives the first `size` characters of the text, or all of it when it is shorter. A start that ends in a
// hidden value leaves no half secret behind, so a huge one (e.g. a private key of many KB) stops growing at
// REDACTION_START_LIMIT, and the line ends with '<hidden>'.
const REDACTION_CUT_GUARD = 256;
const REDACTION_START_LIMIT = 16 * 1024;
function redactDiagnosticStart(startOf, keep, finish) {
  const longestValue = Object.keys(diagnosticKnownValues).reduce(function(longest, name) {
    return Math.max(longest, diagnosticKnownValues[name].length);
  }, 0);
  const guard = Math.max(REDACTION_CUT_GUARD, longestValue + 1);
  for (let size = keep + 2 * guard; ; size *= 4) {
    const start = startOf(size);
    const redacted = redactDiagnosticText(start);
    const clean = finish ? finish(redacted) : redacted;
    if (start.length < size || clean.length >= keep + guard ||
      (size * 4 > REDACTION_START_LIMIT && clean.slice(-REDACTED_TEXT.length) === REDACTED_TEXT)) {
      return clean;
    }
  }
}

// The first `limit` characters of JSON.stringify(value), or all of it when it is shorter, without turning the rest of a
// large object into text: each property stops being written once the text is long enough, and a long string is written
// only as far as it can show. A cycle on the way throws like JSON.stringify().
function jsonStart(value, limit) {
  let out = '';
  const stack = [];
  // Write the JSON of holder[key], or return false for a value that JSON leaves out (undefined, a function, a symbol)
  const write = function(holder, key) {
    let item = holder[key];
    if (item !== null && typeof item === 'object' && typeof item.toJSON === 'function') {
      item = item.toJSON(key);
    }
    const tag = item !== null && typeof item === 'object' ? Object.prototype.toString.call(item) : '';
    if (tag === '[object Number]' || tag === '[object String]' || tag === '[object Boolean]') {
      item = item.valueOf();
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      out += JSON.stringify(item);
      return true;
    }
    if (typeof item === 'string') {
      const room = Math.max(0, limit - out.length);
      out += JSON.stringify(item.length > room ? item.slice(0, room) : item);
      return true;
    }
    if (typeof item !== 'object') {
      return false;
    }
    if (stack.indexOf(item) >= 0) {
      throw new TypeError('Converting circular structure to JSON');
    }
    stack.push(item);
    if (Array.isArray(item)) {
      out += '[';
      for (let i = 0; i < item.length && out.length < limit; i++) {
        out += i > 0 ? ',' : '';
        if (!write(item, String(i))) {
          out += 'null';
        }
      }
      out += ']';
    } else {
      out += '{';
      // The keys of a typed array (e.g. the bytes of box art) are its indexes, which Object.keys() would list in full
      const typed = ArrayBuffer.isView(item) && tag !== '[object DataView]';
      const keys = typed ? null : Object.keys(item);
      const count = typed ? item.length : keys.length;
      let written = 0;
      for (let i = 0; i < count && out.length < limit; i++) {
        const key = typed ? String(i) : keys[i];
        const before = out.length;
        out += (written > 0 ? ',' : '') + JSON.stringify(key) + ':';
        if (write(item, key)) {
          written++;
        } else {
          out = out.slice(0, before);
        }
      }
      out += '}';
    }
    stack.pop();
    return true;
  };
  write({ '': value }, '');
  return out.length > limit ? out.slice(0, limit) : out;
}

// ===== The diagnostic log =====

const DiagnosticLog = (function() {
  // Lines kept per session (the oldest go first), and the characters of a line
  const MAX_LINES = 600;
  const MAX_LINE_LENGTH = 400;
  // The characters of an object in a line, as JSON
  const MAX_OBJECT_LENGTH = 200;
  // A line that repeats the one before within this time is counted instead of kept, like the native ring does
  const REPEAT_WINDOW_MS = 1000;
  // Messages of the module that come again and again during a stream and only repeat the overlay or the rumble of a
  // game: they would push the useful lines out of the log. messages.js writes them to the console only while its
  // logFrequentMessages is set for a debugging session (FREQUENT_MESSAGE there), and the log leaves them out then too.
  const NOISE = /^\[messages\.js, handleMessage\] Message data: +(?:StatMsg|StatCompactMsg|controllerRumble): /;
  // The uncaught errors and unhandled promise rejections of the page that a session keeps as lines (captureUncaught()):
  // each different text once, and at most this many. The others are only counted, so that an error that repeats, e.g.
  // in a handler that runs for every frame, can't push the other lines out of the log.
  const MAX_UNCAUGHT_LINES = 20;

  function newSession(reason) {
    return { startedAt: Date.now(), reason: reason, lines: [], dropped: 0, last: null,
      uncaught: { texts: Object.create(null), kept: 0, notKept: 0 } };
  }

  // The previous session (or null) and the current one, and whether the console and the uncaught errors of the page are
  // captured already
  let previous = null;
  let current = newSession('start');
  let capturing = false;
  let capturingUncaught = false;

  function push(session, line) {
    session.lines.push(line);
    if (session.lines.length > MAX_LINES) {
      session.lines.shift();
      session.dropped++;
    }
  }

  // One line of a text: its line breaks and tabs as spaces
  function oneLine(text) {
    return text.replace(/[\r\n\t]+/g, ' ').trim();
  }

  // A text as a line keeps it: redacted, on one line and cut. Only the start of a long text is redacted, as much as the
  // line keeps (redactDiagnosticStart()).
  function cleanLine(text) {
    const full = text === undefined || text === null ? '' : String(text);
    const clean = redactDiagnosticStart(function(size) {
      return full.slice(0, size);
    }, MAX_LINE_LENGTH, oneLine);
    return clean.length > MAX_LINE_LENGTH ? clean.slice(0, MAX_LINE_LENGTH - 1) + '…' : clean;
  }

  // Keep a line of the app ('js') at the given time, redacted and cut, unless it repeats the one before. A line of
  // NOISE is dropped as it comes, before the work of redacting it: its start, which the pattern reads, has nothing that
  // the redaction changes.
  function add(time, source, level, text) {
    if (source === 'js' && NOISE.test(text)) {
      return;
    }
    keep(time, source, level, cleanLine(text));
  }

  // Keep a line whose text is redacted and cut already (cleanLine(), which must not run over a text twice: a second
  // pass adds a second '<hidden>' after an RTSP address)
  function keep(time, source, level, clean) {
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

  // Keep an uncaught error or an unhandled promise rejection of the page as a line at level E, redacted like every
  // line. A text that the session already holds, and every text after MAX_UNCAUGHT_LINES different ones, is only
  // counted (getSessions() tells how many), without the work of redacting it once the limit is reached.
  function addUncaught(text) {
    const uncaught = current.uncaught;
    if (uncaught.kept >= MAX_UNCAUGHT_LINES) {
      uncaught.notKept++;
      return;
    }
    const clean = cleanLine(text);
    if (uncaught.texts[clean]) {
      uncaught.notKept++;
      return;
    }
    uncaught.texts[clean] = true;
    uncaught.kept++;
    keep(Date.now(), 'js', 'E', clean);
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
      let text = redactDiagnosticStart(function(size) {
        return record.slice(tab + 1, tab + 1 + size);
      }, MAX_LINE_LENGTH, function(redacted) {
        return redacted.trim();
      });
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

  // The text of a console call: the style arguments of '%c' left out, an error as its message, an object as JSON. Only
  // the start of the JSON of an object is made and redacted, as much as the line keeps of it (jsonStart(),
  // redactDiagnosticStart()): a large object, e.g. the hosts or a host with its certificate, was turned into text and
  // redacted as a whole for each console call.
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
          json = redactDiagnosticStart(function(size) {
            return jsonStart(value, size);
          }, MAX_OBJECT_LENGTH);
        } catch (error) {
          json = '';
        }
        // Hidden before it is cut, since a rule no longer finds a value that the cut leaves half, e.g. a MAC address
        parts.push(json && json !== '{}' ? json.slice(0, MAX_OBJECT_LENGTH) : String(value));
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

  // The name of a script from its address, without the folders of the app on the TV and without a query, e.g.
  // 'index.js' for 'file:///opt/usr/apps/<package>/res/wgt/platform/index.js'
  function scriptName(address) {
    const text = String(address === undefined || address === null ? '' : address).replace(/[?#].*$/, '');
    return text.slice(text.lastIndexOf('/') + 1);
  }

  // The line of an uncaught error (an 'error' event of the window): its message, which Chromium starts with
  // 'Uncaught', and the script, line and column where it was thrown, e.g.
  // 'Uncaught TypeError: host.refreshServerInfo is not a function (index.js:502:10)'
  function describeUncaughtError(event) {
    const message = event && event.message ? String(event.message) : 'Script error.';
    const script = scriptName(event && event.filename);
    return (/^Uncaught\b/.test(message) ? '' : 'Uncaught error: ') + message +
      (script ? ' (' + script + ':' + (event.lineno || 0) + ':' + (event.colno || 0) + ')' : '');
  }

  // The line of an unhandled promise rejection: its reason, for an error the name and the message with the place of
  // the first frame of its stack, e.g. 'Unhandled promise rejection: BindingError: Cannot pass "x" as a int
  // (moonlight-wasm.js:1:2345)', for anything else as a console call would show it
  function describeUnhandledRejection(event) {
    const reason = event ? event.reason : undefined;
    if (reason !== null && typeof reason === 'object' && typeof reason.message === 'string') {
      const place = /^\s*at .*?([^\s()/]+):(\d+):(\d+)\)?\s*$/m.exec(typeof reason.stack === 'string' ? reason.stack : '');
      return 'Unhandled promise rejection: ' + (reason.name ? reason.name + ': ' : '') + reason.message +
        (place ? ' (' + scriptName(place[1]) + ':' + place[2] + ':' + place[3] + ')' : '');
    }
    return 'Unhandled promise rejection: ' + formatConsoleArguments([reason]);
  }

  // Keep the uncaught errors and the unhandled promise rejections of the page as well (the 'error' and
  // 'unhandledrejection' events of the window, which Chromium 69 has): the browser reports both without a call of
  // console.error, so a script error on a TV left no trace in the log that the user can show. A listener on the window
  // gets the errors of scripts only, not a file that failed to load, whose event doesn't bubble. Nothing is changed for
  // the page: the events aren't cancelled, so the console still gets them.
  function captureUncaught(target) {
    if (capturingUncaught || !target || typeof target.addEventListener !== 'function') {
      return;
    }
    capturingUncaught = true;
    target.addEventListener('error', function(event) {
      try {
        addUncaught(describeUncaughtError(event));
      } catch (error) {
        // The log must never disturb the page
      }
    });
    target.addEventListener('unhandledrejection', function(event) {
      try {
        addUncaught(describeUnhandledRejection(event));
      } catch (error) {
        // As above
      }
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
      if (session.uncaught.notKept > 0) {
        lines.push('… ' + session.uncaught.notKept + ' more uncaught errors or unhandled promise rejections are not kept (the same ones again, or more than ' +
          MAX_UNCAUGHT_LINES + ' different ones in this session)');
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
    captureUncaught: captureUncaught,
    formatConsoleArguments: formatConsoleArguments,
    formatLine: formatLine,
    getSessions: getSessions,
  };
})();

// ===== The report of the last session =====

// Read the totals of a stream from the message of the module (the JSON object of FormatSessionReportMessage() in
// wasm/session_report.hpp), or null for one that isn't one. A figure that the message lacks is 0, and a message without
// hostRfi (2.3.0 sent none) tells nothing about the host, which counts as a host that didn't offer it. The same goes for
// the lowest host frame rate with its windows and for the frame receive time, which 2.3.0 didn't send either: at 0
// their lines and the hint about the frames of the PC are left out.
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
    hostFrameRateX100: number('hostFrameRateX100'),
    hostProcessingLatencyX10: number('hostProcessingLatencyX10'),
    hostFrameRateLowX100: number('hostFrameRateLowX100'),
    hostWindows: number('hostWindows'),
    hostLowWindows: number('hostLowWindows'),
    receiveTimeX100: number('receiveTimeX100'),
    receiveTimePeakX100: number('receiveTimePeakX100'),
    audioChannels: number('audioChannels'),
    audioLoadMsPerS: number('audioLoadMsPerS'),
    audioLoadPeakMsPerS: number('audioLoadPeakMsPerS'),
    audioOverloadedWindows: number('audioOverloadedWindows'),
    hostRfi: data.hostRfi === 1 || data.hostRfi === true,
  };
}

// The 'host' hint needs a session of at least this length, so that the menus and the loading at its start don't decide
// it, and an average host processing latency above this share of the time between two frames: an encoder that needs
// most of it can't absorb the slower frames of a busy scene and skips frames. A low host frame rate alone never gives
// the hint, since it is normal in static scenes, in games capped below the stream and with the minimum frame rate of
// Sunshine (minimum_fps_target).
const HOST_HINT_MIN_DURATION_MS = 120000;
const HOST_HINT_FRAME_TIME_SHARE = 0.75;

// The frame rates of a host display at 59.94 or 119.88 Hz, which a 60 or 120 FPS stream shows as a repeated frame
// about every 17 or 8 seconds. The best 30 s window of the host (hostFrameRateX100 in wasm/session_report.hpp) measures
// them to within about 0.01 FPS, while a 60 or 120 Hz display reads 60.00 or 120.00. A display at 60 or 120 Hz reads
// the same when the game is capped at the NTSC rate, or misses 2 frames (3 or 4 at 120) in every window, even the best
// one; the band can't tell these apart, so docs/GUIDE.md names them next to the hint.
const HOST_REFRESH_TOLERANCE_PER_60_FPS = 0.02;

// Whether the best window of the host ran at the NTSC rate of the stream (fps * 1000 / 1001) instead of the stream rate
function isNtscHostFrameRate(report) {
  if ((report.fps !== 60 && report.fps !== 120) || report.hostFrameRateX100 <= 0) {
    return false;
  }
  const difference = Math.abs(report.hostFrameRateX100 / 100 - report.fps * 1000 / 1001);
  // (the small addition keeps the edge of the band inside it despite the rounding of the division)
  return difference <= HOST_REFRESH_TOLERANCE_PER_60_FPS * report.fps / 60 + 1e-9;
}

// Whether the host needed most of the time between two frames to capture and encode a frame (see the constants above)
function isHostEncoderSaturated(report) {
  return report.fps > 0 && report.hostProcessingLatencyX10 > 0 && report.durationMs >= HOST_HINT_MIN_DURATION_MS &&
    report.hostProcessingLatencyX10 / 10 > HOST_HINT_FRAME_TIME_SHARE * 1000 / report.fps;
}

// The 'hostFrames' hint is for a PC that delivered clearly fewer frames than the stream asked for although its encoder
// had time and the network lost little: a game that renders fewer frames, which showed as 'No problems found' before.
// The module counts the 30 s windows of the host frame rate without the first one of a stream and without those of a
// paused host, and how many of them stayed below a share of the stream rate (HostRateWindows and kHostRateLowPercent in
// wasm/session_report.hpp; the percentage here only names that limit in the texts and must be the same). The hint
// needs a session of at least the length of the 'host' hint, at least 2 such windows and at least a fifth of all
// windows, so that a cutscene or a loading screen in a long session gives none. Its text stays neutral, since a game or
// video limited to fewer frames per second reads the same.
const HOST_LOW_RATE_PERCENT = 95;
const HOST_FRAMES_HINT_MIN_WINDOWS = 2;
const HOST_FRAMES_HINT_WINDOW_SHARE = 0.2;

// Whether the host delivered clearly fewer frames than the stream asked for in a good part of the session (see above)
function isHostShortOfFrames(report) {
  return report.fps > 0 && report.durationMs >= HOST_HINT_MIN_DURATION_MS &&
    report.hostLowWindows >= HOST_FRAMES_HINT_MIN_WINDOWS &&
    report.hostLowWindows >= HOST_FRAMES_HINT_WINDOW_SHARE * report.hostWindows;
}

// The frame rate below which a 30 s window of the host counts as low, as a text: 57 of 60 FPS, 85.5 of 90
function formatHostLowRate(fps) {
  const rate = fps * HOST_LOW_RATE_PERCENT / 100;
  return formatReportNumber(rate, rate === Math.round(rate) ? 0 : 1);
}

// Whether the sound of the stream kept its thread too busy: decoding and handing over a surround stream took more than
// the limit per second of audio in at least one window of 10 seconds, which the module counts (IsAudioOverloaded() in
// wasm/audio_load.hpp), and which is also when it tells the user during the stream ('AudioOverloadMsg: ' in
// messages.js). Only for 5.1 and 7.1, which have a lighter sound to change to; a stereo stream has none.
function isAudioThreadOverloaded(report) {
  return report.audioChannels > 2 && report.audioOverloadedWindows > 0;
}

// The hints of a report in plain language, at most 3, most important first, as keys of SESSION_REPORT_HINTS. The options
// say whether reference frame invalidation was on, which a hint about recovery keyframes suggests otherwise, but only
// for a host that offered it for the stream (hostRfi of the report: GeForce Experience, and Sunshine with its NVENC
// encoder). Every other host answers an invalidation with a keyframe, so the setting can't spare any there.
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
  if (isAudioThreadOverloaded(report)) {
    hints.push('audio');
  }
  // Many frames lost on the network make the encoder look busier than it is (keyframes after a loss), so only a stream
  // without the network hint counts; the few frames that a good network loses in a long stream change nothing. A busy
  // encoder already explains frames that the PC didn't deliver, so the hint about them only comes without it.
  if (!network && isHostEncoderSaturated(report)) {
    hints.push('host');
  } else if (!network && isHostShortOfFrames(report)) {
    hints.push('hostFrames');
  }
  if (report.recoveryKeyframes >= 3 && report.hostRfi && !opts.refFrameInvalidation && /^(HEVC|AV1)/.test(report.codec)) {
    hints.push('keyframes');
  }
  if (!network && (report.fecFailures > 0 || report.fecRecoveredBlocks / minutes >= 60)) {
    hints.push('fec');
  }
  if (report.heapTotalMb > 0 && report.heapTopMb >= report.heapTotalMb * 0.85) {
    hints.push('memory');
  }
  if (isNtscHostFrameRate(report)) {
    hints.push('hostRefresh');
  }
  return hints.length > 0 ? hints.slice(0, 3) : ['ok'];
}

// The text of a hint of getSessionReportHints(), translated, with the figures of the report that it names. The options
// say in which surround audio quality the session streamed: the hint about the sound names Efficient only for a session
// that didn't already stream in it.
function getSessionReportHintText(hint, report, options) {
  const figures = report || {};
  const opts = options || {};
  switch (hint) {
    case 'noVideo':
      return t('No video arrived from the PC in this session.');
    case 'network':
      return t('Many frames were lost on the network: use a cable or lower the bitrate.');
    case 'tv':
      return t('The TV could not keep up with the video: lower the bitrate, the resolution or the frame rate.');
    case 'audio':
      if (opts.surroundQuality === 'Efficient') {
        return t('Decoding and playing the sound took the TV up to %1$s ms per second: if the sound stuttered, set Audio configuration to Stereo.',
          formatReportNumber(figures.audioLoadPeakMsPerS || 0));
      }
      return t('Decoding and playing the sound took the TV up to %1$s ms per second: if the sound stuttered, set Surround audio quality to Efficient, or Audio configuration to Stereo.',
        formatReportNumber(figures.audioLoadPeakMsPerS || 0));
    case 'host':
      return t('The PC took %1$s ms of the %2$s ms between two frames to encode a frame, so it may have skipped frames: use a faster encoder preset on the PC, or a lower resolution or frame rate.',
        formatReportNumber((figures.hostProcessingLatencyX10 || 0) / 10, 1), formatReportNumber(figures.fps > 0 ? 1000 / figures.fps : 0, 1));
    case 'hostFrames':
      return t('The PC often sent fewer frames than the stream asked for: in %1$s of %2$s half minutes fewer than %3$s per second, %4$s at the lowest. That is normal for a game or video limited to fewer frames. Otherwise the PC could not deliver more: lower the graphics settings of the game.',
        formatReportNumber(figures.hostLowWindows || 0), formatReportNumber(figures.hostWindows || 0), formatHostLowRate(figures.fps || 0),
        formatReportNumber((figures.hostFrameRateLowX100 || 0) / 100, 1));
    case 'keyframes':
      return t('The PC often sent whole frames again after a loss: turn on Reference frame invalidation in the Advanced Settings.');
    case 'fec':
      return t('Error correction repaired many lost packets: the network is near its limit, so a cable or a lower bitrate gives more headroom.');
    case 'memory':
      return t('The memory of the app is nearly full: restart the app before the next long session.');
    case 'hostRefresh':
      return t('The PC sent %1$s instead of %2$s frames per second, which shows as a short stutter about every %3$s seconds: set the display of the PC to exactly %2$s Hz.',
        formatReportNumber((figures.hostFrameRateX100 || 0) / 100, 2), figures.fps, Math.round(1001 / (figures.fps || 60)));
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
//   Average frame receive time: 4.12 ms (25% of the frame time), highest second: 6.55 ms (39%)
//   Host frame rate (best 30 s): 60.00 FPS, average host processing latency: 5.2 ms
//   Host frame rate (lowest 30 s): 59.96 FPS, below 57 FPS in 0 of 24 half minutes
//   WASM heap at the end: 61 of 128 MB (+1 MB in this session)
//   Hint: No problems found in this session.
// The host line is left out when the host sent neither figure (e.g. a session without video). The frame receive time
// shows what the bitrate costs: the time from the first to the last packet of a frame, as the full statistics show it,
// also as a share of the time between two frames of the stream; its line is left out without a frame, and its highest
// second without a stats window that counts. The line of the lowest host frame rate is left out without a 30 s window
// that counts for it (a session of less than a minute, a paused host, or a report of 2.3.0).
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
  ];
  if (report.receiveTimeX100 > 0 && report.fps > 0) {
    // The share of the time between two frames of the stream (1000 ms / frame rate) that a time in hundredths of a
    // millisecond fills, in percent
    const share = (timeX100) => formatReportNumber(timeX100 / 100 * report.fps / 10);
    lines.push(report.receiveTimePeakX100 > 0 ?
      t('Average frame receive time: %1$s ms (%2$s% of the frame time), highest second: %3$s ms (%4$s%)',
        formatReportNumber(report.receiveTimeX100 / 100, 2), share(report.receiveTimeX100),
        formatReportNumber(report.receiveTimePeakX100 / 100, 2), share(report.receiveTimePeakX100)) :
      t('Average frame receive time: %1$s ms (%2$s% of the frame time)',
        formatReportNumber(report.receiveTimeX100 / 100, 2), share(report.receiveTimeX100)));
  }
  // A figure the host didn't give (e.g. no 30 s window in a shorter stream) is Unknown, without its unit
  if (report.hostFrameRateX100 > 0 || report.hostProcessingLatencyX10 > 0) {
    lines.push(t('Host frame rate (best 30 s): %1$s, average host processing latency: %2$s',
      report.hostFrameRateX100 > 0 ? formatReportNumber(report.hostFrameRateX100 / 100, 2) + ' FPS' : t('Unknown'),
      report.hostProcessingLatencyX10 > 0 ? formatReportNumber(report.hostProcessingLatencyX10 / 10, 1) + ' ms' : t('Unknown')));
  }
  if (report.hostWindows > 0) {
    lines.push(t('Host frame rate (lowest 30 s): %1$s FPS, below %2$s FPS in %3$s of %4$s half minutes',
      formatReportNumber(report.hostFrameRateLowX100 / 100, 2), formatHostLowRate(report.fps),
      formatReportNumber(report.hostLowWindows), formatReportNumber(report.hostWindows)));
  }
  lines.push(t('WASM heap at the end: %1$s of %2$s MB (+%3$s MB in this session)', report.heapTopMb, report.heapTotalMb, report.heapGrowthMb));
  getSessionReportHints(report, options).forEach(function(hint) {
    lines.push(t('Hint: %1$s', getSessionReportHintText(hint, report, options)));
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

// Keep the console lines of the app from now on, and the uncaught errors and unhandled promise rejections of the page
DiagnosticLog.captureConsole(typeof console !== 'undefined' ? console : null);
DiagnosticLog.captureUncaught(typeof window !== 'undefined' ? window : null);
