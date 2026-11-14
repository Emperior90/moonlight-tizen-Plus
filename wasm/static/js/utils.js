// Prefix of the Smart Hub preview images in the shared documents directory. This build can be installed next to the
// regular Moonlight app, which uses 'preview-', so its files get their own prefix (it still starts with 'preview-',
// which the box art server of the service expects)
var SMART_HUB_PREVIEW_FILE_PREFIX = 'preview-s90c-';

// The error with which NvHTTP.quitApp() fails when the host still runs the app after /cancel. A host may answer /cancel
// with success and keep running an app that another client started (GeForce Experience does), which Moonlight for PC
// reports as error 599 as well
var QUIT_APP_STILL_RUNNING_ERROR = 599;

// How long the app waits for the answer of a host to /cancel (quitting the running app) and to the download of one box
// art, in milliseconds: 30 seconds, as Moonlight for PC waits for a quit. The request queue enforces the limit
// (sendMessage('openUrl', ...) in messages.js cancels the request in the module and rejects it with -1). Without one, a
// host that accepts the connection and then sends nothing held the one HTTP thread of the module, and with it every
// request of every host, for as long as the browser waited. The requests that start a stream (/launch and /resume) have
// no limit here: the start has its own waits and retries.
var QUIT_APP_TIMEOUT_MS = 30000;
var BOX_ART_TIMEOUT_MS = 30000;

// Box art shares the one HTTP thread of the module with every other request, where it waits behind them (sendMessage()
// in messages.js). Opening a host with a cold cache asks for the box art of every app, so at most two downloads are on
// their way at once, in the order of the app list; a download that is no longer wanted (its app list was left or built
// again) is dropped before it reaches the network, and cancelBoxArtDownloads() drops them all when a stream starts.
// Ported from the fork of mmadej20 (moonlight-tizen-modern, GPL-3.0, createRequestLimiter() of f4eff8e).
var BOX_ART_MAX_DOWNLOADS = 2;
// The error of a box art download that was dropped or canceled
var BOX_ART_DOWNLOAD_DROPPED = 'BOX_ART_DOWNLOAD_DROPPED';

// A queue that runs at most maxRunning requests at once: run(start, isStale) calls start() for the request (which
// returns its promise) once a place is free, unless isStale() then says that it is no longer wanted
function createRequestLimiter(maxRunning) {
  var waiting = [];
  var running = 0;

  function pump() {
    while (running < maxRunning && waiting.length > 0) {
      var entry = waiting.shift();
      if (entry.isStale && entry.isStale()) {
        entry.reject(BOX_ART_DOWNLOAD_DROPPED);
        continue;
      }
      running++;
      var release = function(settleWith, value) {
        running--;
        settleWith(value);
        pump();
      };
      var request;
      try {
        request = Promise.resolve(entry.start());
      } catch (error) {
        request = Promise.reject(error);
      }
      request.then(release.bind(null, entry.resolve), release.bind(null, entry.reject));
    }
  }

  return {
    run: function(start, isStale) {
      return new Promise(function(resolve, reject) {
        waiting.push({ start: start, isStale: isStale, resolve: resolve, reject: reject });
        pump();
      });
    },
    // Drop the requests that wait
    dropWaiting: function() {
      waiting.splice(0).forEach(function(entry) {
        entry.reject(BOX_ART_DOWNLOAD_DROPPED);
      });
    },
  };
}

var boxArtDownloads = createRequestLimiter(BOX_ART_MAX_DOWNLOADS);

// Drop the box art downloads that wait and cancel the ones on their way, e.g. when a stream starts (showStreamMode() in
// index.js): the requests that start it would wait behind them
function cancelBoxArtDownloads() {
  boxArtDownloads.dropWaiting();
  if (typeof dropBoxArtRequests === 'function') {
    var dropped = dropBoxArtRequests(BOX_ART_DOWNLOAD_DROPPED);
    console.log('%c[utils.js, cancelBoxArtDownloads]', 'color: gray;', 'Dropped the box art downloads (' + dropped + ' in the HTTP queue).');
  }
}

// Sunshine's default box.png (src_assets/common/assets/box.png), which a host sends for an app without box art: its size
// in bytes and its SHA-256. Only a cached file of exactly this size can be it, so no other file is hashed: hashing read
// every cached box art once more on each open of the app list, on the main thread of the TV, while the user navigated.
var SUNSHINE_DEFAULT_BOX_ART_SIZE = 680;
var SUNSHINE_DEFAULT_BOX_ART_HASH = 'd9164ebd069b5f735eb8efc557801778498da37f572ef70e3d35604739e6c613';

// The box art of the app grid goes to its images as object URLs of its Blob (URL.createObjectURL()) instead of data
// URLs: FileReader built a data URL of a few hundred KB for each box art, and every image that took it parsed and
// base64-decoded it on the main thread, also the poster of the hero on every step of the focus (launcher.js). The
// Blob of each object URL stays here until the grid that showed it is built again (releaseBoxArtUrl()), so that a TV
// whose images refuse an object URL can still get a data URL of it (boxArtDataUrl()).
var boxArtObjectUrls = {};

// Read a Blob as a data URL, or resolve null when it can't be read
function readBlobAsDataUrl(blob) {
  return new Promise(function(resolve) {
    try {
      var reader = new FileReader();
      reader.onloadend = function() {
        resolve(typeof reader.result === 'string' ? reader.result : null);
      };
      reader.readAsDataURL(blob);
    } catch (error) {
      resolve(null);
    }
  });
}

// Read a Blob as bytes (a Uint8Array), or resolve null when it can't be read
function readBlobAsBytes(blob) {
  return new Promise(function(resolve) {
    try {
      var reader = new FileReader();
      reader.onloadend = function() {
        resolve(reader.result ? new Uint8Array(reader.result) : null);
      };
      reader.readAsArrayBuffer(blob);
    } catch (error) {
      resolve(null);
    }
  });
}

// The bytes (a Uint8Array) of the Base64 payload of a data URL
function dataUrlToBytes(dataUrl) {
  var binaryStr = atob(String(dataUrl).split(',')[1] || '');
  var bytes = new Uint8Array(binaryStr.length);
  for (var i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

// The URL of a box art Blob for an image: an object URL, or a data URL where the browser has no object URLs
function makeBoxArtUrl(blob) {
  if (typeof URL !== 'undefined' && URL && typeof URL.createObjectURL === 'function') {
    try {
      var url = URL.createObjectURL(blob);
      boxArtObjectUrls[url] = blob;
      return Promise.resolve(url);
    } catch (error) {
      console.warn('%c[utils.js, makeBoxArtUrl]', 'color: gray;', 'Warning: Cannot make an object URL of the box art, using a data URL: ' + error);
    }
  }
  return readBlobAsDataUrl(blob);
}

// Free the object URL of box art once no image shows it any more (the app grid is built again); other URLs stay
function releaseBoxArtUrl(url) {
  if (typeof url === 'string' && Object.prototype.hasOwnProperty.call(boxArtObjectUrls, url)) {
    delete boxArtObjectUrls[url];
    try {
      URL.revokeObjectURL(url);
    } catch (error) {
      // An object URL that is already gone needs nothing
    }
  }
}

// The Blob of box art behind an object URL of makeBoxArtUrl() (e.g. for the colours of the ambient light, launcher.js),
// or null for any other URL
function boxArtBlob(url) {
  return typeof url === 'string' && Object.prototype.hasOwnProperty.call(boxArtObjectUrls, url) ? boxArtObjectUrls[url] : null;
}

// The data URL of the box art behind an object URL of makeBoxArtUrl(), for an image that refused the object URL, or
// null for any other URL
function boxArtDataUrl(url) {
  var blob = boxArtBlob(url);
  return blob ? readBlobAsDataUrl(blob) : Promise.resolve(null);
}

// The Smart Hub preview images (generatePreviewImage()) are made one at a time, each once the TV is idle (at the latest
// after PREVIEW_IDLE_TIMEOUT_MS), and none during a stream. Each one decodes a box art and encodes it as a JPEG: all of
// them started at once when the box art arrived, as long tasks on the main thread that held up every key press on the
// app list for seconds. They only serve the tiles of Smart Hub, which the service reads later (updatePreviewData() in
// index.js), so nothing waits for them on the screen. A preview of an app list that was left (isStale()) is skipped:
// the next app list makes the previews that are still missing.
var PREVIEW_IDLE_TIMEOUT_MS = 2000;
// How often a preview that waits for the end of a stream looks again, in milliseconds
var PREVIEW_STREAM_RETRY_MS = 3000;
var previewImageJobs = [];
var previewImageBusy = false;
// Whether a preview image could not be saved (a TV that refuses the documents directory): no more are made until the app
// starts again, since each open of an app list would make every preview again only to fail to save it
var previewImageSaveFailed = false;
// The canvas that the previews are drawn on, one at a time (generatePreviewImage()), or null while one is drawn on it: a
// new canvas of the size of the box art for each preview left its pixels to the garbage collector of the TV
var previewCanvas = null;

// Run a function once the main thread is idle, at the latest after timeout milliseconds
function runWhenIdle(callback, timeout) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(callback, { timeout: timeout });
  } else {
    setTimeout(callback, 50);
  }
}

// Queue a job that makes a preview image (make() returns a promise); resolves once it ran or was skipped
function queuePreviewImage(make, isStale) {
  return new Promise(function(resolve) {
    previewImageJobs.push({ make: make, isStale: isStale, resolve: resolve });
    runNextPreviewImage();
  });
}

