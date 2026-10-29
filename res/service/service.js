/**
 * Samsung Smart Hub Preview Background Service for Moonlight
 *
 * This Tizen service runs in the background and receives preview data
 * from the main application via message ports, then sets it using
 * the Samsung webapis.preview API.
 *
 * The webapis.preview API is only accessible from within a Tizen service,
 * not from the main web application context.
 *
 * It also runs a lightweight local HTTP server to serve box art images
 * to the Smart Hub Preview renderer, bypassing strict cross-process file sandboxes.
 */
/* global tizen, webapis, module */

var packageId = tizen.application.getCurrentApplication().appInfo.packageId;
var applicationId = packageId + '.MoonlightWasm';
var remoteMessagePort;

var fs = null;
try {
  fs = require('fs');
} catch (e) {
  console.error('%c[service.js]', 'color: gray;', '[SmartHub Service] fs module is not available: ' + e.message);
}

var http = null;
try {
  http = require('http');
} catch (e) {
  console.error('%c[service.js]', 'color: gray;', '[SmartHub Service] http module is not available: ' + e.message);
}

// Port of the local box art server. The regular Moonlight app uses 8888, so this build, which can be installed next to
// it, uses its own port (SMART_HUB_PREVIEW_PORT in wasm/platform/index.js)
var PREVIEW_PORT = 8889;
// The only routes the box art server answers: a plain preview file name, which the app builds from
// SMART_HUB_PREVIEW_FILE_PREFIX of wasm/static/js/utils.js and the numeric app ID (e.g. '/preview-881448767.jpg' for
// the prefix of the regular Moonlight app). The server listens on every network interface of the TV, so any other route
// (a '..' segment, a further slash, a percent-encoded character, an absolute path or another extension) gets a 404
// without touching the file system, and a file path is only ever built from the file name this pattern captures. Same
// pattern as in the fork of fidoboy (github.com/fidoboy/moonlight-tizen-ac3)
var PREVIEW_ROUTE_PATTERN = /^\/(preview-[A-Za-z0-9_-]+\.jpg)$/;
var tvIp = '127.0.0.1';
var localServer = null;
var routeMap = {};

/**
 * Sends a message to the main application and logs it.
 * Service logs are not easily visible, so we relay messages back to the app.
 *
 * @param {string} value - Message to send and log
 */
function logAndSend(value) {
  console.log('%c[service.js, logAndSend]', 'color: gray;', '[SmartHub Service] ' + value);
  sendMessage(value);
}

/**
 * Sends a message to the remote message port (main application).
 *
 * @param {string} value - Message value to send
 * @param {string} [key] - Message key (defaults to "KEY")
 */
function sendMessage(value, key) {
  key = key || 'KEY';
  if (remoteMessagePort === undefined) {
    try {
      remoteMessagePort = tizen.messageport.requestRemoteMessagePort(applicationId, packageId);
    } catch (e) {
      console.error('%c[service.js, sendMessage]', 'color: gray;', '[SmartHub Service] Could not get remote message port: ' + e.message);
      return;
    }
  }
  if (remoteMessagePort) {
    try {
      remoteMessagePort.sendMessage([{key: key, value: value}]);
    } catch (e) {
      console.error('%c[service.js, sendMessage]', 'color: gray;', '[SmartHub Service] Error sending message: ' + e.message);
    }
  }
}

/**
 * Processes incoming app control data to extract and set preview data.
 */
function startLocalServer() {
  if (!http) {
    logAndSend('startLocalServer aborted: http module is not available');
    return;
  }
  if (!fs) {
    logAndSend('startLocalServer aborted: fs module is not available');
    return;
  }
  if (localServer) {
    logAndSend('Local HTTP server is already running on http://' + tvIp + ':' + PREVIEW_PORT);
    return;
  }
  
  localServer = http.createServer(function (req, res) {
    var route = require('url').parse(req.url).pathname; // Strip query string for cache-busting
    logAndSend('Local HTTP server received request for: ' + route);
    var routeMatch = PREVIEW_ROUTE_PATTERN.exec(route || '');
    if (!routeMatch) {
      logAndSend('Rejected a request for a route that is not a preview file name: ' + route);
      res.writeHead(404);
      res.end();
      return;
    }
    var fileName = routeMatch[1];
    if (routeMap[route]) {
      var imagePath = routeMap[route];
      try {
        var binaryData = fs.readFileSync(imagePath);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': binaryData.length
        });
        res.end(binaryData);
        logAndSend('Successfully served binary image for ' + route + ' | Size: ' + Math.round(binaryData.length / 1024) + ' KB');
      } catch (err) {
        logAndSend('Error reading binary image file for ' + route + ': ' + err.message);
        res.writeHead(404);
        res.end();
      }
    } else {
      // Fallback for TV reboots when memory routeMap is empty. The path is built from the checked file name only,
      // never from the request path
      logAndSend('Attempting fallback disk resolution for: ' + fileName);
      var fallbackPaths = [
        '/opt/usr/home/owner/content/Documents/' + fileName,
        '/home/owner/content/Documents/' + fileName
      ];

      for (var i = 0; i < fallbackPaths.length; i++) {
        try {
          var fallbackData = fs.readFileSync(fallbackPaths[i]);
          var fallbackContentType = 'image/jpeg';
          res.writeHead(200, {
            'Content-Type': fallbackContentType,
            'Content-Length': fallbackData.length
          });
          res.end(fallbackData);
          logAndSend('Successfully served fallback binary image from ' + fallbackPaths[i]);
          return; // Exit on success
        } catch (fallbackErr) {
          // Ignore error and try the next path
          logAndSend('Fallback path not found or error reading: ' + fallbackErr.message);
        }
      }

      logAndSend('Route not found in routeMap or fallbacks for: ' + route);
      res.writeHead(404);
      res.end();
    }
  });
  
  localServer.on('error', function(err) {
    logAndSend('Local HTTP server error: ' + err.message);
  });
  
  localServer.listen(PREVIEW_PORT, '0.0.0.0', function() {
    logAndSend('Local HTTP server listening on http://0.0.0.0:' + PREVIEW_PORT + ' (TV IP: ' + tvIp + ')');
  });
}

