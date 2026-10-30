#pragma once
// The native part of the diagnostic log (Settings > About > Diagnostic log): the lines that the module logs with
// MoonlightInstance::ClLogMessage() (connectionlistener.cpp), its own and those of moonlight-common-c, kept in memory in a
// ring of fixed size until the front end takes them with takeDiagnosticLog() (main.cpp) into the log of the current
// session (wasm/platform/diagnostics.js). Nothing is written to a file or sent anywhere.
// The lines come from every thread of the module, among them the video decoder, audio and receive threads, which must
// never wait for the log: a line takes the lock with try_lock, and a line that finds it taken (by another line, or by the
// front end taking the lines) is left out and counted instead, and the count goes in with the next line that gets in. A
// line that repeats the one before within kRepeatWindowMs is counted as well instead of kept again, so that a flood of one
// condition doesn't push out the lines before it. When the ring is full, the oldest line goes.
// The ring and the repeat filter follow diagnostic_log.cpp and log_repeat_filter.hpp of the fork of mmadej20
// (moonlight-tizen-modern), with fixed slots instead of a queue of strings, so that a line costs no allocation. The
// header has no other dependencies, so the native tests can check it on its own (tests/native/diagnostic_log_test.cpp).

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>

class DiagnosticLogRing {
 public:
  // Lines kept, and the bytes of each one: a longer line is cut at a character boundary
  static constexpr size_t kSlots = 256;
  static constexpr size_t kLineBytes = 240;
  // A line that repeats the line before within this time is counted instead of kept
  static constexpr uint64_t kRepeatWindowMs = 1000;

  // Keep a line that was logged at timeMs (the wall clock in milliseconds, like Date.now() of the page). A line break at
  // its end is dropped, and one within it becomes a space. Returns false if the line was left out because the lock was
  // taken; a repeated line counts as kept.
  bool TryAppend(uint64_t timeMs, const char* message) {
    std::unique_lock<std::mutex> lock(m_Mutex, std::try_to_lock);
    if (!lock.owns_lock()) {
      m_Busy.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    char text[kLineBytes];
    CopyLine(message, text);
    if (m_HasLast && timeMs - m_LastTimeMs < kRepeatWindowMs && std::strcmp(text, m_LastText) == 0) {
      m_Repeats++;
      return true;
    }
    FlushNotes(timeMs);
    Push(timeMs, text);
    std::memcpy(m_LastText, text, sizeof(text));
    m_LastTimeMs = timeMs;
    m_HasLast = true;
    return true;
  }

  // Take the kept lines, oldest first, and empty the ring: one line per record, "<timeMs>\t<text>\n". The notes about
  // repeated, busy and overwritten lines are lines of their own.
  std::string Take() {
    std::lock_guard<std::mutex> lock(m_Mutex);
    FlushNotes(m_LastTimeMs);
    std::string result;
    if (m_Overwritten > 0) {
      char note[96];
      std::snprintf(note, sizeof(note), "%u older lines of the native log were overwritten", m_Overwritten);
      AppendRecord(&result, m_Count > 0 ? m_Slots[Oldest()].timeMs : m_LastTimeMs, note);
      m_Overwritten = 0;
    }
    for (size_t i = 0; i < m_Count; ++i) {
      const Slot& slot = m_Slots[(Oldest() + i) % kSlots];
      AppendRecord(&result, slot.timeMs, slot.text);
    }
    m_Count = 0;
    return result;
  }

  // Lines left out so far because the lock was taken, which the next kept line reports (for the tests)
  uint32_t BusyCount() const {
    return m_Busy.load(std::memory_order_relaxed);
  }

 private:
  struct Slot {
    uint64_t timeMs;
    char text[kLineBytes];
  };

  // Copy a message into a slot: the line break at its end dropped, the others and tabs turned into spaces, and the end
  // cut so that it still ends on a whole UTF-8 character
  static void CopyLine(const char* message, char* text) {
    size_t length = 0;
    if (message != nullptr) {
      while (message[length] != '\0' && length < kLineBytes - 1) {
        const char c = message[length];
        text[length] = (c == '\n' || c == '\r' || c == '\t') ? ' ' : c;
        length++;
      }
      if (message[length] != '\0') {
        // Cut: drop the last character if it doesn't fit whole, found from its lead byte before the continuation bytes
        size_t lead = length;
        while (lead > 0 && (static_cast<unsigned char>(text[lead - 1]) & 0xC0) == 0x80) {
          lead--;
        }
        if (lead > 0 && (static_cast<unsigned char>(text[lead - 1]) & 0xC0) == 0xC0) {
          const unsigned char byte = static_cast<unsigned char>(text[lead - 1]);
          const size_t bytes = byte >= 0xF0 ? 4 : (byte >= 0xE0 ? 3 : 2);
          if (lead - 1 + bytes > length) {
            length = lead - 1;
          }
        }
      }
    }
    while (length > 0 && text[length - 1] == ' ') {
      length--;
    }
    text[length] = '\0';
  }

  size_t Oldest() const {
    return (m_Next + kSlots - m_Count) % kSlots;
  }

  void Push(uint64_t timeMs, const char* text) {
    Slot& slot = m_Slots[m_Next];
    slot.timeMs = timeMs;
    std::strncpy(slot.text, text, kLineBytes - 1);
    slot.text[kLineBytes - 1] = '\0';
    m_Next = (m_Next + 1) % kSlots;
    if (m_Count < kSlots) {
      m_Count++;
    } else {
      m_Overwritten++;
    }
  }

  // Keep the notes about the repeats of the line before and the lines left out while the lock was taken
  void FlushNotes(uint64_t timeMs) {
    char note[96];
    if (m_Repeats > 0) {
      std::snprintf(note, sizeof(note), "(the line before came %u more times)", m_Repeats);
      Push(m_LastTimeMs, note);
      m_Repeats = 0;
    }
    const uint32_t busy = m_Busy.exchange(0, std::memory_order_relaxed);
    if (busy > 0) {
      std::snprintf(note, sizeof(note), "%u lines of the native log were left out while it was busy", busy);
      Push(timeMs, note);
    }
  }

  static void AppendRecord(std::string* out, uint64_t timeMs, const char* text) {
    out->append(std::to_string(timeMs));
    out->push_back('\t');
    out->append(text);
    out->push_back('\n');
  }

  std::mutex m_Mutex;
  Slot m_Slots[kSlots] = {};
  size_t m_Next = 0;
  size_t m_Count = 0;
  uint32_t m_Overwritten = 0;
  uint32_t m_Repeats = 0;
  std::atomic<uint32_t> m_Busy{0};
  char m_LastText[kLineBytes] = {};
  uint64_t m_LastTimeMs = 0;
  bool m_HasLast = false;
};

// The ring of the module
inline DiagnosticLogRing& GetDiagnosticLog() {
  static DiagnosticLogRing ring;
  return ring;
}

// The wall clock in milliseconds, which Date.now() of the page also reads, so that the front end can merge the native
// lines with its own
inline uint64_t DiagnosticLogNowMs() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()).count());
}