function runNextPreviewImage() {
  if (previewImageBusy || previewImageJobs.length === 0) {
    return;
  }
  previewImageBusy = true;
  runWhenIdle(function() {
    // A stream needs the main thread for its audio and video: the previews wait for the menus
    if (typeof isInGame !== 'undefined' && isInGame === true) {
      previewImageBusy = false;
      setTimeout(runNextPreviewImage, PREVIEW_STREAM_RETRY_MS);
      return;
    }
    var job = previewImageJobs.shift();
    var done = function(value) {
      previewImageBusy = false;
      job.resolve(value);
      runNextPreviewImage();
    };
    if ((job.isStale && job.isStale()) || previewImageSaveFailed) {
      done(false);
      return;
    }
    var result;
    try {
      result = Promise.resolve(job.make());
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(done, function(error) {
      console.warn('%c[utils.js, runNextPreviewImage]', 'color: gray;', 'Warning: Failed to make a Smart Hub Preview box art: ' + error);
      done(false);
    });
  }, PREVIEW_IDLE_TIMEOUT_MS);
}

// The major version of a host from the appversion of its server info, e.g. 7 for Sunshine's '7.1.431.-1', which
// gs_pair() of libgamestream/pairing.c takes to choose the hash of the pairing (SHA-256 from 7 on, SHA-1 before). The
// number goes up to the first dot, so a host that reports '10.0.1' gives 10; reading only the first character, as up to
// 2.3.0, would give 1 and pair with SHA-1, so the pairing with such a host, which like every host from version 7 on
// expects SHA-256, would fail. Hosts report 7.x today. Gives NaN for an appversion without a number, as before.
function parseServerMajorVersion(appVersion) {
  return parseInt(String(appVersion).split('.')[0], 10);
}

// Safely wraps IPv6 addresses in brackets for URL construction.
// IPv4 addresses and DNS hostnames do not contain colons, so they are untouched.
function formatAddressForUrl(address) {
  if (address && address.indexOf(':') !== -1 && address.indexOf('[') === -1) {
    return '[' + address + ']';
  }
  return address;
}

/**
 * Checks if a MAC address is locally administered (likely randomized).
 * Per IEEE 802, the second-least-significant bit (U/L bit) of the first octet
 * indicates a locally administered address when set to 1.
 * This means the second hex character of the MAC is one of: 2, 6, A, E.
 */
function isRandomMacAddress(macAddress) {
  if (!macAddress || macAddress === '00:00:00:00:00:00') {
    console.error('%c[utils.js, refreshServerInfo]', 'color: gray;', 'Error: Invalid MAC address: empty or all zeros');
    return false;
  }
  var firstOctet = parseInt(macAddress.split(':')[0], 16);
  if (isNaN(firstOctet)) {
    console.error('%c[utils.js, refreshServerInfo]', 'color: gray;', 'Error: Invalid MAC address format: ' + macAddress);
    return false;
  }
  // Check the U/L bit (bit 1) — if set, address is locally administered
  return (firstOctet & 0x02) !== 0;
}

// The broadcast address of the subnet of the TV, e.g. '192.168.1.255' for the address 192.168.1.20 with the mask
// 255.255.255.0, which the magic packet of Wake-on-LAN goes to besides 255.255.255.255 (wasm/wake_on_lan.hpp). Empty
// when the TV doesn't tell its address and mask (webapis.network), the mask isn't one of a subnet, or the subnet has
// no broadcast address (/31 and /32). Ported from the fork of samirmartins (moonlight-tizen, getWakeBroadcastAddress()
// of 97bfe5c), which reads the subnet of the TV instead of guessing a /24 from the address of the PC.
function getSubnetBroadcastAddress() {
  var parse = function(text) {
    var parts = String(text).split('.');
    if (parts.length !== 4 || !parts.every(function(part) { return /^\d{1,3}$/.test(part) && Number(part) <= 255; })) {
      return null;
    }
    return parts.reduce(function(value, part) { return ((value << 8) | Number(part)) >>> 0; }, 0);
  };
  try {
    var address = parse(webapis.network.getIp());
    var mask = parse(webapis.network.getSubnetMask());
    if (address === null || mask === null || address === 0) {
      return '';
    }
    var hostBits = (~mask) >>> 0;
    // The mask must be ones followed by zeros, with at least 2 host bits
    if ((hostBits & (hostBits + 1)) !== 0 || hostBits < 3) {
      return '';
    }
    var broadcast = (address | hostBits) >>> 0;
    return [24, 16, 8, 0].map(function(shift) { return (broadcast >>> shift) & 255; }).join('.');
  } catch (e) {
    console.warn('%c[utils.js, getSubnetBroadcastAddress]', 'color: gray;', 'Warning: The address of the TV is unknown, Wake-on-LAN leaves out the broadcast address of its subnet:', e);
    return '';
  }
}

// The random IDs and the pairing PIN come from the cryptographic random generator of the browser (cryptoRand()) instead
// of Math.random(), whose output can be predicted from earlier values. A unique ID that an install already stored stays
// as it is (loadHTTPCertsCb() in wasm/platform/index.js only creates one when none is stored)
function guuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = cryptoRand(16),
      v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function uniqueid() {
  return 'xxxxxxxxxxxxxxxx'.replace(/[x]/g, function(c) {
    var r = cryptoRand(16);
    return r.toString(16);
  });
}

// The 4-digit PIN that the user enters on the host while pairing, with leading zeros (0000 to 9999)
function generatePairingPin() {
  return String('0000' + cryptoRand(10000)).slice(-4);
}

function generateRemoteInputKey() {
  var array = new Uint8Array(16);
  window.crypto.getRandomValues(array);
  return Array.from(array, function(byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2);
  }).join('');
}

function generateRemoteInputKeyId() {
  // Value must be signed 32-bit int for correct behavior
  var array = new Int32Array(1);
  window.crypto.getRandomValues(array);
  return array[0];
}

// Based on OpenBSD arc4random_uniform()
function cryptoRand(upper_bound) {
  var min = (Math.pow(2, 32) - upper_bound) % upper_bound;
  var array = new Uint32Array(1);

  do {
    window.crypto.getRandomValues(array);
  } while (array[0] < min);

  return array[0] % upper_bound;
}

// This map tracks the gamepad ID of each browser slot that reported a
// positive timestamp, to avoid false positives from the placeholder
// gamepads that Tizen reports as "connected" with a timestamp of 0. Since
// Tizen 5.5 reports a timestamp of 0 for real controllers too, a slot also
// counts by its input (Controller.isRealGamepad() in gamepad.js).
var _realGamepads = new Map();

// Returns a bitmask representing the connected gamepads in the browser
function getConnectedGamepadMask() {
  var count = 0;
  var mask = 0;
  var gamepads = navigator.getGamepads ? navigator.getGamepads() : [];

  // Iterate through all possible gamepad slots (0-15) to detect connected gamepads
  // Maximum number of controllers supported by the Moonlight protocol is 16
  for (var i = 0; i < 16; i++) {
    var gamepad = gamepads[i];

    // A controller that reports a timestamp of 0 (Tizen 5.5) counts once its input changed, by the evidence that
    // Controller.isRealGamepad() (gamepad.js) gathers while the menus poll, with the rule of PollGamepads() in
    // gamepad.cpp (as upstream fdf4fbe). It is asked for every slot, so an empty one forgets its evidence. Without
    // gamepad.js (as in some unit tests) only a positive timestamp counts. So the mask counts what the menus counted,
    // plus a slot whose id showed a positive timestamp before, which _realGamepads keeps (as in 2.2.0).
    // The stream gathers its own evidence and announces such a controller with its first input in the stream; the PC
    // doesn't create controllers from this mask (Sunshine only passes it to the app as SUNSHINE_CLIENT_GCMAP).
    var validated = typeof Controller !== 'undefined' && Controller.isRealGamepad(gamepad, i);

    // Ignore empty or disconnected gamepads and clear any previous tracking for that slot
    if (!gamepad || !gamepad.connected) {
      _realGamepads.delete(i);
      continue;
    }

    // Check if the gamepad slot is occupied
    if (gamepad) {
      // See the matching rule of Controller.isRealGamepad() in gamepad.js and PollGamepads() in gamepad.cpp
      // (tests/fixtures/gamepad-evidence.tsv) – these must stay in sync!

      // If the gamepad ID changed, treat it as a new one in this slot
      if (_realGamepads.get(i) !== gamepad.id) {
        _realGamepads.delete(i);
      }

      // Remember any pad that has ever reported a positive timestamp
      if (typeof gamepad.timestamp === 'number' && isFinite(gamepad.timestamp) && gamepad.timestamp > 0) {
        _realGamepads.set(i, gamepad.id);
      }

      // Tizen often returns "connected" placeholder gamepads whose timestamp stays
      // at zero. Ignore them until they become real gamepads that report input.
      if (!_realGamepads.has(i) && !validated) {
        continue;
      }

      // Use the physical browser index so the mask matches C++
      mask |= 1 << i;
      count++;
    }
  }

  console.log('%c[utils.js, getConnectedGamepadMask]', 'color: gray;', 'Detected: ' + count + ' ' + (count === 1 ? 'gamepad' : 'gamepads'));
  return mask;
}

String.prototype.toHex = function() {
  var hex = '';
  for (var i = 0; i < this.length; i++) {
    hex += '' + this.charCodeAt(i).toString(16);
  }
  return hex;
}

