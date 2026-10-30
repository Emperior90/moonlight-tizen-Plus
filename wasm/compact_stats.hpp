#pragma once
// The three levels of the performance statistics overlay (Off, Compact, Full) and the message of the compact line. The
// YELLOW key of the remote, the Stream Menu, the gamepad combo and the keyboard combo all call TogglePerformanceStats()
// in wasm/wasmplayer.cpp, which steps to the next level with CyclePerformanceStatsLevel() and tells the front end the new
// level with FormatPerformanceStatsLevelMessage(). While the level is Compact, the video decoder thread sends the figures
// of the last two stats windows as a small JSON object (FormatCompactStatsMessage()) instead of the text of the full
// statistics, and handleMessage() in wasm/platform/messages.js builds the line from it, so it never parses the
// translated text, e.g.
//   4K60 HEVC HDR · 59.9 fps · 74 Mb/s · RTT 3 ms · Net drops 0.1% · Wait+pacing 6.3 ms
// While the level is Full, the text of the full statistics follows the figures of one point of their graph in the same
// message (FormatFullStatsMessage()), so the graph needs no message of its own either.
// The compact line was asked for in upstream issue #67, and Artemis, StreamLight and moonlight-tv (f4b1a4a) show one;
// sending figures beside the text follows the fork of fidoboy (moonlight-tizen-ac3, 262477c, 'GraphMsg: ').
// The header has no other dependencies, so the native tests can check it on its own (tests/native/compact_stats_test.cpp).

#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>

constexpr int kPerformanceStatsOff = 0;
constexpr int kPerformanceStatsCompact = 1;
constexpr int kPerformanceStatsFull = 2;

// The level for a value of the front end (the setting passed to startStream()), Off for anything unknown
inline int ClampPerformanceStatsLevel(int level) {
  return level >= kPerformanceStatsOff && level <= kPerformanceStatsFull ? level : kPerformanceStatsOff;
}

// The level after a press of the stats key: Off, Compact, Full, Off, ...
inline int NextPerformanceStatsLevel(int level) {
  return (ClampPerformanceStatsLevel(level) + 1) % (kPerformanceStatsFull + 1);
}

// Step the level to the next one in one atomic step and return the new level. The remote (main thread) and the gamepad
// combo (gamepad thread) can press at the same time, and each press moves exactly one level (compare_exchange_weak()
// leaves the value it found in `current` when another thread changed it first).
inline int CyclePerformanceStatsLevel(std::atomic<int>& level) {
  int current = level.load();
  while (!level.compare_exchange_weak(current, NextPerformanceStatsLevel(current))) {
  }
  return NextPerformanceStatsLevel(current);
}

// Message to the front end with the level after a toggle, e.g. "StatLevelMsg: 1"
inline std::string FormatPerformanceStatsLevelMessage(int level) {
  return "StatLevelMsg: " + std::to_string(ClampPerformanceStatsLevel(level));
}

// The figures of the compact line
struct CompactVideoStats {
  // The stream as configured: resolution and frame rate
  uint32_t width;
  uint32_t height;
  uint32_t fps;
  // "H.264", "HEVC" or "AV1", 10-bit, and whether the host display is in HDR mode
  const char* codec;
  bool tenBit;
  bool hdr;
  // The frames handed to the video player per second, and the bitrate received, in Mbps
  float renderedFps;
  float bitrateMbps;
  // Round-trip time of the connection in ms, 0 while unknown
  uint32_t rttMs;
  // Frames lost on the network out of all frames of the windows, in percent, negative while there are none
  float networkDropPercent;
  // Average time a frame waited for the video thread plus the frame pacing delay, in ms, negative while no frame was
  // rendered (the 'Average frame wait time' and 'Average frame pacing delay' lines of the full statistics)
  float waitPacingMs;
};

// Write a number with the given decimals into a JSON value, or null for an unknown (negative) or invalid figure
inline int FormatCompactStatsNumber(char* output, size_t length, double value, int decimals) {
  if (!std::isfinite(value) || value < 0) {
    return snprintf(output, length, "null");
  }
  return snprintf(output, length, "%.*f", decimals, value);
}

// Write the message of the compact line, e.g.
//   StatCompactMsg: {"w":3840,"h":2160,"fps":60,"codec":"HEVC","bits":10,"hdr":1,"rfps":59.94,"mbps":74.2,
//   "rtt":3,"drop":0.10,"delay":6.3}
// (on one line). Returns the number of characters written, or -1 if the output is too short.
inline int FormatCompactStatsMessage(const CompactVideoStats& stats, char* output, size_t length) {
  char rendered[24];
  char bitrate[24];
  char rtt[16];
  char drop[24];
  char delay[24];
  FormatCompactStatsNumber(rendered, sizeof(rendered), stats.renderedFps, 2);
  FormatCompactStatsNumber(bitrate, sizeof(bitrate), stats.bitrateMbps, 1);
  if (stats.rttMs != 0) {
    snprintf(rtt, sizeof(rtt), "%u", stats.rttMs);
  } else {
    snprintf(rtt, sizeof(rtt), "null");
  }
  FormatCompactStatsNumber(drop, sizeof(drop), stats.networkDropPercent, 2);
  FormatCompactStatsNumber(delay, sizeof(delay), stats.waitPacingMs, 1);
  const int ret = snprintf(output, length,
    "StatCompactMsg: {\"w\":%u,\"h\":%u,\"fps\":%u,\"codec\":\"%s\",\"bits\":%d,\"hdr\":%d,\"rfps\":%s,\"mbps\":%s,"
    "\"rtt\":%s,\"drop\":%s,\"delay\":%s}",
    stats.width, stats.height, stats.fps, stats.codec != nullptr ? stats.codec : "", stats.tenBit ? 10 : 8,
    stats.hdr ? 1 : 0, rendered, bitrate, rtt, drop, delay);
  if (ret < 0 || (size_t)ret >= length) {
    if (length > 0) {
      output[0] = 0;
    }
    return -1;
  }
  return ret;
}

// The figures of one point of the graph of the full statistics: the round-trip time in ms, 0 while unknown, and the
// frames lost on the network in the stats window that just ended. The front end draws the last 60 of them under the
// text (drawStatsGraph() in wasm/platform/messages.js), which the graph of the fork of fidoboy (moonlight-tizen-ac3,
// 262477c, 5bc0c57) suggested; the points come with the text of the full statistics instead of a message of their own.
struct StatsGraphPoint {
  uint32_t rttMs;
  uint32_t networkDroppedFrames;
};

// Write the message of the full statistics: the figures of the graph as a small JSON object on the first line, then the
// text, e.g.
//   StatMsg: {"rtt":3,"lost":0}
//   Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)
//   ...
// An unknown round-trip time is null.
inline std::string FormatFullStatsMessage(const StatsGraphPoint& point, const char* text) {
  char figures[64];
  if (point.rttMs != 0) {
    snprintf(figures, sizeof(figures), "{\"rtt\":%u,\"lost\":%u}\n", point.rttMs, point.networkDroppedFrames);
  } else {
    snprintf(figures, sizeof(figures), "{\"rtt\":null,\"lost\":%u}\n", point.networkDroppedFrames);
  }
  return std::string("StatMsg: ") + figures + (text != nullptr ? text : "");
}
