/**
 * findNvService() — unified host discovery for Tizen.
 * 
 * Tizen's WebAssembly sandbox cannot receive mDNS responses:
 *   - UDP multicast on port 5353 is intercepted by the system Avahi daemon and
 *     never delivered to WASM sockets, even with SO_REUSEPORT set.
 *   - Unicast mDNS replies are dropped by Tizen's SMACK stateful firewall because
 *     the query goes to 224.0.0.251 but the reply comes from the host's unicast IP,
 *     so the 5-tuple never matches an established conntrack entry.
 *   - Samsung's Tizen WRT has no mDNS/NetBIOS/local DNS support, making .local
 *     hostnames (e.g. MacBook-Pro.local from /serverinfo's <hostname>) unresolvable.
 * 
 * Instead, we perform a fast parallel HTTP scan of the /24 subnet. TCP fetch()
 * correctly establishes conntrack state, so replies are delivered normally.
 * Only port 47989 (Sunshine HTTP) is probed — 47984 (HTTPS/GFE) is skipped to
 * halve the number of parallel requests and avoid TLS certificate errors.
 * 
 * The mDNS browser of moonlight-chrome (chrome.sockets.udp) was removed in
 * Moonlight Plus 2.2.0, as it can never run on Tizen. If Samsung ever adds
 * mDNS support to the Tizen WRT, see the moonlight-chrome sources for it.
 */
function findNvService(ipString) {
  // Discovery is IPv4-only: Tizen has no mDNS/NetBIOS/local DNS to resolve
  // .local hostnames, and the HTTP subnet scanner only produces IPv4 addresses.
  var ip = ipString.replace('ipv4:', '');

  // Create a new NvHTTP object for the discovered host
  var discoveredHost = new NvHTTP(ip, myUniqueid);
  discoveredHost.httpPort = 47989;
  discoveredHost.httpsPort = 47984;

  // Poll the discovered host and verify host status before adding it
  discoveredHost.pollServer(function(returnedDiscoveredHost) {
    // If the host is offline, do not add it to the grid or update its stored IP
    if (!returnedDiscoveredHost.online) {
      return;
    }
    // Check if the host is already known by its server UID
    if (hosts[returnedDiscoveredHost.serverUid] != null) {
      // Host already known — update its stored IP if it has changed
      var existingAddress = hosts[returnedDiscoveredHost.serverUid].address;
      // Also check if the base URL is out of sync or stale compared to the discovered host
      var existingBaseUrl = hosts[returnedDiscoveredHost.serverUid]._baseUrlHttps;
      if (existingAddress !== returnedDiscoveredHost.address || existingBaseUrl !== returnedDiscoveredHost._baseUrlHttps) {
        var isIpv4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(existingAddress);
        // Do not overwrite IPv6 or DNS addresses if they are currently online
        if (!isIpv4 && hosts[returnedDiscoveredHost.serverUid].online && existingBaseUrl === returnedDiscoveredHost._baseUrlHttps) {
          console.log('%c[main.js, findNvService]', 'color: gray;', 'Keeping existing non-IPv4 address since it is online:', existingAddress);
        } else {
          // Update the stored address to the newly discovered IPv4 address
          console.log('%c[main.js, findNvService]', 'color: gray;', 'Updating address for server UID:', returnedDiscoveredHost.serverUid, 'from', existingAddress, 'to', returnedDiscoveredHost.address);
          hosts[returnedDiscoveredHost.serverUid].address = returnedDiscoveredHost.address;
          hosts[returnedDiscoveredHost.serverUid].localAddress = returnedDiscoveredHost.localAddress;
          hosts[returnedDiscoveredHost.serverUid]._baseUrlHttp = returnedDiscoveredHost._baseUrlHttp;
          hosts[returnedDiscoveredHost.serverUid]._baseUrlHttps = returnedDiscoveredHost._baseUrlHttps;
          updateMacAddress(returnedDiscoveredHost);
          if (typeof hosts[returnedDiscoveredHost.serverUid].updateExternalAddressIP4 === 'function') {
            hosts[returnedDiscoveredHost.serverUid].updateExternalAddressIP4();
          }
          saveHosts();
        }
      }
    } else {
      // New host — add to grid and begin background polling
      addHostToGrid(returnedDiscoveredHost, true);
      beginBackgroundPollingOfHost(returnedDiscoveredHost);
      saveHosts();
    }
  });
}

