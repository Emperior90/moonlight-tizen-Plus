'use strict';

// The full statistics with every line that the module can send at once (FormatVideoStats() in wasm/wasmplayer.cpp),
// with wide figures: the largest box of the full statistics, for the layout checks of stats-overlay.test.js,
// stream-menu.test.js and snackbar.test.js
const FULL_TEXT = 'Video stream: 3840x2160 119.88 FPS (Codec: HEVC 10-bit HDR)\n' +
  'Incoming frame rate from network: 119.88 FPS\n' +
  'Decoding frame rate: 119.88 FPS\n' +
  'Rendering frame rate: 119.88 FPS\n' +
  'Bitrate: 148.52 Mbps video received, 150.0 Mbps configured (with FEC and audio)\n' +
  'Host frame rate (30 s): 119.88 FPS\n' +
  'Host processing latency min/max/average: 4.1/12.9/6.3 ms\n' +
  'Frames dropped by your network connection: 0.42%\n' +
  'Average network latency: 12 ms (variance: 3 ms)\n' +
  'Average frame receive time: 13.21 ms (159% of the frame time)\n' +
  'Frames arrive at: 1234 Mbps\n' +
  'Average frame wait time: 0.42 ms\n' +
  'Average frame pacing delay: 5.87 ms\n' +
  'Average rendering time: 0.31 ms\n' +
  'Longest frame times (ms): receive 125.3, wait 16.7, pacing 33.4, rendering 16.8\n' +
  'Pending frames: 1 (max 3)\n' +
  'Host frame intervals: deviation 0.47 ms, p95 17.0 ms, 0.0% off cadence\n' +
  'TV player frame intervals: deviation 1.92 ms, p95 19.4 ms, 3.1% off cadence\n' +
  'Session frames dropped by network: 1234 (0.42%)\n' +
  'Session frames dropped by the TV: 12 (video pipeline resets: 1)\n' +
  'Session recovery keyframes: 17\n' +
  'TV player rejections: buffer full 12 (10 recovered), keyframe required 3, track not ready 2, other 1 (last code -5)\n' +
  'Session FEC recoveries: 1234 blocks, 5678 packets (longest 12 ms, 3 slow, 2 failed)\n' +
  'Worst FEC block: 18 of 20 parity packets used\n' +
  'Audio stream: Opus 7.1 surround (8 channels), 10 ms packets, 450 kbps\n' +
  'Audio CPU: decode 104.21 ms/s (max 2.31 ms), output 66.42 ms/s (max 22.31 ms)\n' +
  'Session audio packets lost by network: 123/456789 (0.03%)\n' +
  'Session audio decode errors: 2, TV audio player rejections: 3\n' +
  'WASM heap top: 96 of 128 MB (+12 MB this stream)\n';

module.exports = { FULL_TEXT };
