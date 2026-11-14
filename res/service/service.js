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
// The longest route that a log line shows. A request can name a route of any length, and every line also goes to the
// app through the message port, where it lands in the diagnostic log.
var LOG_ROUTE_MAX_LENGTH = 80;
// How many lines about the requests of the server go to the app per minute: about the ones it didn't serve (a 404)
// and about the ones it served. Any device on the local network can send requests as fast as it likes, also during a
// stream, and the Smart Hub asks for each tile once in a while; the lines beyond a limit are only counted, and the next
// line of that kind that is sent says how many they were.
var REJECTED_LOG_LINES_PER_MINUTE = 5;
var SERVED_LOG_LINES_PER_MINUTE = 60;
var LOG_LIMIT_WINDOW_MS = 60000;

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
 * A route as a log line shows it: at most LOG_ROUTE_MAX_LENGTH characters.
 *
 * @param {string} route - Path of a request
 * @return {string} The route, cut where it is longer
 */
function shortenRoute(route) {
  var text = String(route);
  return text.length > LOG_ROUTE_MAX_LENGTH ? text.substring(0, LOG_ROUTE_MAX_LENGTH) + '... (' + text.length + ' characters)' : text;
}

/**
 * Makes a logAndSend() that sends at most maxLines lines per minute to the app. A line beyond that is dropped and
 * counted, and the next line that is sent names the count.
 *
 * @param {number} maxLines - Lines per LOG_LIMIT_WINDOW_MS
 * @return {function(string)} Logs and sends the message while the limit allows it
 */
function createLimitedLog(maxLines) {
  var windowStart = 0;
  var lines = 0;
  var skipped = 0;
  return function(value) {
    var now = Date.now();
    if (now - windowStart >= LOG_LIMIT_WINDOW_MS || now < windowStart) {
      windowStart = now;
      lines = 0;
    }
    if (lines >= maxLines) {
      skipped++;
      return;
    }
    lines++;
    if (skipped > 0) {
      value += ' (' + skipped + ' more lines of this kind were left out since the last one)';
      skipped = 0;
    }
    logAndSend(value);
  };
}

// Log a request that the server didn't serve, and one that it served
var logRejectedRequest = createLimitedLog(REJECTED_LOG_LINES_PER_MINUTE);
var logServedRequest = createLimitedLog(SERVED_LOG_LINES_PER_MINUTE);

/**
 * Whether a tile may map its route to the given file: only a file whose name is the file name of the route, e.g.
 * '/preview-881448767.jpg' to '/opt/usr/home/owner/content/Documents/preview-881448767.jpg', as the app sends it. The
 * preview data comes through an app control, which another app on the TV may be able to send, and the server sends
 * the mapped file to whoever on the local network asks for the route: with any path allowed, that was any file the
 * service can read.
 *
 * @param {string} route - Route of the tile, already checked against PREVIEW_ROUTE_PATTERN
 * @param {string} filePath - Path that the tile names for it
 * @return {boolean} Whether the file name of the path is the one of the route
 */
function isPreviewFileOfRoute(route, filePath) {
  return typeof filePath === 'string' && filePath.substring(filePath.lastIndexOf('/') + 1) === route.substring(1);
}

/**
 * Starts the local HTTP server that serves the box art images of the preview tiles.
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
    // Each request gets one line, through logRejectedRequest() or logServedRequest(), which limit how many of them
    // reach the app; before, every request sent up to five lines there, with a route of any length
    var routeMatch = PREVIEW_ROUTE_PATTERN.exec(route || '');
    if (!routeMatch) {
      logRejectedRequest('Rejected a request for a route that is not a preview file name: ' + shortenRoute(route));
      res.writeHead(404);
      res.end();
      return;
    }
    var fileName = routeMatch[1];
    // Only a route that a tile mapped (an own property: the route is a name that the request chose)
    if (Object.prototype.hasOwnProperty.call(routeMap, route)) {
      var imagePath = routeMap[route];
      try {
        var binaryData = fs.readFileSync(imagePath);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': binaryData.length
        });
        res.end(binaryData);
        logServedRequest('Successfully served binary image for ' + shortenRoute(route) + ' | Size: ' + Math.round(binaryData.length / 1024) + ' KB');
      } catch (err) {
        logRejectedRequest('Error reading binary image file for ' + shortenRoute(route) + ': ' + err.message);
        res.writeHead(404);
        res.end();
      }
    } else {
      // Fallback for TV reboots when memory routeMap is empty. The path is built from the checked file name only,
      // never from the request path
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
          logServedRequest('Successfully served fallback binary image from ' + shortenRoute(fallbackPaths[i]));
          return; // Exit on success
        } catch (fallbackErr) {
          // Ignore error and try the next path
        }
      }

      logRejectedRequest('Route not found in routeMap or fallbacks for: ' + shortenRoute(route));
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
                  // Map only the routes the server answers (PREVIEW_ROUTE_PATTERN), and each one only to a file
                  // with the file name of the route (isPreviewFileOfRoute()). Any other route is served from the
                  // documents directory by its file name, like after a reboot of the TV.
                  if (!PREVIEW_ROUTE_PATTERN.test(route || '')) {
                    logAndSend('Ignored the image route ' + shortenRoute(route) + ', which is not a preview file name');
                  } else if (!isPreviewFileOfRoute(route, tile.txtPath)) {
                    logAndSend('Not mapping the route ' + route + ' to ' + shortenRoute(tile.txtPath) + ', whose file name is not the one of the route');
                  } else {
                    routeMap[route] = tile.txtPath;
                    logAndSend('Mapped route ' + route + ' to ' + shortenRoute(tile.txtPath));
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
