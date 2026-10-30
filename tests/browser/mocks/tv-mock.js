// Simulated Samsung TV for the tests: the `tizen` and `webapis` objects that the Tizen web runtime provides on a real
// TV, built from a small configuration (TV preset, model, panel, HDR, Tizen version, network connection).
//
// The same file serves two purposes:
// - In Node (unit tests), `require()` returns the presets, the configuration parser and createTizenApis().
// - In the browser, the test server inserts it as the first script of index.html, where it reads the configuration
//   and installs `window.tizen` before any app script runs, like the TV does. `webapis.js` next to it installs
//   `window.webapis` at the path the app loads it from ($WEBAPIS/webapis/webapis.js).
//
// The configuration comes from the query string of the page (e.g. index.html?tv=fhd&conn=wifi) and from
// `window.__MOCK_CONFIG__`, which a test can set with an init script and which wins over the query string:
// - tv: one of the presets below (default 's90c'), which sets model, series, modelCode, panel, hdr and tizen
// - model, series, modelCode: what getRealModel(), getModel() and getModelCode() return
// - panel: 'fhd', '4k' or '8k'; hdr: true/false (or 1/0); tizen: the platform version, e.g. '9.0'
// - conn: 'ethernet', 'wifi' or 'unknown' ('none' is accepted as unknown, 'error' makes the API throw)
// - wifiSignal: the Wi-Fi signal strength from 0 to 1, or 'nan' for the NaN that some TVs report
// - forceGM: true for the ForceGM variant (game mode metadata); appVersion: the version of the app
// - failApis: comma-separated API paths that fail, e.g. 'webapis.avinfo.isHdrTvSupport,tizen.systeminfo.getCapability'.
//   A function throws when called, any other object (e.g. 'webapis.avinfo') is removed.
// - wasmStartMs: how long the stub of the WebAssembly module takes to start, in milliseconds (default 50)
// - wasmPlayer: the `tizentvwasm` object of the WASM player (see createWasmPlayerApi() below): 'none' (default, no
//   tizentvwasm as in a desktop browser), 'ull', 'noUll', 'apiLevels', 'legacy', 'disagree' or 'throws'
// - codecs: what MediaSource.isTypeSupported() answers (see createMediaSource() below): 'all' (default), 'noAv1',
//   'noAv1Main10', 'noLevel52', 'acceptsBogus', 'noH264', 'throws' or 'none' (no MediaSource)
// - locale: the language of the TV that tizen.systeminfo.getPropertyValue('LOCALE') reports, in the (LANGUAGE)_(REGION)
//   form of the Tizen API, e.g. 'de_AT' (default '': the property fails, and the app reads the language of the browser)
//
// The model strings of the presets are illustrative, not read from real devices. Only the S90C model name matches the
// TV that the app was tuned for, and the S90C preset is the golden case of the generalization plan.
(function(root) {
  'use strict';

  var TV_PRESETS = {
    // The tested Samsung S90C (55-inch OLED, 2023) after its update to Tizen 9.0: 4K panel with HDR
    s90c: { model: 'QE55S90CAT', series: '23_PONTUSM_OLED', modelCode: '23_PONTUSM', panel: '4k', hdr: true, tizen: '9.0' },
    // A generic 2022 UHD TV with HDR on Tizen 6.5
    uhd: { model: 'QE55Q80BAT', series: '22_PONTUSM_QTV', modelCode: '22_PONTUSM', panel: '4k', hdr: true, tizen: '6.5' },
    // A 2020 Full HD TV without HDR on Tizen 5.5, the oldest platform the app installs on
    fhd: { model: 'UE43T5300AU', series: '20_KANTM2_FHD', modelCode: '20_KANTM2', panel: 'fhd', hdr: false, tizen: '5.5' },
    // A 2022 8K TV with HDR on Tizen 6.5
    '8k': { model: 'QE65QN900BT', series: '22_PONTUSM_8K', modelCode: '22_PONTUSM', panel: '8k', hdr: true, tizen: '6.5' }
  };

  var DEFAULTS = {
    tv: 's90c',
    conn: 'ethernet',
    wifiSignal: 0.78,
    forceGM: false,
    // The version of res/config.xml, which unit/app-identity.test.js keeps in step
    appVersion: '2.1.0',
    ip: '192.168.0.50',
    subnetMask: '255.255.255.0',
    failApis: '',
    wasmStartMs: 50,
    wasmPlayer: 'none',
    codecs: 'all',
    locale: ''
  };

  var BOOLEAN_KEYS = ['hdr', 'forceGM'];
  var CONFIG_KEYS = ['tv', 'model', 'series', 'modelCode', 'panel', 'hdr', 'tizen', 'conn', 'wifiSignal', 'forceGM', 'appVersion', 'ip', 'subnetMask', 'failApis', 'wasmStartMs', 'wasmPlayer', 'codecs', 'locale'];

  // Convert a query string value to a boolean, accepting 1/0, true/false, yes/no and on/off
  function toBoolean(value) {
    if (typeof value === 'boolean') {
      return value;
    }
    return ['1', 'true', 'yes', 'on'].indexOf(String(value).toLowerCase()) >= 0;
  }

  // Build the complete configuration from the query string and an override object
  function parseConfig(search, override) {
    var given = {};
    var params = typeof URLSearchParams === 'function' ? new URLSearchParams(search || '') : null;
    CONFIG_KEYS.forEach(function(key) {
      if (params && params.has(key)) {
        given[key] = params.get(key);
      }
    });
    if (override && typeof override === 'object') {
      Object.keys(override).forEach(function(key) {
        given[key] = override[key];
      });
    }

    var tv = String(given.tv || DEFAULTS.tv).toLowerCase();
    var preset = TV_PRESETS[tv];
    if (!preset) {
      throw new Error('Unknown TV preset: ' + tv + ' (known: ' + Object.keys(TV_PRESETS).join(', ') + ')');
    }

    var config = {};
    Object.keys(DEFAULTS).forEach(function(key) {
      config[key] = DEFAULTS[key];
    });
    Object.keys(preset).forEach(function(key) {
      config[key] = preset[key];
    });
    Object.keys(given).forEach(function(key) {
      config[key] = given[key];
    });
    config.tv = tv;
    BOOLEAN_KEYS.forEach(function(key) {
      config[key] = toBoolean(config[key]);
    });
    config.panel = String(config.panel).toLowerCase();
    if (['fhd', '4k', '8k'].indexOf(config.panel) < 0) {
      throw new Error('Unknown panel: ' + config.panel + ' (known: fhd, 4k, 8k)');
    }
    config.conn = String(config.conn).toLowerCase();
    if (config.conn === 'none') {
      config.conn = 'unknown';
    }
    if (['ethernet', 'wifi', 'unknown', 'error'].indexOf(config.conn) < 0) {
      throw new Error('Unknown connection: ' + config.conn + ' (known: ethernet, wifi, unknown, error)');
    }
    config.wifiSignal = String(config.wifiSignal).toLowerCase() === 'nan' ? NaN : Number(config.wifiSignal);
    config.tizen = String(config.tizen);
    config.failApis = String(config.failApis || '').split(',').map(function(entry) {
      return entry.trim();
    }).filter(function(entry) {
      return entry.length > 0;
    });
    config.wasmStartMs = Number(config.wasmStartMs);
    config.wasmPlayer = String(config.wasmPlayer);
    if (WASM_PLAYER_MODES.indexOf(config.wasmPlayer) < 0) {
      throw new Error('Unknown WASM player: ' + config.wasmPlayer + ' (known: ' + WASM_PLAYER_MODES.join(', ') + ')');
    }
    config.codecs = String(config.codecs);
    if (CODEC_MODES.indexOf(config.codecs) < 0) {
      throw new Error('Unknown codecs: ' + config.codecs + ' (known: ' + CODEC_MODES.join(', ') + ')');
    }
    return config;
  }

  var WASM_PLAYER_MODES = ['none', 'ull', 'noUll', 'apiLevels', 'legacy', 'disagree', 'throws'];
  var CODEC_MODES = ['all', 'noAv1', 'noAv1Main10', 'noLevel52', 'acceptsBogus', 'noH264', 'throws', 'none'];

  // Create the `tizentvwasm` object of the WASM player in the shapes that the glue code of Samsung's Emscripten SDK
  // (in the built moonlight-wasm.js) distinguishes, or undefined for 'none'. The versions and API levels are
  // illustrative, not read from real devices:
  // - 'ull': availableApis and isApiFeatureSupported(), with the feature 'ultra-low-latency'
  // - 'noUll': the same without that feature
  // - 'apiLevels': availableApis with API levels only and no isApiFeatureSupported(), as on older players
  // - 'legacy': only the classes of the player, without availableApis, from which the glue code derives API level 0
  //   (its media track has no session ID)
  // - 'disagree': availableApis lists the feature, while isApiFeatureSupported() answers false
  // - 'throws': reading availableApis throws
  function createWasmPlayerApi(mode) {
    if (mode === 'none') {
      return undefined;
    }
    var ElementaryMediaStreamSource = function() {};
    var ElementaryMediaTrack = function() {};
    var api = { ElementaryMediaStreamSource: ElementaryMediaStreamSource, ElementaryMediaTrack: ElementaryMediaTrack };
    if (mode === 'legacy') {
      return api;
    }
    if (mode === 'throws') {
      Object.defineProperty(api, 'availableApis', {
        get: function() {
          throw new Error('Simulated failure of tizentvwasm.availableApis');
        }
      });
      return api;
    }
    var sockets = { name: 'TizenSockets', version: '1.0', apiLevels: [1], features: [] };
    if (mode === 'apiLevels') {
      api.availableApis = [sockets, { name: 'ElementaryMediaStreamSource', version: '1.1', apiLevels: [0, 1, 2, 3] }];
      return api;
    }
    var features = ['base-emss', 'video-texture', 'software-decoding', 'construct-with-modes'];
    if (mode === 'ull' || mode === 'disagree') {
      features.push('ultra-low-latency');
    }
    var emss = { name: 'ElementaryMediaStreamSource', version: '1.4', apiLevels: mode === 'noUll' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5], features: features };
    api.availableApis = [sockets, emss];
    api.isApiFeatureSupported = function(apiName, feature) {
      if (mode === 'disagree') {
        return false;
      }
      return api.availableApis.some(function(entry) {
        return entry.name === apiName && entry.features.indexOf(feature) >= 0;
      });
    };
    api.isApiSupported = function(apiName, apiLevel) {
      return api.availableApis.some(function(entry) {
        return entry.name === apiName && entry.apiLevels.indexOf(apiLevel) >= 0;
      });
    };
    return api;
  }

  // Return the isTypeSupported() of a simulated MediaSource for a codecs mode, which answers for the codec strings of the
  // video track of the WASM player (VIDEO_DECODER_PROBES in tv_profile.js) and rejects every other codec:
  // - 'all': every codec of the WASM player
  // - 'noAv1', 'noAv1Main10': no AV1, or no AV1 in 10 bits
  // - 'noLevel52': HEVC and AV1 only at level 5.1
  // - 'acceptsBogus': every MIME type, also a codec that doesn't exist
  // - 'noH264': no H.264
  // - 'throws': every call throws
  function createIsTypeSupported(mode) {
    var known = /^(avc1\.64002A|hev1\.[12]\.[46]\.L15[36]\.B0|av01\.0\.1[34]M\.(08|10))$/;
    return function(mimeType) {
      if (mode === 'throws') {
        throw new Error('Simulated failure of MediaSource.isTypeSupported');
      }
      if (mode === 'acceptsBogus') {
        return true;
      }
      var match = /codecs="([^"]*)"/.exec(String(mimeType));
      var codec = match ? match[1] : '';
      if (!known.test(codec)) {
        return false;
      }
      if (mode === 'noAv1' && codec.indexOf('av01') === 0) {
        return false;
      }
      if (mode === 'noAv1Main10' && /^av01\..*\.10$/.test(codec)) {
        return false;
      }
      if (mode === 'noLevel52' && /L156|14M/.test(codec)) {
        return false;
      }
      if (mode === 'noH264' && codec.indexOf('avc1') === 0) {
        return false;
      }
      return true;
    };
  }

  // Create a simulated MediaSource for a codecs mode (see createIsTypeSupported()), or undefined for 'none'
  function createMediaSource(mode) {
    return mode === 'none' ? undefined : { isTypeSupported: createIsTypeSupported(mode) };
  }

  // Make the API paths of the configuration fail: a function throws when called, any other object is removed
  function applyFailingApis(failApis, roots) {
    failApis.forEach(function(apiPath) {
      var parts = apiPath.split('.');
      var parent = roots[parts[0]];
      if (!parent || parts.length < 2) {
        throw new Error('Unknown API path to fail: ' + apiPath + ' (it must start with tizen. or webapis.)');
      }
      for (var i = 1; i < parts.length - 1; i++) {
        parent = parent[parts[i]];
        if (!parent) {
          throw new Error('Unknown API path to fail: ' + apiPath);
        }
      }
      var name = parts[parts.length - 1];
      if (typeof parent[name] === 'function') {
        parent[name] = function() {
          throw new Error('Simulated failure of ' + apiPath);
        };
      } else if (parent[name] !== undefined) {
        delete parent[name];
      } else {
        throw new Error('Unknown API path to fail: ' + apiPath);
      }
    });
  }

  // Create the simulated `tizen` and `webapis` objects for a configuration. Calls with an effect on the TV (keys,
  // volume, screensaver, exit) are recorded in `calls`, so a test can check them.
  function createTizenApis(config, scheduler) {
    var calls = [];
    var later = scheduler || function(callback) {
      setTimeout(callback, 0);
    };
    var record = function(name, args) {
      calls.push({ name: name, args: Array.prototype.slice.call(args || []) });
    };
    var connectionTypes = { DISCONNECTED: 0, WIFI: 1, CELLULAR: 2, ETHERNET: 3 };
    // The IDs and the display name of res/config.xml, which unit/app-identity.test.js keeps in step
    var appInfo = {
      id: 'MLightS90C.MoonlightWasm',
      packageId: 'MLightS90C',
      name: 'Moonlight Plus',
      version: config.appVersion
    };

    var webapis = {
      productinfo: {
        getModel: function() {
          return config.series;
        },
        getRealModel: function() {
          return config.model;
        },
        getModelCode: function() {
          return config.modelCode;
        },
        isUdPanelSupported: function() {
          return config.panel === '4k' || config.panel === '8k';
        },
        is8KPanelSupported: function() {
          return config.panel === '8k';
        }
      },
      avinfo: {
        isHdrTvSupport: function() {
          return config.hdr;
        }
      },
      network: {
        NetworkActiveConnectionType: connectionTypes,
        getActiveConnectionType: function() {
          if (config.conn === 'error') {
            throw new Error('Simulated network API failure');
          }
          return { ethernet: connectionTypes.ETHERNET, wifi: connectionTypes.WIFI, unknown: connectionTypes.DISCONNECTED }[config.conn];
        },
        getIp: function() {
          return config.ip;
        },
        getSubnetMask: function() {
          return config.subnetMask;
        }
      },
      appcommon: {
        AppCommonScreenSaverState: { SCREEN_SAVER_OFF: 0, SCREEN_SAVER_ON: 1 },
        setScreenSaver: function(state, onSuccess) {
          record('webapis.appcommon.setScreenSaver', [state]);
          if (onSuccess) {
            onSuccess();
          }
        }
      },
      preview: {
        setPreviewData: function() {
          record('webapis.preview.setPreviewData', arguments);
        }
      }
    };

    var currentApplication = {
      appInfo: appInfo,
      exit: function() {
        record('tizen.application.exit', arguments);
      },
      hide: function() {
        record('tizen.application.hide', arguments);
      },
      getRequestedAppControl: function() {
        return null;
      }
    };

    var tizen = {
      application: {
        getAppInfo: function() {
          return appInfo;
        },
        getAppMetaData: function() {
          return config.forceGM ? [{ key: 'http://samsung.com/tv/metadata/use.game.mode', value: 'true' }] : [];
        },
        getCurrentApplication: function() {
          return currentApplication;
        },
        // The Smart Hub service doesn't exist in a desktop browser, so its launch fails like on a TV without it
        launchAppControl: function(appControl, appId, onSuccess, onError) {
          record('tizen.application.launchAppControl', [appId]);
          later(function() {
            if (onError) {
              onError({ name: 'NotFoundError', message: 'The service is not available in the test browser' });
            }
          });
        }
      },
      systeminfo: {
        getCapability: function(key) {
          return String(key).indexOf('platform.version') >= 0 ? config.tizen : null;
        },
        getPropertyValue: function(property, onSuccess, onError) {
          later(function() {
            if (property === 'WIFI_NETWORK') {
              onSuccess({ status: config.conn === 'wifi' ? 'ON' : 'OFF', signalStrength: config.wifiSignal, ssid: 'Test network' });
            } else if (property === 'NETWORK') {
              onSuccess({ networkType: config.conn === 'wifi' ? 'WIFI' : (config.conn === 'ethernet' ? 'ETHERNET' : 'NONE') });
            } else if (property === 'LOCALE' && config.locale) {
              // Both fields in the (LANGUAGE)_(REGION) form, as the Tizen API documents them
              onSuccess({ language: String(config.locale), country: String(config.locale) });
            } else if (onError) {
              onError({ name: 'NotSupportedError', message: 'Property not simulated: ' + property });
            }
          });
        }
      },
      tvinputdevice: {
        registerKey: function() {
          record('tizen.tvinputdevice.registerKey', arguments);
        },
        unregisterKey: function() {
          record('tizen.tvinputdevice.unregisterKey', arguments);
        },
        getSupportedKeys: function() {
          return [];
        }
      },
      tvaudiocontrol: {
        setVolumeUp: function() {
          record('tizen.tvaudiocontrol.setVolumeUp', arguments);
        },
        setVolumeDown: function() {
          record('tizen.tvaudiocontrol.setVolumeDown', arguments);
        },
        setMute: function() {
          record('tizen.tvaudiocontrol.setMute', arguments);
        }
      },
      messageport: {
        requestLocalMessagePort: function() {
          return {
            addMessagePortListener: function() {
              return 1;
            },
            removeMessagePortListener: function() {}
          };
        },
        requestRemoteMessagePort: function() {
          return {
            sendMessage: function() {
              record('tizen.messageport.sendMessage', arguments);
            }
          };
        }
      },
      filesystem: {},
      ApplicationControl: function(operation, uri, mime, category, data) {
        this.operation = operation;
        this.data = data || [];
      },
      ApplicationControlData: function(key, value) {
        this.key = key;
        this.value = value;
      }
    };

    applyFailingApis(config.failApis || [], { tizen: tizen, webapis: webapis });
    return { tizen: tizen, webapis: webapis, calls: calls };
  }

  var api = {
    TV_PRESETS: TV_PRESETS,
    DEFAULTS: DEFAULTS,
    WASM_PLAYER_MODES: WASM_PLAYER_MODES,
    CODEC_MODES: CODEC_MODES,
    parseConfig: parseConfig,
    createTizenApis: createTizenApis,
    createWasmPlayerApi: createWasmPlayerApi,
    createMediaSource: createMediaSource
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    var config = parseConfig(root.location ? root.location.search : '', root.__MOCK_CONFIG__);
    var apis = createTizenApis(config);
    root.__tvMock = { config: config, calls: apis.calls, apis: apis, presets: TV_PRESETS };
    root.tizen = apis.tizen;
    // The WASM player of the TV, which a desktop browser doesn't have
    var wasmPlayerApi = createWasmPlayerApi(config.wasmPlayer);
    if (wasmPlayerApi !== undefined) {
      root.tizentvwasm = wasmPlayerApi;
    }
    // The answers of MediaSource about the codecs of the WASM player, instead of those of the desktop browser
    if (config.codecs === 'none') {
      root.MediaSource = undefined;
    } else if (root.MediaSource) {
      Object.defineProperty(root.MediaSource, 'isTypeSupported', { value: createIsTypeSupported(config.codecs), configurable: true, writable: true });
    } else {
      root.MediaSource = createMediaSource(config.codecs);
    }
  }
})(typeof window !== 'undefined' ? window : this);
