#pragma once
// The native part of the diagnostic log (Settings > About > Diagnostic log): the lines that the module logs, its own with
// MoonlightInstance::ClLogMessage() and those of moonlight-common-c with MoonlightInstance::ClLibraryLogMessage() (both in
// connectionlistener.cpp; the build sends Limelog() of the library there with LC_LOG, see CMakeLists.txt), kept in memory
// in a ring of fixed size until the front end takes them with takeDiagnosticLog() (main.cpp) into the log of the current
// session (wasm/platform/diagnostics.js). Nothing is written to a file or sent anywhere.
// The lines come from every thread of the module, among them the video decoder, audio and receive threads, which must
// never wait for the log: a line takes the lock with try_lock, and a line that finds it taken (by another line, or by the
// front end taking the lines) is left out and counted instead, and the count goes in with the next line that gets in. A
// line that repeats the one before within kRepeatWindowMs is counted as well instead of kept again, so that a flood of one
// condition doesn't push out the lines before it. When the ring is full, the oldest line goes.
// The lines of moonlight-common-c are also limited by their kind, since some of them come once per lost packet or frame
// with another number each time, which the repeat filter doesn't catch: see TryAppendLimited().
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

// The wall clock in milliseconds, which Date.now() of the page also reads, so that the front end can merge the native
// lines with its own
inline uint64_t DiagnosticLogNowMs() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()).count());
}