function handleDataInRequest() {
  var isSupported = false;
  try {
    isSupported = typeof webapis !== 'undefined'
      && typeof webapis.preview !== 'undefined'
      && typeof webapis.preview.setPreviewData === 'function';
  } catch (e) {
    logAndSend('Error checking webapis.preview support: ' + e.message);
  }

  try {
    var reqAppControl = tizen.application.getCurrentApplication().getRequestedAppControl();

    if (!reqAppControl) {
      logAndSend('No requested AppControl found.');
      if (isSupported) {
        startLocalServer();
      }
      return;
    }

    var appControlData = reqAppControl.appControl.data;
    if (!appControlData || appControlData.length === 0) {
      logAndSend('AppControl data is empty.');
      if (isSupported) {
        startLocalServer();
      }
      return;
    }
    
    var foundPreview = false;

    for (var i = 0; i < appControlData.length; i++) {
      var key = appControlData[i].key;
      var value = appControlData[i].value;

      if (key === 'Probe') {
        var probeResult = isSupported ? 'SMART_HUB_SUPPORTED' : 'SMART_HUB_NOT_SUPPORTED';
        sendMessage(probeResult, 'PROBE');
        logAndSend('Probe result: ' + probeResult);
        tizen.application.getCurrentApplication().exit();
        return;
      }

      if (key === 'Preview') {
        foundPreview = true;
        
        if (!isSupported) {
          logAndSend('webapis.preview API is not available on this device. Smart Hub Preview is not supported.');
          tizen.application.getCurrentApplication().exit();
          return;
        }

        try {
          startLocalServer();
        } catch (serverErr) {
          logAndSend('Failed to start local HTTP server: ' + serverErr.message);
        }

        var previewData = value[0];
        var parsedPreviewData = JSON.parse(previewData);
        logAndSend('Preview data received. Size: ' + previewData.length + ' bytes');

        if (parsedPreviewData.sections) {
          parsedPreviewData.sections.forEach(function(section) {
            if (section.tiles) {
              section.tiles.forEach(function(tile) {
                if (tile.image_url && tile.txtPath) {
                  var parsedUrl = require('url').parse(tile.image_url);
                  var route = parsedUrl.pathname;
                  // Map only the routes the server answers (PREVIEW_ROUTE_PATTERN)
                  if (PREVIEW_ROUTE_PATTERN.test(route || '')) {
                    routeMap[route] = tile.txtPath;
                    logAndSend('Mapped route ' + route + ' to ' + tile.txtPath);
                  } else {
                    logAndSend('Ignored the image route ' + route + ', which is not a preview file name');
                  }
                  
                  // Fallback to Samsung webapis to get the real IP
                  if (tvIp === '127.0.0.1') {
                    try {
                      if (typeof webapis !== 'undefined' && webapis.network) {
                        tvIp = webapis.network.getIp();
                        logAndSend('Obtained TV IP from webapis.network: ' + tvIp);
                      }
                    } catch(netErr) {
                      logAndSend('Failed to get IP from webapis.network: ' + netErr.message);
                    }
                  }

                  // Rewrite image_url to use the real IP address
                  tile.image_url = tile.image_url.replace('127.0.0.1', tvIp);
                  var logUrl = tile.image_url.length > 60 ? tile.image_url.substring(0, 60) + '...' : tile.image_url;
                  logAndSend('Prepared image_url: ' + logUrl);
                  
                  delete tile.txtPath; // Strip unknown field before passing to Samsung API
                }
              });
            }
          });
        }

        try {
          webapis.preview.setPreviewData(JSON.stringify(parsedPreviewData), function() {
              logAndSend('Preview set successfully. Service will remain alive to serve HTTP requests.');
              // tizen.application.getCurrentApplication().exit();
            }, function(e) {
              logAndSend('Preview data setting failed: ' + e.message);
              tizen.application.getCurrentApplication().exit();
            }
          );
        } catch (e) {
          logAndSend('Preview data setting exception: ' + e.message);
          tizen.application.getCurrentApplication().exit();
        }
      } else {
        logAndSend('Unhandled key: ' + key + ', value: ' + value);
      }
    }
    
    if (!foundPreview) {
      logAndSend('No Preview key found in appControlData.');
    }
  } catch (e) {
    logAndSend('Error handling request: ' + e.message);
  }
}

module.exports.onStart = function() {
  logAndSend('Service started.');
};

module.exports.onRequest = function() {
  logAndSend('Service request received.');
  try {
    handleDataInRequest();
  } catch (e) {
    logAndSend('Fatal error in handleDataInRequest: ' + e.message);
  }
};

module.exports.onStop = function() {
  logAndSend('Service stopping...');
};

module.exports.onExit = function() {
  logAndSend('Service exiting...');
};