// Whether a unique ID of a host is one that the app takes: 1 to 64 letters, digits, dashes and underscores, and not the
// name of a property that every object has (constructor, toString, __proto__ and so on). GeForce Experience, Sunshine
// and Apollo send hexadecimal digits, Sunshine and Apollo as a UUID with dashes.
// The ID comes from the server info of any device that answers on the local network, unpaired and over plain HTTP,
// and the app uses it as a key of plain objects (the hosts, their polls, the Smart Hub tiles) and in the element IDs of
// the PC list. '__proto__' made the scan of the network write the addresses of the device into Object.prototype,
// after which every loop over the hosts found them and the PC list was broken until the app restarted, 'constructor'
// was taken for a known host, and an ID such as 'x,#main-content' matched other parts of the page as a selector.
var SERVER_UID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
function isValidServerUid(serverUid) {
  return typeof serverUid === 'string' && SERVER_UID_PATTERN.test(serverUid) && !(serverUid in Object.prototype);
}

// The rules for the other fields of a server info, which like the unique ID come from whatever device answered, for a
// host that isn't paired over plain HTTP, and which the app stores with the host. Up to 2.3.0 they were kept as they
// came: an address such as 'evil.example/x?' became part of the URL of the next poll, a missing HTTPS port stood as NaN
// in every HTTPS URL of the host, and the texts and the display modes had no limit. A value that breaks its rule is
// left out or cut, as the rule says; the host itself is never dropped for it.

// The ports that a host uses when its server info names none (GeForce Experience, and Sunshine by default)
var DEFAULT_HTTP_PORT = 47989;
var DEFAULT_HTTPS_PORT = 47984;

// The four numbers of an IPv4 address such as '192.168.1.20', or null. Other spellings that a URL reads as an IPv4
// address ('127.1', '2130706433', '0x7f.0.0.1') are no address here.
function parseIpv4Address(text) {
  var match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(typeof text === 'string' ? text : '');
  if (!match) {
    return null;
  }
  var parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  return parts.every(function(part) { return part <= 255; }) ? parts : null;
}

// The eight groups of an IPv6 address such as 'fe80::1c2d:3eff:fe4f:5a6b' as numbers, or null: groups of up to four
// hexadecimal digits, at most one '::', and optionally an IPv4 address as the last two groups ('::ffff:192.168.1.20').
// Without brackets, which formatAddressForUrl() adds, and without a zone ('%eth0'), which only means something on the
// machine that names it.
function parseIpv6Address(text) {
  if (typeof text !== 'string' || text.length > 45 || text.indexOf(':') < 0 || !/^[0-9A-Fa-f:.]+$/.test(text)) {
    return null;
  }
  var halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  var readGroups = function(part, mayEndWithIpv4) {
    var groups = [];
    var pieces = part === '' ? [] : part.split(':');
    for (var i = 0; i < pieces.length; i++) {
      if (mayEndWithIpv4 && i === pieces.length - 1 && pieces[i].indexOf('.') >= 0) {
        var ipv4 = parseIpv4Address(pieces[i]);
        if (!ipv4) {
          return null;
        }
        groups.push(ipv4[0] * 256 + ipv4[1], ipv4[2] * 256 + ipv4[3]);
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(pieces[i])) {
        groups.push(parseInt(pieces[i], 16));
      } else {
        return null;
      }
    }
    return groups;
  };
  var head = readGroups(halves[0], halves.length === 1);
  var tail = halves.length === 2 ? readGroups(halves[1], true) : [];
  if (!head || !tail) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  var missing = 8 - head.length - tail.length;
  if (missing < 1) {
    return null;
  }
  for (var j = 0; j < missing; j++) {
    head.push(0);
  }
  return head.concat(tail);
}

// Whether a text is a DNS name such as 'gaming-pc.lan': labels of letters, digits, hyphens and underscores with dots
// between them, at most 253 characters. A name whose last label is a number ('127.1', '2130706433', '0x7f000001') is
// none: a URL reads it as an IPv4 address, e.g. as the TV itself.
function isDnsName(text) {
  if (typeof text !== 'string' || text.length > 253 || !/^[A-Za-z0-9_-]{1,63}(\.[A-Za-z0-9_-]{1,63})*$/.test(text)) {
    return false;
  }
  return !/^(\d+|0[xX][0-9A-Fa-f]*)$/.test(text.slice(text.lastIndexOf('.') + 1));
}

// Whether a text is an address that the app asks for a server info: an IPv4 address, an IPv6 address or a DNS name,
// and so nothing that changes the URL it becomes a part of (a slash, a question mark, an '@', a port, a space). Every
// address that the Add PC dialog takes (isValidHostAddress() in index.js) is one, except a name that ends in a number
// or is longer than a DNS name can be.
function isServerAddress(text) {
  return parseIpv4Address(text) !== null || parseIpv6Address(text) !== null || isDnsName(text);
}

// Whether an address is the TV itself, which a host must not send the app to: 127.x.x.x, 0.0.0.0, the IPv6 loopback
// and unspecified addresses in every spelling ('::1', '0:0:0:0:0:0:0:1', '::'), both as an IPv4 address inside an IPv6
// one ('::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1'), and the name localhost
function isOwnMachineAddress(text) {
  var isOwnIpv4 = function(parts) {
    return parts[0] === 127 || parts.every(function(part) { return part === 0; });
  };
  var ipv4 = parseIpv4Address(text);
  if (ipv4) {
    return isOwnIpv4(ipv4);
  }
  var groups = parseIpv6Address(text);
  if (groups) {
    var leadingZeros = 0;
    while (leadingZeros < 8 && groups[leadingZeros] === 0) {
      leadingZeros++;
    }
    if (leadingZeros === 8 || (leadingZeros === 7 && groups[7] === 1)) {
      return true;
    }
    // An IPv4 address in the last two groups: IPv4-mapped (::ffff:a.b.c.d) or the older IPv4-compatible form (::a.b.c.d)
    if (leadingZeros >= 6 || (leadingZeros === 5 && groups[5] === 0xffff)) {
      return isOwnIpv4([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255]);
    }
    return false;
  }
  return typeof text === 'string' && /^(.*\.)?localhost$/i.test(text);
}

// The name that a host may answer to with mDNS, e.g. 'GAMING-PC.local' for the host GAMING-PC, or '' for a host whose
// name is no DNS name (a name with a space or another character, or an address)
function getLocalNameCandidate(hostname) {
  if (!isDnsName(hostname)) {
    return '';
  }
  return /\.local$/i.test(hostname) ? hostname : hostname + '.local';
}

// The addresses that a poll of a host tries, in their order and each one once: the address that worked the last time,
// the mDNS name, the local and the external address from the server info, and the address that the user entered. Left
// out are the ones that are no address (isServerAddress()) and the TV itself (isOwnMachineAddress()).
function getServerAddressCandidates(host) {
  var candidates = [];
  [host.address, getLocalNameCandidate(host.hostname), host.localAddress, host.externalIP, host.userEnteredAddress].forEach(function(address) {
    if (address && candidates.indexOf(address) < 0 && isServerAddress(address) && !isOwnMachineAddress(address)) {
      candidates.push(address);
    }
  });
  return candidates;
}

// Whether a value is a port number: a whole number from 1 to 65535
function isPortNumber(value) {
  return typeof value === 'number' && value % 1 === 0 && value >= 1 && value <= 65535;
}

// The port that a text of a server info names ('47984'), or 0 when it is missing or no whole number from 1 to 65535
function parsePort(text) {
  var trimmed = String(text === undefined || text === null ? '' : text).trim();
  if (!/^\d{1,5}$/.test(trimmed)) {
    return 0;
  }
  var port = Number(trimmed);
  return isPortNumber(port) ? port : 0;
}

// Whether a text is a MAC address as the hosts send it and Wake-on-LAN reads it (ParseMacAddress() in
// wasm/wake_on_lan.hpp): six pairs of hexadecimal digits with colons between them
function isMacAddress(text) {
  return typeof text === 'string' && /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(text);
}

// The longest name, version, GPU name and state that the app keeps of a server info. The names of real hosts are far
// shorter: a Windows computer name has up to 15 characters, a DNS label up to 63; the states are e.g.
// 'SUNSHINE_SERVER_BUSY' and the versions '7.1.431.-1'.
var SERVER_NAME_MAX_LENGTH = 64;
var SERVER_TEXT_MAX_LENGTH = 64;
var SERVER_VERSION_MAX_LENGTH = 32;

// A text of a server info as the app keeps it: without control characters (line breaks, tabs, and the characters that
// turn the reading direction of the text around them), which become spaces, without spaces around it, and cut to
// maxLength characters. Any other character stays: the name of a host is chosen by its user.
function cleanServerText(text, maxLength) {
  var cleaned = String(text === undefined || text === null ? '' : text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').trim();
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength);
    // Not half of a character that takes two units
    if (/[\ud800-\udbff]$/.test(cleaned)) {
      cleaned = cleaned.slice(0, -1);
    }
    cleaned = cleaned.trim();
  }
  return cleaned;
}

// The limits of the display modes that the app keeps of one server info: how many <DisplayMode> entries it reads, how
// many resolutions and refresh rates per resolution it keeps, and the largest width, height and refresh rate. A host
// lists a few dozen modes, e.g. Sunshine every resolution of its configuration at every frame rate.
var DISPLAY_MODE_MAX_ENTRIES = 1024;
var DISPLAY_MODE_MAX_RESOLUTIONS = 128;
var DISPLAY_MODE_MAX_RATES = 32;
var DISPLAY_MODE_MAX_SIZE = 32767;
var DISPLAY_MODE_MAX_RATE = 1000;