/**
 * Scan the /24 subnet for Sunshine/GFE hosts. For each IP that responds with
 * HTTP 200 on port 47989, findNvService() runs the full NvHTTP handshake and
 * registers the host in the UI. See the findNvService() comment above for why
 * mDNS is not used on Tizen.
 */
window.subnetScanAbortCtrl = null;
window.subnetScanPromise = null;

// Stop the scan that runs, if any. Returns whether a scan was running.
window.abortSubnetScan = function() {
  var wasRunning = !!window.subnetScanPromise;
  if (window.subnetScanAbortCtrl) {
    console.log('%c[main.js]', 'color: orange;', 'User initiated action: Aborting background subnet scan to free network stack.');
    window.subnetScanAbortCtrl.abort();
    window.subnetScanAbortCtrl = null;
  }
  return wasRunning;
};

function startSubnetScanner() {
  if (window.subnetScanPromise) {
    console.log('%c[main.js, startSubnetScanner]', 'color: orange;', 'Subnet scan already in progress, skipping new scan.');
    return window.subnetScanPromise;
  }

  window.subnetScanPromise = new Promise(function(resolve) {
    try {
      var localIp = (typeof webapis !== 'undefined' && webapis.network) ? webapis.network.getIp() : null;
      // If the local IP cannot be determined, skip the subnet scan to avoid unnecessary network traffic
      if (!localIp) {
        window.subnetScanPromise = null;
        return resolve();
      }
      
      var parts = localIp.split('.');
      // Check if the IP address is in the expected IPv4 format
      if (parts.length !== 4) {
        console.warn('%c[main.js, startSubnetScanner]', 'color: orange;', 'Unexpected IP format:', localIp);
        window.subnetScanPromise = null;
        return resolve();
      }
      
      var subnet = parts[0] + '.' + parts[1] + '.' + parts[2];
      console.log('%c[main.js, startSubnetScanner]', 'color: green;', 'Starting chunked subnet /24 scan on', subnet + '.0/24');
      
      if (window.subnetScanAbortCtrl) {
        window.subnetScanAbortCtrl.abort();
      }
      window.subnetScanAbortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      
      var IPs = [];
      for (var i = 1; i <= 254; i++) IPs.push(subnet + '.' + i);
      
      var index = 0;
      var activeCount = 0;
      var concurrency = 64; // Throttle to 64 to save Tizen's ARP queue
      
      function scanNext() {
        if (!window.subnetScanAbortCtrl || index >= IPs.length) {
          if (activeCount === 0) {
            window.subnetScanPromise = null;
            resolve();
          }
          return;
        }
        
        var ip = IPs[index++];
        activeCount++;
        
        var localAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timeoutId = setTimeout(function() {
          if (localAbort) localAbort.abort();
        }, 1000);
        
        var onGlobalAbort = function() {
          if (localAbort) localAbort.abort();
        };
        
        if (window.subnetScanAbortCtrl) {
          window.subnetScanAbortCtrl.signal.addEventListener('abort', onGlobalAbort);
        }
        
        fetch('http://' + ip + ':47989/serverinfo', localAbort ? { signal: localAbort.signal } : {})
          .then(function(res) {
            clearTimeout(timeoutId);
            if (res.ok) {
              console.log('%c[main.js, startSubnetScanner]', 'color: green;', 'Found host with IP address:', ip);
              findNvService('ipv4:' + ip);
            }
            if (window.subnetScanAbortCtrl) window.subnetScanAbortCtrl.signal.removeEventListener('abort', onGlobalAbort);
            activeCount--;
            scanNext();
          })
          .catch(function() {
            clearTimeout(timeoutId);
            if (window.subnetScanAbortCtrl) window.subnetScanAbortCtrl.signal.removeEventListener('abort', onGlobalAbort);
            activeCount--;
            scanNext();
          });
      }
      
      // Kick off the initial batch of 64 concurrent scans
      for (var c = 0; c < Math.min(concurrency, IPs.length); c++) {
        scanNext();
      }
    } catch (e) {
      console.error('%c[main.js, startSubnetScanner]', 'color: red;', 'Subnet scanner failed:', e);
      window.subnetScanPromise = null;
      resolve();
    }
  });
  return window.subnetScanPromise;
}
