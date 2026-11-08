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

#include <atomic>
#include <cstdint>

class HostEncoderRestarts {
 public:
  // How far apart the message of a restart and its keyframe may arrive and still belong together
  static constexpr uint64_t kKeyframeWindowMs = 1000;

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
    // 0 stands for no restart
    m_RestartMs.store(nowMs != 0 ? nowMs : 1);
    return true;
  }

  // The decoder thread: an IDR frame that no request of this client explains arrived at nowMs. Returns whether it is the
  // keyframe of a restart whose message arrived at most kKeyframeWindowMs before (or a moment after the clock of the
  // keyframe was read). Otherwise the caller counts it as a recovery, and LateRestartKeyframe() reports it if the
  // message of a restart follows within kKeyframeWindowMs.
  bool IsRestartKeyframe(uint64_t nowMs) {
    uint64_t restartMs = m_RestartMs.load();
    const uint64_t apart = nowMs >= restartMs ? nowMs - restartMs : restartMs - nowMs;
    if (restartMs != 0 && apart <= kKeyframeWindowMs && m_RestartMs.compare_exchange_strong(restartMs, 0)) {
      m_RecoveryKeyframeMs = 0;
      return true;
    }
    m_RecoveryKeyframeMs = nowMs != 0 ? nowMs : 1;
    return false;
  }

  // The decoder thread, for every frame: returns true once when the last keyframe that counted as a recovery turned out
  // to be the keyframe of a restart, whose message arrived after it, within kKeyframeWindowMs. The caller then no longer
  // counts it as a recovery.
  bool LateRestartKeyframe(uint64_t nowMs) {
    if (m_RecoveryKeyframeMs == 0) {
      return false;
    }
    uint64_t restartMs = m_RestartMs.load();
    if (restartMs != 0 && restartMs >= m_RecoveryKeyframeMs && restartMs - m_RecoveryKeyframeMs <= kKeyframeWindowMs &&
        m_RestartMs.compare_exchange_strong(restartMs, 0)) {
      m_RecoveryKeyframeMs = 0;
      return true;
    }
    // No message can belong to it any more
    if (nowMs > m_RecoveryKeyframeMs + kKeyframeWindowMs) {
      m_RecoveryKeyframeMs = 0;
    }
    return false;
  }

  // The restarts of the encoder in this stream
  uint32_t Restarts() const {
    return m_Restarts.load();
  }

 private:
  std::atomic<uint32_t> m_Messages{0};
  std::atomic<uint32_t> m_Restarts{0};
  // When the message of a restart arrived that no keyframe answered yet, or 0
  std::atomic<uint64_t> m_RestartMs{0};
  // Decoder thread only: when the last keyframe that counted as a recovery arrived, while a later message of a restart
  // may still claim it, or 0
  uint64_t m_RecoveryKeyframeMs = 0;
};

// The restarts of the encoder of the host in the current stream
inline HostEncoderRestarts& GetHostEncoderRestarts() {
  static HostEncoderRestarts restarts;
  return restarts;
}