// The whole part of a positive number in a text of a server info ('1080', '59.94'), or 0 for anything else and for a
// number above max
function parsePositiveNumber(text, max) {
  var match = /^(\d{1,6})(\.\d{1,6})?$/.exec(String(text === undefined || text === null ? '' : text).trim());
  var value = match ? Number(match[1]) : 0;
  return value >= 1 && value <= max ? value : 0;
}

// The display modes of one server info, as { 'height:width': [refresh rates] }, from its entries
// [{ width, height, refreshRate }] as texts. An entry with a value that is no positive number within the limits above
// is left out, as are the entries, resolutions and refresh rates beyond the limits.
function parseDisplayModes(entries) {
  var modes = {};
  var resolutions = 0;
  (entries || []).slice(0, DISPLAY_MODE_MAX_ENTRIES).forEach(function(entry) {
    var width = parsePositiveNumber(entry.width, DISPLAY_MODE_MAX_SIZE);
    var height = parsePositiveNumber(entry.height, DISPLAY_MODE_MAX_SIZE);
    var refreshRate = parsePositiveNumber(entry.refreshRate, DISPLAY_MODE_MAX_RATE);
    if (!width || !height || !refreshRate) {
      return;
    }
    var key = height + ':' + width;
    if (!Object.prototype.hasOwnProperty.call(modes, key)) {
      if (resolutions >= DISPLAY_MODE_MAX_RESOLUTIONS) {
        return;
      }
      modes[key] = [];
      resolutions++;
    }
    if (modes[key].length < DISPLAY_MODE_MAX_RATES && modes[key].indexOf(refreshRate) < 0) {
      modes[key].push(refreshRate);
    }
  });
  return modes;
}

