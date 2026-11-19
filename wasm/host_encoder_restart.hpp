#pragma once

// Tells the keyframe of a restart of the video encoder of the host apart from a keyframe that recovers the stream after
// a loss, for the count of recovery keyframes of the statistics and the session report (wasmplayer.cpp). Sunshine sends
// the HDR mode of the stream over the control stream each time it creates a video encoder, also for an SDR stream: at
// the start of the stream, and again when it rebuilds the encoder during the stream, e.g. after a change of the display,
// of HDR or of the desktop on the PC (video.cpp and stream.cpp of Sunshine). moonlight-common-c passes every such
// message on to setHdrMode() (ControlStream.c), whether the mode changed or not. The new encoder starts with a keyframe
// that no loss and no request of the TV asked for. Its message and its keyframe take different ways (the control stream
// and the video stream), so either can arrive first.
//
// The message side runs on the thread of the callbacks of the control stream, the keyframe side on the decoder thread.
//
// The times are kept as the lower 32 bits of the millisecond clock (LiGetMillis()), so that the message of a restart
// can be claimed with a 4-byte compare-exchange. The runtime of Samsung's Emscripten 1.39 (fastcomp) gets the 8-byte
// one wrong: it swaps the value, but reports the lowest bit of the old value instead of whether it swapped. With a
// 64-bit time the keyframe of every restart whose message arrived at an even millisecond counted as a recovery
// (tests/unit/native-atomics.test.js explains the defect and keeps it out of the native code). The differences of two
// times are taken modulo 2^32, so they stay right when the lower 32 bits wrap (every 49.7 days of the clock).

#include <atomic>
#include <cstdint>

class HostEncoderRestarts {
 public:
  // How far apart the message of a restart and its keyframe may arrive and still belong together
  static constexpr uint32_t kKeyframeWindowMs = 1000;

  // A new stream, before its control stream connects
  void Reset() {
    m_Messages.store(0);
    m_Restarts.store(0);
    m_RestartMs.store(0);
    m_RecoveryKeyframeMs = 0;
  }

  // An HDR mode message of the host arrived at nowMs. Returns whether it reports a restart of the encoder, which every
  // message after the first of the stream does.
  bool OnHdrModeMessage(uint64_t nowMs) {
    if (m_Messages.fetch_add(1) == 0) {
      return false;
    }
    m_Restarts.fetch_add(1);
    m_RestartMs.store(Stamp(nowMs));
    return true;
  }

  // The decoder thread: an IDR frame that no request of this client explains arrived at nowMs. Returns whether it is the
  // keyframe of a restart whose message arrived at most kKeyframeWindowMs before (or a moment after the clock of the
  // keyframe was read). Otherwise the caller counts it as a recovery, and LateRestartKeyframe() reports it if the
  // message of a restart follows within kKeyframeWindowMs.
  bool IsRestartKeyframe(uint64_t nowMs) {
    const uint32_t keyframeMs = Stamp(nowMs);
    uint32_t restartMs = m_RestartMs.load();
    if (restartMs != 0 && Apart(keyframeMs, restartMs) <= kKeyframeWindowMs &&
        m_RestartMs.compare_exchange_strong(restartMs, 0)) {
      m_RecoveryKeyframeMs = 0;
      return true;
    }
    m_RecoveryKeyframeMs = keyframeMs;
    return false;
  }

  // The decoder thread, for every frame: returns true once when the last keyframe that counted as a recovery turned out
  // to be the keyframe of a restart, whose message arrived within kKeyframeWindowMs of it. That message was stored
  // after the keyframe found none, usually because it arrived later, but its time can also be a moment before the
  // keyframe's: the control thread reads the clock before it stores the message, and the decoder thread can read its
  // clock and find no message in between. So the difference counts either way, as in IsRestartKeyframe(). The caller
  // then no longer counts the keyframe as a recovery.
  bool LateRestartKeyframe(uint64_t nowMs) {
    if (m_RecoveryKeyframeMs == 0) {
      return false;
    }
    uint32_t restartMs = m_RestartMs.load();
    if (restartMs != 0 && Apart(restartMs, m_RecoveryKeyframeMs) <= kKeyframeWindowMs &&
        m_RestartMs.compare_exchange_strong(restartMs, 0)) {
      m_RecoveryKeyframeMs = 0;
      return true;
    }
    // No message can belong to it any more
    if (Apart(Stamp(nowMs), m_RecoveryKeyframeMs) > kKeyframeWindowMs) {
      m_RecoveryKeyframeMs = 0;
    }
    return false;
  }

  // The restarts of the encoder in this stream
  uint32_t Restarts() const {
    return m_Restarts.load();
  }

 private:
  // The lower 32 bits of a time of the clock, where 0 stands for none: a time of 0 counts as 1
  static uint32_t Stamp(uint64_t ms) {
    const uint32_t stamp = static_cast<uint32_t>(ms);
    return stamp != 0 ? stamp : 1;
  }

  // How far apart two such times are, either way, also when the lower 32 bits wrapped between them
  static uint32_t Apart(uint32_t a, uint32_t b) {
    const uint32_t forward = a - b;
    const uint32_t backward = b - a;
    return forward < backward ? forward : backward;
  }

  std::atomic<uint32_t> m_Messages{0};
  std::atomic<uint32_t> m_Restarts{0};
  // When the message of a restart arrived that no keyframe answered yet, or 0
  std::atomic<uint32_t> m_RestartMs{0};
  // Decoder thread only: when the last keyframe that counted as a recovery arrived, while a later message of a restart
  // may still claim it, or 0
  uint32_t m_RecoveryKeyframeMs = 0;
};

// The restarts of the encoder of the host in the current stream
inline HostEncoderRestarts& GetHostEncoderRestarts() {
  static HostEncoderRestarts restarts;
  return restarts;
}