class DiagnosticLogRing {
 public:
  // Lines kept, and the bytes of each one: a longer line is cut at a character boundary
  static constexpr size_t kSlots = 256;
  static constexpr size_t kLineBytes = 240;
  // A line that repeats the line before within this time is counted instead of kept
  static constexpr uint64_t kRepeatWindowMs = 1000;
  // The lines of moonlight-common-c (TryAppendLimited()): the lines of one kind that are kept in a row, the time after
  // which one more of that kind is kept, and the kinds that are told apart at a time. Apart from its stages, a start
  // and a stop of a stream log about 20 kinds, and the loss of packets about 30 more, so in practice every kind has an
  // entry of its own.
  static constexpr uint32_t kKindBurst = 10;
  static constexpr uint64_t kKindRefillMs = 60000;
  static constexpr size_t kKinds = 64;

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
    CopyLine(message, text, kLineBytes);
    Keep(timeMs, text);
    return true;
  }

  // Keep a line of moonlight-common-c like TryAppend() does, limited by its kind. Some lines of the library come once per
  // lost packet or frame, e.g. "Recovered 1 video data shards from frame 4521" on a network that loses a packet now and
  // then, and would push every other line out of the log of a session. The kind of a line is its text without its
  // numbers. A kind may keep kKindBurst lines, and one more per kKindRefillMs, up to kKindBurst again. A line beyond that
  // is left out and counted, and the next line of the kind that is kept says how many were. When a kind ends while lines
  // of it are left out, the last of them is kept late, by Take(), with their count. So a kind adds kKindBurst lines and
  // then at most two per kKindRefillMs, however often it is logged, and no count is lost. The entries of the kinds are
  // shared without ever adding to what may be kept (FindKind()), so the same holds for any number of kinds that take
  // turns: at most kKinds times as much.
  // Returns false if the line was left out because the lock was taken; a line that its kind leaves out counts as kept.
  bool TryAppendLimited(uint64_t timeMs, const char* message) {
    std::unique_lock<std::mutex> lock(m_Mutex, std::try_to_lock);
    if (!lock.owns_lock()) {
      m_Busy.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    char text[kLineBytes];
    CopyLine(message, text, kLineBytes);
    Kind* kind = FindKind(HashKind(text), timeMs);
    if (kind == nullptr) {
      m_OtherLeftOut++;
      return true;
    }
    kind->lastMs = timeMs;
    if (kind->allowed == 0) {
      kind->leftOut++;
      std::memcpy(kind->lastLeftOut, text, sizeof(text));
      return true;
    }
    // A repeat of the line before is counted with that line and doesn't use up its kind
    if (!IsRepeat(timeMs, text)) {
      kind->allowed--;
      if (kind->leftOut > 0) {
        char note[64];
        std::snprintf(note, sizeof(note), " (%u similar lines before it were left out)", kind->leftOut);
        AppendNote(text, note);
        kind->leftOut = 0;
      }
    }
    Keep(timeMs, text);
    return true;
  }

  // Take the kept lines, oldest first, and empty the ring: one line per record, "<timeMs>\t<text>\n". The notes about
  // repeated, busy and overwritten lines are lines of their own. nowMs is the wall clock: the lines of moonlight-common-c
  // that their kind left out and that no later line of the kind reported within kKindRefillMs are reported here, by the
  // last of them (TryAppendLimited()), and so are those that found no entry for their kind (FindKind()).
  std::string Take(uint64_t nowMs) {
    std::lock_guard<std::mutex> lock(m_Mutex);
    for (Kind& kind : m_Kinds) {
      if (kind.leftOut > 0 && nowMs >= kind.lastMs && nowMs - kind.lastMs >= kKindRefillMs) {
        KeepLeftOut(&kind, nowMs);
      }
    }
    FlushNotes(m_LastTimeMs);
    if (m_OtherLeftOut > 0) {
      char note[96];
      std::snprintf(note, sizeof(note), "%u more lines of moonlight-common-c were left out (too many kinds at a time)",
                    m_OtherLeftOut);
      Push(nowMs, note);
      m_OtherLeftOut = 0;
    }
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

  // Take the kept lines now (takeDiagnosticLog() of main.cpp)
  std::string Take() {
    return Take(DiagnosticLogNowMs());
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

  // A kind of line of moonlight-common-c (TryAppendLimited())
  struct Kind {
    // The hash of the text without its numbers, 0 for an entry that isn't used
    uint64_t hash;
    // The time of the last line of the kind, kept or left out, and the time up to which 'allowed' was counted up
    uint64_t lastMs;
    uint64_t refillMs;
    // The lines of the kind that may be kept now, and those left out since the last kept one, with the last of them
    uint32_t allowed;
    uint32_t leftOut;
    char lastLeftOut[kLineBytes];
  };

  // Copy a message into a line of at most capacity bytes with its end: the line break at its end dropped, the others
  // and tabs turned into spaces, and the end cut so that it still ends on a whole UTF-8 character
  static void CopyLine(const char* message, char* text, size_t capacity) {
    size_t length = 0;
    if (message != nullptr) {
      while (message[length] != '\0' && length < capacity - 1) {
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

  // Add a note to the end of a line of kLineBytes, which is cut for it if the two don't fit
  static void AppendNote(char* text, const char* note) {
    const size_t noteLength = std::strlen(note);
    if (std::strlen(text) + noteLength > kLineBytes - 1) {
      char cut[kLineBytes];
      CopyLine(text, cut, kLineBytes - noteLength);
      std::memcpy(text, cut, sizeof(cut));
    }
    std::memcpy(text + std::strlen(text), note, noteLength + 1);
  }

  // Whether a line repeats the line that was kept before it within kRepeatWindowMs
  bool IsRepeat(uint64_t timeMs, const char* text) const {
    return m_HasLast && timeMs - m_LastTimeMs < kRepeatWindowMs && std::strcmp(text, m_LastText) == 0;
  }

  // Keep a line of kLineBytes, or count it if it repeats the line before
  void Keep(uint64_t timeMs, const char* text) {
    if (IsRepeat(timeMs, text)) {
      m_Repeats++;
      return;
    }
    FlushNotes(timeMs);
    Push(timeMs, text);
    std::memcpy(m_LastText, text, kLineBytes);
    m_LastTimeMs = timeMs;
    m_HasLast = true;
  }

  // The kind of a line: a hash (FNV-1a) of its text with each number replaced by one sign, never 0
  static uint64_t HashKind(const char* text) {
    uint64_t hash = 14695981039346656037ull;
    bool inNumber = false;
    for (const char* c = text; *c != '\0'; ++c) {
      const bool digit = *c >= '0' && *c <= '9';
      if (!digit || !inNumber) {
        hash = (hash ^ static_cast<unsigned char>(digit ? '#' : *c)) * 1099511628211ull;
      }
      inNumber = digit;
    }
    return hash != 0 ? hash : 1;
  }

  // The entry of a kind, with the lines that it may keep counted up to timeMs. A new kind takes an entry that isn't used.
  // When there is none, it takes over the entry whose last line is the oldest among those that may keep a line, as it
  // is: with what that entry may keep, not with kKindBurst lines of its own, or kinds that take turns in an entry would
  // keep every line (the last of the lines that the earlier kind left out, if any, is kept first). When no entry may
  // keep a line, there is none for a new kind (nullptr), and its lines are only counted until one may again.
  Kind* FindKind(uint64_t hash, uint64_t timeMs) {
    Kind* unused = nullptr;
    for (Kind& kind : m_Kinds) {
      if (kind.hash == hash) {
        RefillKind(&kind, timeMs);
        return &kind;
      }
      if (kind.hash == 0 && unused == nullptr) {
        unused = &kind;
      }
    }
    if (unused != nullptr) {
      unused->hash = hash;
      unused->lastMs = timeMs;
      unused->refillMs = timeMs;
      unused->allowed = kKindBurst;
      unused->leftOut = 0;
      return unused;
    }
    Kind* oldest = nullptr;
    for (Kind& kind : m_Kinds) {
      RefillKind(&kind, timeMs);
      if (kind.allowed > 0 && (oldest == nullptr || kind.lastMs < oldest->lastMs)) {
        oldest = &kind;
      }
    }
    if (oldest == nullptr) {
      return nullptr;
    }
    if (oldest->leftOut > 0) {
      KeepLeftOut(oldest, timeMs);
    }
    oldest->hash = hash;
    oldest->lastMs = timeMs;
    return oldest;
  }

  // Count up the lines of a kind that may be kept: one more per kKindRefillMs, up to kKindBurst
  static void RefillKind(Kind* kind, uint64_t timeMs) {
    if (timeMs < kind->refillMs) {
      // The clock of the TV was set back
      kind->refillMs = timeMs;
      return;
    }
    const uint64_t periods = (timeMs - kind->refillMs) / kKindRefillMs;
    if (periods > 0) {
      kind->allowed = periods >= kKindBurst - kind->allowed ? kKindBurst : kind->allowed + static_cast<uint32_t>(periods);
      kind->refillMs += periods * kKindRefillMs;
    }
  }

  // Keep the last of the lines that a kind left out, with their count and its age, at timeMs
  void KeepLeftOut(Kind* kind, uint64_t timeMs) {
    char note[96];
    std::snprintf(note, sizeof(note), " (the last of %u similar lines that were left out, %llu s ago)", kind->leftOut,
                  static_cast<unsigned long long>(timeMs >= kind->lastMs ? (timeMs - kind->lastMs) / 1000 : 0));
    AppendNote(kind->lastLeftOut, note);
    kind->leftOut = 0;
    Keep(timeMs, kind->lastLeftOut);
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
  Kind m_Kinds[kKinds] = {};
  // The lines of moonlight-common-c that found no entry for their kind, which the next Take() reports
  uint32_t m_OtherLeftOut = 0;
};

// The ring of the module
inline DiagnosticLogRing& GetDiagnosticLog() {
  static DiagnosticLogRing ring;
  return ring;
}