// The URL that _openUrlWithTimeout() asks first, to see whether anything answers at the address of a request: for an
// HTTPS request to the HTTPS port of the host, the server info of the same host over plain HTTP, which answers 200
// without a certificate; any other URL as it is. The port is the one right after the host of an https:// URL, so that
// neither a part of an IPv6 address nor the HTTP port is taken for it.
function getPreflightUrl(url, httpsPort, httpPort) {
  var match = /^https:\/\/(\[[0-9A-Fa-f:.]+\]|[^\/?#:@\[\]]+):(\d{1,5})(?=[\/?#]|$)/.exec(String(url));
  if (!match || !isPortNumber(httpsPort) || !isPortNumber(httpPort) || Number(match[2]) !== httpsPort) {
    return url;
  }
  return 'http://' + match[1] + ':' + httpPort + '/serverinfo';
}

// One app of an app list, { id, title } and its UUID where the host names one, from its <App> element. Null for an
// entry without an <ID> that is a whole number or without an <AppTitle>, which getAppListWithCacheFlush() leaves out:
// the ID names the box art files of the app and is what a start asks the host for.
function parseAppListEntry(appElement) {
  var idElement = appElement.getElementsByTagName('ID')[0];
  var titleElement = appElement.getElementsByTagName('AppTitle')[0];
  var id = idElement ? parseInt(String(idElement.textContent).trim(), 10) : NaN;
  if (!titleElement || !Number.isSafeInteger(id)) {
    return null;
  }
  var app = { id: id, title: String(titleElement.textContent).trim() };
  // Apollo and Vibepollo also name each app by a UUID, which marks their control tiles (isHostTerminateTile() in
  // index.js)
  var uuidElement = appElement.getElementsByTagName('UUID')[0];
  if (uuidElement && String(uuidElement.textContent).trim()) {
    app.uuid = String(uuidElement.textContent).trim();
  }
  return app;
}

// The name of the directory in the private storage of the app that holds the box art of a host. It is made of the
// name of the host, which the host chooses: letters and digits of every script, spaces, '_', '-' and '.' stay, every
// other character (a slash, a backslash, a colon, a control character) becomes '_', and at most 64 characters are
// kept. A name that leaves nothing but dots and spaces ('', '.', '..') gives a name made of the unique ID of the host
// instead, so the directory is always one directory right below wgt-private and never that directory or one above it,
// whatever the file system of the TV makes of '..'. The name of an ordinary host stays as it is, and with it the box
// art that an earlier version cached.
function getBoxArtDirName(hostname, serverUid) {
  var name = String(hostname === undefined || hostname === null ? '' : hostname).replace(/[^\p{L}\p{M}\p{N} _.-]/gu, '_').slice(0, 64);
  // Not half of a character that takes two units
  name = name.replace(/[\ud800-\udbff]$/, '');
  if (/^[. ]*$/.test(name)) {
    return 'host-' + (isValidServerUid(serverUid) ? serverUid : 'unknown');
  }
  return name;
}

function NvHTTP(address, clientUid, userEnteredAddress = '', macAddress) {
  // Constructor start
  this.hostname = address;
  this.address = address;
  this.userEnteredAddress = userEnteredAddress; // if the user entered an address, we keep it on hand to try when polling
  this.localAddress = '';
  this.externalIP = '';
  this.macAddress = macAddress;
  this.httpsPort = 0;
  this.httpPort = 0;
  this.externalPort = 0;
  this.clientUid = clientUid;
  this.serverUid = '';
  this.ppkstr = null;
  this._pollCount = 0;
  this._consecutivePollFailures = 0;
  this._pollCompletionCallbacks = [];
  this.paired = false;
  this.online = false;
  this.numofapps = 0;
  this.currentGame = 0;
  this.appVersion = '';
  this.gfeVersion = '';
  this.serverMajorVersion = 0;
  this.serverState = '';
  this.isNvidiaServerSoftware = false;
  this.gputype = '';
  this.supportedDisplayModes = {}; // key: y-resolution:x-resolution, value: array of supported frame rates
  this.autoWolEnabled = false; // Per-host Auto Wake-on-LAN setting

  _self = this;
  console.log('%c[utils.js, NvHTTP]', 'color: gray;', 'NvHTTP Object: \n' + this);
};

function _arrayBufferToBase64(buffer) {
  var binary = '';
  var bytes = new Uint8Array(buffer);
  var len = bytes.byteLength;

  for (var i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return window.btoa(binary);
}

function _base64ToArrayBuffer(base64) {
  var binary_string = window.atob(base64);
  var len = binary_string.length;
  var bytes = new Uint8Array(len);

  for (var i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }

  return bytes.buffer;
}

NvHTTP.prototype = {
  getUid: function() {
    return this.isNvidiaServerSoftware ? '0123456789ABCDEF' : this.clientUid;
  },

  _openUrlWithTimeout: function(url, ppkstr) {
    // Pre-flight check using native JS fetch to prevent dead IPs (like unreachable external IPs 
    // or unresolvable .local addresses) from permanently freezing the single-threaded C++ WASM network stack.
    var abortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutId = setTimeout(function() {
      if (abortCtrl) abortCtrl.abort();
    }, 3000); // 3s max wait to see if the IP is a black hole

    // Use HTTP /serverinfo for the preflight to guarantee a 200 OK response and eliminate ALL console spam (like 404s).
    // We only rewrite the URL if it targets the Sunshine HTTPS port, preserving this function for generic use
    // (getPreflightUrl()).
    var preflightUrl = getPreflightUrl(url, this.httpsPort, this.httpPort);

    return fetch(preflightUrl, abortCtrl ? { signal: abortCtrl.signal } : {})
      .then(function(res) {
        clearTimeout(timeoutId);
        // The IP is alive and responded! Hand it over to C++
        return sendMessage('openUrl', [url, ppkstr, false, 5000]).catch(error => {
          throw error;
        });
      })
      .catch(function(e) {
        clearTimeout(timeoutId);
        // If the fetch was forcefully aborted by our timeout, it means the IP is a black hole (silent drop).
        // We MUST skip it, otherwise handing it to C++ will irrevocably freeze the WASM thread for 120 seconds!
        if (e && e.name === 'AbortError') {
          console.warn('%c[utils.js, _openUrlWithTimeout]', 'color: orange;', 'Skipping dead/hanging URL to prevent C++ WASM freeze: ' + url);
          return Promise.reject(-1); // Instantly fail (GS_FAILED), don't pass to C++!
        } else {
          // Any other error (e.g. Cert Error, Connection Refused, CORS) means the IP actively responded quickly.
          // C++ will also fail quickly without hanging (or succeed if mTLS), so it's safe to hand it over.
          return sendMessage('openUrl', [url, ppkstr, false, 5000]).catch(error => {
            throw error;
          });
        }
      });
  },

  // Refreshes the server info using the base URL. This is useful for testing whether we can successfully ping a host at the base URL
  refreshServerInfo: function() {
    return this.refreshServerInfoAtAddress(this.address);
  },

  // Refreshes the server info using a given address. This is useful for testing whether we can successfully ping a host at a given address
  refreshServerInfoAtAddress: function(givenAddress) {
    // The address becomes a part of the URL, so only an IPv4 address, an IPv6 address or a DNS name is asked
    // (isServerAddress()): an address that 2.3.0 stored from a server info could send the request to another host and
    // path, e.g. 'evil.example/x?'
    if (!isServerAddress(givenAddress)) {
      return Promise.reject('Not asking ' + JSON.stringify(String(givenAddress).slice(0, 40)) + ' for a server info, which is no address');
    }
    var urlAddr = formatAddressForUrl(givenAddress);
    // Unpaired hosts have no established certificate trust, so HTTP is allowed.
    if (this.ppkstr == null) { // No pinned cert
      // Use HTTP if we have no pinned cert
      return this._openUrlWithTimeout('http://' + urlAddr + ':' + this.httpPort + '/serverinfo?' + this._buildUidStr(), this.ppkstr).then(function(retHttp) {
        var parsed = this._parseServerInfo(retHttp);
        if (!parsed) { // If that fails
          return Promise.reject("Failed to parse server info from HTTP");
        }
        return parsed;
      }.bind(this));
    }
    // Paired hosts must use HTTPS with the pinned certificate. Do not fall back to unauthenticated HTTP for server metadata.
    return this._openUrlWithTimeout('https://' + urlAddr + ':' + this.httpsPort + '/serverinfo?' + this._buildUidStr(), this.ppkstr).then(function(ret) {
      var parsed = this._parseServerInfo(ret);
      if (!parsed) { // If that fails
        console.warn('%c[utils.js, refreshServerInfoAtAddress]', 'color: gray;', 'Warning: Failed to parse server info from HTTPS. Please verify the host is reachable and re-pair the host if necessary!');
        return Promise.reject("Failed to parse server info from HTTPS");
      }
      return parsed;
    }.bind(this), function(error) {
      if (error == -100) { // GS_CERT_MISMATCH
        // Do not fall back to HTTP after a certificate mismatch. The endpoint must be re-paired before unauthenticated server metadata can be accepted.
        console.error('%c[utils.js, refreshServerInfoAtAddress]', 'color: gray;', 'Error: Certificate mismatch. Please re-pair the host!', this);
      }
      return Promise.reject(error);
    }.bind(this));
  },

  // Called every few seconds to poll the server for updated info
  pollServer: function(onComplete) {
    // Pend this callback on completion
    this._pollCompletionCallbacks.push(onComplete);

    // Check if a poll was already in progress
    if (this._pollCompletionCallbacks.length > 1) {
      // Don't start another, because the one in progress will alert our caller too
      return;
    }

    // Check if a stream session is already in progress
    if (isInGame === true) {
      // Drain callbacks to avoid permanently blocking the deduplication guard, so the caller isn't left hanging
      this._completePoll();
      // Do not initiate any server polls while a streaming session is already in progress
      return;
    }

    this.selectServerAddress(function(successfulAddress) {
      // Successfully determined server address. Update base URL
      var urlAddr = formatAddressForUrl(successfulAddress);
      this.address = successfulAddress;
      this._baseUrlHttps = 'https://' + urlAddr + ':' + this.httpsPort;
      this._baseUrlHttp = 'http://' + urlAddr + ':' + this.httpPort;

      // Poll for updated mac address only on first successful server info poll, and only for a host with a pinned
      // key, whose server info came over HTTPS from the PC itself. The scan of the network polls each device that
      // answers as a new host, over plain HTTP: one that answered with the unique ID of a stored PC and PairStatus 1
      // had its MAC address written into that PC, which Wake-on-LAN then used.
      if (this.paired && this.ppkstr && this._pollCount === 0) {
        updateMacAddress(this);
      }

      // Poll for the app list every 10 successful server info polls
      // Not including the first one to avoid PCs taking a while to show as online initially
      if (this.paired && this._pollCount++ % 10 === 1) {
        this.getAppListWithCacheFlush();
      }

      this._consecutivePollFailures = 0;
      this.online = true;

      // Call all pending completion callbacks
      this._completePoll();
    }.bind(this), function() {
      // Set host to offline and clear the app list cache
      if (++this._consecutivePollFailures >= 2) {
        this.online = false;
        this._memCachedApplist = null;
      }

      // Call all pending completion callbacks
      this._completePoll();
    }.bind(this));
  },

  // Call the callbacks that wait for the poll that just ended, in the order they came, each on its own: one that
  // throws neither keeps the others from the result nor stays in the list, where it kept every later poll from starting
  // (the check at the start of pollServer()). The list is taken first, so that a callback can start the next poll.
  // Before, beginBackgroundPollingOfHost() in index.js emptied the list to recover from such a stuck poll, which also
  // threw away the callback of a poll still running, e.g. the one of the Wake PC dialog that waited for the host.
  _completePoll: function() {
    var completions = this._pollCompletionCallbacks;
    this._pollCompletionCallbacks = [];
    completions.forEach(function(completion) {
      try {
        completion(this);
      } catch (e) {
        console.error('%c[utils.js, pollServer]', 'color: gray;', 'Error: A callback of the poll of ' + this.hostname + ' failed:', e);
      }
    }, this);
  },

  // Initially pings the server to try and figure out if it's routable by any means
  selectServerAddress: function(onSuccess, onFailure) {
    // Build a deduplicated, validated list of candidate addresses to try in order: the address, the name with
    // '.local', the local and the external address of the server info and the address that the user entered. An
    // address of the TV itself (127.0.0.1, ::1, etc.) isn't routable from the client, and a text that is no address
    // isn't asked (getServerAddressCandidates()).
    var candidates = getServerAddressCandidates(this);

    var tryNext = function(index) {
      if (index >= candidates.length) {
        console.error('%c[utils.js, selectServerAddress]', 'color: gray;', 'Error: Failed to contact the ' + this.hostname + '!', this);
        onFailure();
        return;
      }
      var addr = candidates[index];
      this.refreshServerInfoAtAddress(addr).then(function() {
        onSuccess(addr);
      }.bind(this), function() {
        tryNext.call(this, index + 1);
      }.bind(this));
    }.bind(this);

    tryNext(0);
  },

  toString: function() {
    var string = '';
    string += 'host name: ' + this.hostname + '\r\n';
    string += 'host address: ' + this.address + '\r\n';
    string += 'local address: ' + this.localAddress + '\r\n';
    string += 'external IP: ' + this.externalIP + '\r\n';
    string += 'mac address: ' + this.macAddress + '\r\n';
    string += 'https port: ' + this.httpsPort + '\r\n';
    string += 'http port: ' + this.httpPort + '\r\n';
    string += 'external port: ' + this.externalPort + '\r\n';
    string += 'client UID: ' + this.clientUid + '\r\n';
    string += 'server UID: ' + this.serverUid + '\r\n';
    string += 'is paired: ' + this.paired + '\r\n';
    string += 'is online: ' + this.online + '\r\n';
    string += 'number of apps: ' + this.numofapps + '\r\n';
    string += 'current game: ' + this.currentGame + '\r\n';
    string += 'app version: ' + this.appVersion + '\r\n';
    string += 'gfe version: ' + this.gfeVersion + '\r\n';
    string += 'server major version: ' + this.serverMajorVersion + '\r\n';
    string += 'server state: ' + this.serverState + '\r\n';
    string += 'nvidia server software: ' + this.isNvidiaServerSoftware + '\r\n';
    string += 'gpu type: ' + this.gputype + '\r\n';
    string += 'supported display modes: ' + '\r\n';

    for (var displayMode in this.supportedDisplayModes) {
      string += '\t' + displayMode + ': ' + this.supportedDisplayModes[displayMode] + '\r\n';
    }

    return string;
  },

  _parseServerInfo: function(xmlStr) {
    $xml = this._parseXML(xmlStr);
    $root = $xml.find('root');

    if ($root.attr('status_code') != 200) {
      return false;
    }

    var serverUid = $root.find('uniqueid').text().trim();
    if (this.serverUid != serverUid && this.serverUid != '') {
      // If we received a UUID that isn't the one we expected, fail
      return false;
    }

    // A server info without a unique ID, or with one that the app doesn't take (isValidServerUid()), counts as no
    // server info: nothing of it is kept, so the device is neither listed nor stored. Only the length of the ID and
    // its start go to the log, as JSON, since the device chose the text.
    if (!isValidServerUid(serverUid)) {
      console.warn('%c[utils.js, _parseServerInfo]', 'color: gray;', 'Warning: Ignoring the server info of ' + this.address + ': ' +
        (serverUid === '' ? 'it has no unique ID.' : 'its unique ID of ' + serverUid.length + ' characters, starting with ' +
        JSON.stringify(serverUid.slice(0, 24)) + ', isn\'t one that the app takes (1 to 64 letters, digits, dashes and underscores, and no name of a property of every object).'));
      return false;
    }

    console.log('%c[utils.js, _parseServerInfo]', 'color: gray;', 'Parsing server info: ', $root);

    // Each field below is kept by its rule (cleanServerText(), isServerAddress(), isMacAddress(), parsePort() and
    // parseDisplayModes() above); a field that breaks its rule is left out or cut, and the host is listed all the same

    // Retrieve the hostname and handle name validation: without control characters, at most 64 characters
    var serverName = cleanServerText($root.find('hostname').text(), SERVER_NAME_MAX_LENGTH);
    if (serverName != '') {
      this.hostname = serverName;
    } else {
      this.hostname = 'UNKNOWN';
    }

    // UUID is mandatory to determine which machine is responding
    this.serverUid = serverUid;

    // Retrieve the local IP address of the host, which the next poll tries: only an address, since it becomes a part
    // of a URL
    var localAddress = $root.find('LocalIP').text().trim();
    this.localAddress = isServerAddress(localAddress) ? localAddress : '';

    // Retrieve the MAC address of the host (required for Wake-on-LAN): six pairs of hexadecimal digits
    var macAddr = $root.find('mac').text().trim();
    if (isMacAddress(macAddr)) {
      this.macAddress = macAddr;
    }

    // This is an extension which is not present in GFE. It is present for Sunshine to be able
    // to support dynamic HTTP WAN ports without requiring the user to manually enter the port.
    // The app only shows it (the details of a host). Without one it is the HTTP port, as for a stored host.
    var externalPort = parsePort($root.find('ExternalPort').text());
    if (externalPort) {
      this.externalPort = externalPort;
    } else if (!isPortNumber(this.externalPort)) {
      this.externalPort = isPortNumber(this.httpPort) ? this.httpPort : DEFAULT_HTTP_PORT;
    }
    // The HTTPS port stands in every HTTPS URL of the host, so a server info without one, or with something else than
    // a port, keeps the port that the host had, or the default port where it had none: never NaN
    var httpsPort = parsePort($root.find('HttpsPort').text());
    if (httpsPort) {
      this.httpsPort = httpsPort;
    } else if (!isPortNumber(this.httpsPort)) {
      this.httpsPort = DEFAULT_HTTPS_PORT;
    }

    // This is not present in newer GFE versions
    var externIP = $root.find('ExternalIP').text().trim();
    if (isServerAddress(externIP)) {
      // Don't overwrite the external IP we found via STUN
      this.externalIP = externIP;
      // The diagnostic log hides it wherever it appears from now on, e.g. in the URLs of the requests that try it
      if (typeof hideDiagnosticAddress === 'function') {
        hideDiagnosticAddress(externIP);
      }
    }

    // These are present in all supported GFE versions
    this.paired = $root.find('PairStatus').text().trim() == 1;
    this.appVersion = cleanServerText($root.find('appversion').text(), SERVER_VERSION_MAX_LENGTH);
    this.serverMajorVersion = parseServerMajorVersion(this.appVersion);

    // This wasn't present on old GFE versions
    this.serverCodecModeSupport = parseInt($root.find('ServerCodecModeSupport').text().trim(), 10);

    try {
      // These aren't critical for functionality, and don't necessarily exist in older GFE versions
      this.gfeVersion = cleanServerText($root.find('GfeVersion').text(), SERVER_VERSION_MAX_LENGTH);
      this.gputype = cleanServerText($root.find('gputype').text(), SERVER_TEXT_MAX_LENGTH);
      this.numofapps = cleanServerText($root.find('numofapps').text(), SERVER_VERSION_MAX_LENGTH);
      // Now for the hard part: parsing the supported streaming. The display modes of this answer replace the ones of
      // the answer before: up to 2.3.0 every poll added to them, and nothing was ever removed.
      var displayModes = [];
      $root.find('DisplayMode').slice(0, DISPLAY_MODE_MAX_ENTRIES).each(function(index, value) { // For each resolution: FPS object
        displayModes.push({ width: $(value).find('Width').text(), height: $(value).find('Height').text(), refreshRate: $(value).find('RefreshRate').text() });
      });
      this.supportedDisplayModes = parseDisplayModes(displayModes);
    } catch (err) {
      // We don't need this data, so no error handling necessary
    }

    var serverStatus = cleanServerText($root.find('state').text(), SERVER_TEXT_MAX_LENGTH);
    if (serverStatus) {
      this.serverState = serverStatus;
      // Detect GFE by its historical "MJOLNIR" codename, which was never used by any third-party server
      this.isNvidiaServerSoftware = serverStatus.includes('MJOLNIR');
    }

    // GFE 2.8 started keeping current game set to the last game played. As a result, it no longer
    // has the semantics that its name would indicate. To contain the effects of this change as much
    // as possible, we'll force the current game to zero if the server isn't in a streaming session.
    if (serverStatus.endsWith('_SERVER_BUSY')) {
      this.currentGame = parseInt($root.find('currentgame').text().trim(), 10);
    } else {
      this.currentGame = 0;
    }

    return true;
  },

  getAppById: function(appId) {
    return this.getAppList().then(function(list) {
      var retApp = null;

      list.some(function(app) {
        if (app.id == appId) {
          retApp = app;
          return true;
        }
        return false;
      });

      return retApp;
    });
  },

  getAppByName: function(appName) {
    return this.getAppList().then(function(list) {
      var retApp = null;

      list.some(function(app) {
        if (app.title == appName) {
          retApp = app;
          return true;
        }
        return false;
      });

      return retApp;
    });
  },

  getAppListWithCacheFlush: function() {
    return sendMessage('openUrl', [
      this._baseUrlHttps + '/applist?' + this._buildUidStr(), this.ppkstr, false, 10000
    ]).catch(error => {
      throw error;
    }).then(function(ret) {
      $xml = this._parseXML(ret);
      $root = $xml.find('root');

      if ($root.attr('status_code') != 200) {
        // TODO: Bubble up an error here
        console.error('%c[utils.js, getAppListWithCacheFlush]', 'color: gray;', 'Error: Failed to request app list: ', $root.attr('status_code'));
        return [];
      }

      var rootElement = $xml.find('root')[0];
      var appElements = rootElement.getElementsByTagName('App');
      var appList = [];

      var skipped = 0;

      for (var i = 0, len = appElements.length; i < len; i++) {
        // An entry without an ID that is a number, or without a title, is left out instead of failing the whole list
        // (a missing element threw here) or naming the box art files of an app 'boxart-NaN.png'
        var app = parseAppListEntry(appElements[i]);
        if (!app) {
          skipped++;
          continue;
        }
        appList.push(app);
      }
      if (skipped > 0) {
        console.warn('%c[utils.js, getAppListWithCacheFlush]', 'color: gray;', 'Warning: Left out ' + skipped + ' of the ' + appElements.length + ' entries of the app list of ' + this.hostname + ', which have no numeric ID or no title.');
      }

      this._memCachedApplist = appList;
      console.log('%c[utils.js, getAppListWithCacheFlush]', 'color: gray;', 'App list requested successfully.');

      return appList;
    }.bind(this));
  },

  getAppList: function() {
    if (this._memCachedApplist) {
      return new Promise(function(resolve, reject) {
        console.log('%c[utils.js, getAppList]', 'color: gray;', 'Returning memory-cached apps list.');
        resolve(this._memCachedApplist);
        return;
      }.bind(this));
    }

    return this.getAppListWithCacheFlush();
  },

  // Returns the URL of the original PNG box art of the given app Id (an object URL of its Blob, see makeBoxArtUrl()) and
  // queues an optimized JPEG preview when Smart Hub Preview is supported. The original PNG box art is stored in private
  // storage, while the optimized JPEG preview is made later, one at a time while the TV is idle (queuePreviewImage()), and
  // stored in the public documents directory so that the Smart Hub Preview background service process can access it
  // directly. A download from the host waits for a place among the box art downloads (boxArtDownloads), and is dropped with
  // BOX_ART_DOWNLOAD_DROPPED if isStale() says by then that the box art is no longer wanted.
  getBoxArt: function(appId, isSmartHubSupported, isStale) {
    return new Promise(function(resolve, reject) {
      // Store the original PNG box art in the private directory, in a directory named after the host
      // (getBoxArtDirName(): the name comes from the host, so it never goes into the path as it is)
      var boxArtDir = 'wgt-private/' + getBoxArtDirName(this.hostname, this.serverUid);
      var boxArtFileName = 'boxart-' + appId + '.png';
      var previewFileName = SMART_HUB_PREVIEW_FILE_PREFIX + appId + '.jpg';

      var self = this;

      // Queue the optimized JPEG preview of the box art. The original PNG box art is returned right away without
      // waiting for it; showApps() in index.js waits for window.previewPromises before it hands the previews to the
      // Smart Hub service.
      var queuePreview = function(blob, origin) {
        var previewPromise = queuePreviewImage(function() {
          return self.generatePreviewImage(blob, appId).then(function(previewBytes) {
            return previewBytes ? self.savePreviewImage(appId, previewBytes) : false;
          });
        }, isStale).catch(function(error) {
          console.warn('%c[utils.js, getBoxArt]', 'color: gray;', 'Warning: Failed to generate Smart Hub Preview box art from ' + origin + ' for app ID ' + appId + ': ' + error);
        });

        if (!window.previewPromises) {
          window.previewPromises = [];
        }
        window.previewPromises.push(previewPromise);
      };

      var fetchBoxArt = function() {
        // Fetch the new box art from the network
        boxArtDownloads.run(function() {
          return sendMessage('openUrl', [
            self._baseUrlHttps + '/appasset?' + self._buildUidStr() + '&appid=' + appId + '&AssetType=2&AssetIdx=0', self.ppkstr, true,
            BOX_ART_TIMEOUT_MS
          ]);
        }, isStale).then(function(boxArtBuffer) {
          // The binary response as a Blob, which the images of the app show through its object URL
          var blob = new Blob([boxArtBuffer], { type: 'image/png' });
          // Always resolve for UI display regardless of caching outcome
          console.log('%c[utils.js, getBoxArt]', 'color: gray;', 'Returning network-fetched box art: ', appId);

          // Save the original PNG to private storage as true binary PNG for local HTTP server and future cache using modern Tizen API
          try {
            // Create the private directory if it does not already exist
            tizen.filesystem.createDirectory(boxArtDir, true);
            // Open the destination file for writing the original PNG data
            var fileHandleWrite = tizen.filesystem.openFile(boxArtDir + '/' + boxArtFileName, 'w');

            // Write the original PNG bytes to private storage and close the file
            fileHandleWrite.writeData(boxArtBuffer);
            fileHandleWrite.close();
            console.log('%c[utils.js, getBoxArt]', 'color: gray;', 'Saved original PNG box art: ' + boxArtFileName);
          } catch (error) {
            // Failure to cache the original PNG box art does not prevent the fetched box art from being returned
            console.error('%c[utils.js, getBoxArt]', 'color: gray;', 'Error: Failed to cache original box art in ' + boxArtDir + ' for app ID ' + appId + ': ' + error.message);
          }

          // Make the optimized JPEG preview box art from network later, when Smart Hub Preview is supported
          if (isSmartHubSupported) {
            queuePreview(blob, 'network');
          }
          makeBoxArtUrl(blob).then(resolve);
        }, function(error) {
          if (error === BOX_ART_DOWNLOAD_DROPPED) {
            console.log('%c[utils.js, getBoxArt]', 'color: gray;', 'Dropped the box art download of app ID ' + appId + '.');
          } else {
            console.error('%c[utils.js, getBoxArt]', 'color: gray;', 'Error: Failed to retrieve original box art from network: ', error);
          }
          reject(error);
        });
      };

      // Try to load the cached original box art from private storage
      try {
        // Open the cached original PNG box art for reading
        var fileHandleRead = tizen.filesystem.openFile(boxArtDir + '/' + boxArtFileName, 'r');
        // Read the binary PNG data from the file (returns Blob)
        var fileContentInBlob = fileHandleRead.readBlob();
        // Close the file after the binary data has been read
        fileHandleRead.close();

        // Guard against empty/corrupt cached files
        if (!fileContentInBlob || fileContentInBlob.size === 0) {
          throw new Error('Cached original box art file is empty.');
        }
        // Ensure proper MIME type so the object URL is recognized as an image
        var typedBlob = new Blob([fileContentInBlob], { type: 'image/png' });

        var processBoxArt = function() {
          console.log('%c[utils.js, getBoxArt]', 'color: gray;', 'Returning storage-cached box art: ', appId);

          if (isSmartHubSupported) {
            // Check whether an optimized Smart Hub Preview has already been cached
            var previewFilePath = 'documents/' + previewFileName;
            var previewExists = false;
            try {
              // Open the cached preview file to check whether it already exists
              var previewFileHandle = tizen.filesystem.openFile(previewFilePath, 'r');
              previewFileHandle.close();
              previewExists = true;
              console.log('%c[utils.js, getBoxArt]', 'color: gray;', 'Smart Hub Preview box art file already cached: ' + previewFileName);
            } catch (previewReadError) {
              // The preview box art file does not exist, so generate it from the original box art
              console.log('%c[utils.js, getBoxArt]', 'color: gray;', 'Smart Hub Preview box art file not found, generating: ' + previewFileName);
            }
            if (!previewExists) {
              queuePreview(typedBlob, 'storage');
            }
          }
          makeBoxArtUrl(typedBlob).then(resolve);
        };

        if (fileContentInBlob.size === SUNSHINE_DEFAULT_BOX_ART_SIZE && window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
          readBlobAsBytes(fileContentInBlob).then(function(bytes) {
            return window.crypto.subtle.digest('SHA-256', bytes);
          }).then(function(hashBuffer) {
            var hashArray = Array.from(new Uint8Array(hashBuffer));
            var hashHex = hashArray.map(function(b) {
              var hex = b.toString(16);
              return hex.length === 1 ? '0' + hex : hex;
            }).join('');

            if (hashHex === SUNSHINE_DEFAULT_BOX_ART_HASH) {
              console.log('%c[utils.js, getBoxArt]', 'color: gray;', 'Detected Sunshine default box art. Forcing redownload for app ID ' + appId);
              try {
                tizen.filesystem.deleteFile(boxArtDir + '/' + boxArtFileName);
              } catch(error) {
                console.error('%c[utils.js, getBoxArt]', 'color: gray;', 'Error: Failed to delete original box art file ' + boxArtFileName + ': ' + error.message);
              }
              try {
                tizen.filesystem.deleteFile('documents/' + previewFileName);
              } catch(error) {
                console.warn('%c[utils.js, getBoxArt]', 'color: gray;', 'Warning: Failed to delete cached preview box art file ' + previewFileName + ': ' + error.message);
              }
              fetchBoxArt();
            } else {
              processBoxArt();
            }
          }).catch(function(err) {
            console.warn('%c[utils.js, getBoxArt]', 'color: gray;', 'Warning: Hash computation failed, proceeding with cached file', err);
            processBoxArt();
          });
        } else {
          // A file of another size is not Sunshine's default box art (or crypto.subtle is not available)
          processBoxArt();
        }

      } catch (readError) {
        // The original PNG box art is not available locally, so fetch it from the host
        console.warn('%c[utils.js, getBoxArt]', 'color: gray;', 'Warning: Could not read cached box art from internal storage!', readError.message);
        fetchBoxArt();
      }
    }.bind(this));
  },

  // Clears cached box art and preview images from local storage.
  // Removes the private box art directory and preview files from the public documents directory.
  clearBoxArt: function() {
    return new Promise(function(resolve, reject) {
      // Private storage directory for original box art, which is deleted with everything in it, so never the name
      // of the host as it is (getBoxArtDirName()): '..' named the private storage of the app itself or what is above it
      var boxArtDir = 'wgt-private/' + getBoxArtDirName(this.hostname, this.serverUid);
      var previewBoxArtDir = 'documents'; // Public storage directory so the background service can read it

      // Delete the original box art directory from private storage
      try {
        tizen.filesystem.deleteDirectory(boxArtDir, true);
        console.log('%c[utils.js, clearBoxArt]', 'color: gray;', 'Cleared original box art files from ' + boxArtDir);
      } catch (error) {
        // The directory may not exist if no original box art has been cached
        console.error('%c[utils.js, clearBoxArt]', 'color: gray;', 'Error: Failed to clear original box art files from ' + boxArtDir + ': ' + error.message);
      }

      // Delete the preview box art images from public storage
      try {
        // List the contents of the public documents directory before removing cached preview files.
        // Tizen 5.0+ listDirectory() returns an array of DOMString filenames.
        tizen.filesystem.listDirectory(previewBoxArtDir, function(files) {
          var deleteCount = 0;

          // Check each entry for a cached preview box art image
          if (files && files.length > 0) {
            // Iterate through all files in the public documents directory
            for (var i = 0; i < files.length; i++) {
              // Safely check if the directory entry is a valid string
              if (files[i] && typeof files[i] === 'string') {
                var filename = files[i];
                // Check if the filename matches the pattern of the cached preview box art images of this build, and
                // leave the files of the regular Moonlight app in the shared directory alone
                if (filename.startsWith(SMART_HUB_PREVIEW_FILE_PREFIX) && filename.endsWith('.jpg')) {
                  try {
                    // Delete the matching cached preview box art files from public storage
                    tizen.filesystem.deleteFile(previewBoxArtDir + '/' + filename);
                    deleteCount++;
                  } catch(error) {
                    console.warn('%c[utils.js, clearBoxArt]', 'color: gray;', 'Warning: Failed to delete cached preview box art file ' + filename + ': ' + error.message);
                  }
                }
              }
            }
          }
          console.log('%c[utils.js, clearBoxArt]', 'color: gray;', 'Cleared ' + deleteCount + ' cached preview box art files from ' + previewBoxArtDir);
          resolve();
        }.bind(this), function(error) {
          console.warn('%c[utils.js, clearBoxArt]', 'color: gray;', 'Warning: Could not list documents directory to clear cached preview box art files: ' + error.message);
          resolve();
        });
      } catch (error) {
        console.error('%c[utils.js, clearBoxArt]', 'color: gray;', 'Error: Failed to clear cached preview box art files: ' + error.message);
        reject(error);
      }
    }.bind(this));
  },

  // Generates a JPEG preview image from the original box art (its Blob, or the URL of an image) and resolves with the
  // bytes of the JPEG (a Uint8Array), or null when no preview can be made.
  // The image is progressively compressed and resized until it fits within the
  // maximum file size allowed for Smart Hub Preview, while preserving a minimum
  // image size for small source images.
  // The box art is decoded by createImageBitmap() and each JPEG encoded by canvas.toBlob(), which Chromium both runs
  // away from the main thread or in its idle time: the synchronous decode of drawImage() and encode of toDataURL()
  // took a long task of a few hundred milliseconds per box art on the TV. A browser without them takes the old way.
  generatePreviewImage: function(source, appId) {
    var MAX_FILE_SIZE = 350 * 1024;
    var MIN_QUALITY = 0.25;
    var QUALITY_STEP = 0.05;
    var SCALE_STEP = 0.9;
    var MIN_SCALE_WIDTH = 100;
    var MIN_SCALE_HEIGHT = 100;
    var isBlob = typeof Blob !== 'undefined' && source instanceof Blob;

    // Decode the original box art: an ImageBitmap of its Blob, or an image element
    var decode = function() {
      if (isBlob && typeof createImageBitmap === 'function') {
        return createImageBitmap(source);
      }
      return (isBlob ? readBlobAsDataUrl(source) : Promise.resolve(source)).then(function(url) {
        return new Promise(function(resolve, reject) {
          var image = new Image();
          image.onload = function() {
            resolve(image);
          };
          image.onerror = function() {
            reject(new Error('The image cannot be decoded'));
          };
          image.src = url;
        });
      });
    };

    // Encode the canvas as a JPEG Blob of the given quality (null if it can't be encoded)
    var encode = function(canvas, quality) {
      if (typeof canvas.toBlob === 'function') {
        return new Promise(function(resolve) {
          canvas.toBlob(resolve, 'image/jpeg', quality);
        });
      }
      return Promise.resolve(new Blob([dataUrlToBytes(canvas.toDataURL('image/jpeg', quality))], { type: 'image/jpeg' }));
    };

    return decode().then(function(image) {
      var canvas = null;
      // Free the decoded box art and the pixels of the canvas, and give the canvas back for the next preview
      var closeImage = function(result) {
        if (typeof image.close === 'function') {
          image.close();
        }
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
          previewCanvas = canvas;
          canvas = null;
        }
        return result;
      };
      // Get the source image dimensions
      var width = image.naturalWidth || image.width;
      var height = image.naturalHeight || image.height;

      // Ensure the image has valid dimensions before processing
      if (!width || !height) {
        console.error('%c[utils.js, generatePreviewImage]', 'color: gray;', 'Invalid image dimensions for app ID ' + appId);
        return closeImage(null);
      }

      // Take the canvas used to resize and convert the box art to JPEG, or a new one while another preview uses it
      canvas = previewCanvas || document.createElement('canvas');
      previewCanvas = null;
      var context = canvas.getContext('2d');

      if (!context) {
        console.error('%c[utils.js, generatePreviewImage]', 'color: gray;', 'Unable to create canvas context for app ID ' + appId);
        return closeImage(null);
      }

      // Draw the source box art at the current dimensions
      var draw = function() {
        canvas.width = width;
        canvas.height = height;
        context.drawImage(image, 0, 0, width, height);
      };

      // Try reducing JPEG quality before reducing the image dimensions, and try progressively smaller images until the
      // file size limit is met
      var attempt = function(quality) {
        return encode(canvas, quality).then(function(jpeg) {
          if (!jpeg) {
            throw new Error('The JPEG cannot be encoded');
          }
          // Return the first image that meets the file size limit
          if (jpeg.size <= MAX_FILE_SIZE) {
            console.log('%c[utils.js, generatePreviewImage]', 'color: gray;', 'Created preview image for app ID ' +
            appId + ': ' + Math.round(jpeg.size / 1024) + ' KB (' + width + 'x' + height + ', quality ' + quality.toFixed(2) + ')');
            return readBlobAsBytes(jpeg);
          }

          // Lower the JPEG quality before attempting to reduce the image dimensions
          var nextQuality = quality - QUALITY_STEP;
          if (nextQuality >= MIN_QUALITY) {
            return attempt(nextQuality);
          }

          // Stop shrinking once the minimum scaling dimensions have been reached.
          // The current dimensions have already been tested at all supported
          // quality levels before exiting.
          if (width <= MIN_SCALE_WIDTH || height <= MIN_SCALE_HEIGHT) {
            console.error('%c[utils.js, generatePreviewImage]', 'color: gray;', 'Error: Unable to create preview image within the size limit for app ID ' + appId);
            return null;
          }

          // Quality reduction was not enough, so reduce the dimensions and try again
          width = Math.round(width * SCALE_STEP);
          height = Math.round(height * SCALE_STEP);
          draw();
          return attempt(0.85);
        });
      };

      try {
        draw();
      } catch (error) {
        closeImage();
        throw error;
      }
      return attempt(0.85).then(closeImage, function(error) {
        closeImage();
        throw error;
      });
    }, function() {
      // Handle failures when the original box art cannot be decoded
      console.error('%c[utils.js, generatePreviewImage]', 'color: gray;', 'Error: Failed to decode box art for app ID ' + appId);
      return null;
    }).catch(function(error) {
      console.error('%c[utils.js, generatePreviewImage]', 'color: gray;', 'Error: Failed to generate preview image for app ID ' + appId + ': ' + (error && error.message));
      return null;
    });
  },

  // Saves the generated JPEG preview image (its bytes, or a data URL of it) to the public documents directory.
  savePreviewImage: function(appId, preview) {
    try {
      // Build the filename and path used by the local HTTP server
      var filename = SMART_HUB_PREVIEW_FILE_PREFIX + appId + '.jpg';
      var filePath = 'documents/' + filename;

      // The bytes of the JPEG for the Tizen file API
      var bytes = typeof preview === 'string' ? dataUrlToBytes(preview) : (ArrayBuffer.isView(preview) ? preview : new Uint8Array(preview));

      // Open the preview file for writing
      var fileHandle = tizen.filesystem.openFile(filePath, 'w');

      try {
        // Write the JPEG data to local storage
        fileHandle.writeData(bytes);
      } finally {
        // Always close the file handle, even if writing fails
        fileHandle.close();
      }

      console.log('%c[utils.js, savePreviewImage]', 'color: gray;', 'Saved preview image: ' + filePath + ' (' + Math.round(bytes.length / 1024) + ' KB)');
      return true;
    } catch (error) {
      console.warn('%c[utils.js, savePreviewImage]', 'color: gray;', 'Warning: Failed to save preview image: ' + error.message);
      if (!previewImageSaveFailed) {
        previewImageSaveFailed = true;
        console.warn('%c[utils.js, savePreviewImage]', 'color: gray;', 'Warning: No more Smart Hub Preview box art is made until the app starts again.');
      }
      return false;
    }
  },

  // With continuousAudio, the host keeps sending audio packets during silence (Sunshine since v2026.516.143833 with
  // fbcf2116, which leaves them out otherwise; other hosts ignore the parameter), so that the audio player of the TV
  // and the link to a soundbar don't run dry, and the audio statistics count only real losses. The start of a stream
  // always passes it (startGame() in index.js), as moonlight-tv (1cd208b) does with every launch. Without it the
  // request is the one of versions before 1.19.102.
  launchApp: function(appId, mode, sops, rikey, rikeyid, enableHdr, localAudio, surroundAudioInfo, gamepadMask, continuousAudio) {
    return sendMessage('openUrl', [
      this._baseUrlHttps + '/launch?' + this._buildUidStr() + '&appid=' + appId + '&mode=' + mode +
      '&additionalStates=1&sops=' + sops + '&rikey=' + rikey + '&rikeyid=' + rikeyid + '&hdrMode=' + enableHdr +
      '&localAudioPlayMode=' + localAudio + '&surroundAudioInfo=' + surroundAudioInfo +
      '&remoteControllersBitmap=' + gamepadMask + '&gcmap=' + gamepadMask + (continuousAudio ? '&continuousAudio=1' : ''),
      this.ppkstr, false
    ]);
  },

  resumeApp: function(mode, sops, rikey, rikeyid, enableHdr, localAudio, surroundAudioInfo, gamepadMask, continuousAudio) {
    return sendMessage('openUrl', [
      this._baseUrlHttps + '/resume?' + this._buildUidStr() + '&mode=' + mode +
      '&additionalStates=1&sops=' + sops + '&rikey=' + rikey + '&rikeyid=' + rikeyid + '&hdrMode=' + enableHdr +
      '&localAudioPlayMode=' + localAudio + '&surroundAudioInfo=' + surroundAudioInfo +
      '&remoteControllersBitmap=' + gamepadMask + '&gcmap=' + gamepadMask + (continuousAudio ? '&continuousAudio=1' : ''),
      this.ppkstr, false
    ]);
  },

  // Quit the running app. A host may answer /cancel with success without quitting an app that another client started,
  // so the server info is refreshed once /cancel completed, and the quit fails with QUIT_APP_STILL_RUNNING_ERROR while
  // the host still reports a running app. It also fails when /cancel or the refresh fails.
  quitApp: function() {
    return sendMessage('openUrl', [
      this._baseUrlHttps + '/cancel?' + this._buildUidStr(), this.ppkstr, false, QUIT_APP_TIMEOUT_MS
    ]).then(function() {
      return this.refreshServerInfo();
    }.bind(this)).then(function() {
      if (this.currentGame != 0) {
        console.warn('%c[utils.js, quitApp]', 'color: gray;', 'Warning: ' + this.hostname + ' still runs the app ' + this.currentGame + ' after quitting it!');
        return Promise.reject(QUIT_APP_STILL_RUNNING_ERROR);
      }
      return true;
    }.bind(this));
  },

  updateExternalAddressIP4: function() {
    console.log('%c[utils.js, updateExternalAddressIP4]', 'color: gray;', 'Looking for the external IPv4 address of ' + this.hostname + '...');
    return sendMessage('STUN', []).then(function(addr) {
      if (addr) {
        this.externalIP = addr;
        // The address itself stays out of the log, whose photos users post on the issue tracker, also in the URLs of the
        // requests that try it (diagnostics.js)
        if (typeof hideDiagnosticAddress === 'function') {
          hideDiagnosticAddress(addr);
        }
        console.log('%c[utils.js, updateExternalAddressIP4]', 'color: gray;', 'Found the external IPv4 address of ' + this.hostname + '.');
      } else {
        console.error('%c[utils.js, updateExternalAddressIP4]', 'color: gray;', 'Error: External IPv4 address lookup failed!');
      }
    }.bind(this))
  },

  pair: function(randomNumber) {
    return this.refreshServerInfo().then(function() {
      if (this.paired && this.ppkstr) {
        return true;
      }
      return sendMessage('pair', [
        this.serverMajorVersion.toString(), this.address, this.httpPort, randomNumber, this.getUid()
      ]).then(function(ppkstr) {
        this.ppkstr = ppkstr;
        return sendMessage('openUrl', [
          this._baseUrlHttps + '/pair?uniqueid=' + this.getUid() + '&devicename=roth&updateState=1&phrase=pairchallenge', this.ppkstr, false, 5000
        ]).catch(function(error) {
          throw error;
        }.bind(this)).then(function(ret) {
          $xml = this._parseXML(ret);
          this.paired = $xml.find('paired').html() == '1';
          return this.paired;
        }.bind(this));
      }.bind(this));
    }.bind(this));
  },

  sendWOL: function() {
    return sendMessage('wakeOnLan', [this.macAddress, getSubnetBroadcastAddress()]);
  },

  _buildUidStr: function() {
    return 'uniqueid=' + this.getUid() + '&uuid=' + guuid();
  },

  _parseXML: function(xmlData) {
    return $($.parseXML(xmlData.toString()));
  },
};
