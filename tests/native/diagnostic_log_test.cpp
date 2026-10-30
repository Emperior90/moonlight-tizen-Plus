// Checks the native part of the diagnostic log (wasm/diagnostic_log.hpp): the lines that the module logs are kept in a
// ring of fixed size until the front end takes them, one record per line as "<time>\t<text>"; a line never waits for the
// lock (a line that finds it taken is counted and the count goes in with the next line); a line that repeats the one
// before within a second is counted instead of kept; a full ring drops its oldest lines and says how many; and a long
// line is cut on a whole UTF-8 character. The last test logs from several threads while another one takes the lines.

#include "../../wasm/diagnostic_log.hpp"

#include "test_support.h"

#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

static std::vector<std::string> SplitLines(const std::string& text) {
  std::vector<std::string> lines;
  size_t start = 0;
  while (start < text.size()) {
    const size_t end = text.find('\n', start);
    lines.push_back(text.substr(start, end - start));
    start = end + 1;
  }
  return lines;
}

static void TestLinesAreTakenOnce() {
  DiagnosticLogRing ring;
  CHECK(ring.TryAppend(1000, "Starting connection\n"));
  CHECK(ring.TryAppend(1005, "RTSP handshake\r\nsecond\tline"));
  // CHECK_EQ() evaluates its arguments twice, so the lines are taken first
  const std::string taken1 = ring.Take();
  CHECK_EQ(taken1, std::string("1000\tStarting connection\n1005\tRTSP handshake  second line\n"));
  // Taken lines are gone
  // CHECK_EQ() evaluates its arguments twice, so the lines are taken first
  const std::string taken2 = ring.Take();
  CHECK_EQ(taken2, std::string());
  ring.TryAppend(2000, "Next");
  // CHECK_EQ() evaluates its arguments twice, so the lines are taken first
  const std::string taken3 = ring.Take();
  CHECK_EQ(taken3, std::string("2000\tNext\n"));
  // An empty or missing message is an empty line
  ring.TryAppend(2100, nullptr);
  // CHECK_EQ() evaluates its arguments twice, so the lines are taken first
  const std::string taken4 = ring.Take();
  CHECK_EQ(taken4, std::string("2100\t\n"));
}

static void TestRepeatsAreCounted() {
  DiagnosticLogRing ring;
  ring.TryAppend(1000, "Input queue reached maximum size limit\n");
  for (int i = 1; i <= 50; ++i) {
    ring.TryAppend(1000 + i * 10, "Input queue reached maximum size limit\n");
  }
  ring.TryAppend(1600, "Another line\n");
  std::vector<std::string> lines = SplitLines(ring.Take());
  CHECK_EQ(lines.size(), 3u);
  if (lines.size() == 3) {
    CHECK_EQ(lines[0], std::string("1000\tInput queue reached maximum size limit"));
    CHECK_EQ(lines[1], std::string("1000\t(the line before came 50 more times)"));
    CHECK_EQ(lines[2], std::string("1600\tAnother line"));
  }

  // The same line more than a second after it was kept is kept again
  ring.TryAppend(5000, "Tick");
  ring.TryAppend(6000, "Tick");
  ring.TryAppend(6500, "Tick");
  // Repeats that are pending when the lines are taken are reported then
  // CHECK_EQ() evaluates its arguments twice, so the lines are taken first
  const std::string taken5 = ring.Take();
  CHECK_EQ(taken5, std::string("5000\tTick\n6000\tTick\n6000\t(the line before came 1 more times)\n"));
}

// The lock of a ring, which is private: an explicit template instantiation is the one place where C++ lets code name a
// private member, so PrivateMember hands out a pointer to it (as in stats_overlay_test.cpp)
template <typename Tag, typename Tag::Type Member>
struct PrivateMember {
  friend typename Tag::Type Pointer(Tag) {
    return Member;
  }
};
struct RingMutexMember {
  using Type = std::mutex DiagnosticLogRing::*;
  friend Type Pointer(RingMutexMember);
};
template struct PrivateMember<RingMutexMember, &DiagnosticLogRing::m_Mutex>;

static void TestBusyLinesAreCountedNotAwaited() {
  DiagnosticLogRing ring;
  ring.TryAppend(1000, "Before");
  ring.Take();
  std::atomic<bool> locked{false};
  std::atomic<bool> release{false};
  std::atomic<int> refusedLines{0};
  // Another thread logs while this one holds the lock, as the front end does while it takes the lines: each line is
  // left out at once instead of waiting
  std::thread writer([&]() {
    while (!locked.load()) {
    }
    refusedLines += ring.TryAppend(1100, "Left out") ? 0 : 1;
    refusedLines += ring.TryAppend(1200, "Left out too") ? 0 : 1;
    release.store(true);
  });
  {
    std::lock_guard<std::mutex> guard(ring.*Pointer(RingMutexMember()));
    locked.store(true);
    while (!release.load()) {
    }
  }
  writer.join();
  CHECK_EQ(refusedLines.load(), 2);
  CHECK_EQ(ring.BusyCount(), 2u);
  ring.TryAppend(1300, "After");
  // CHECK_EQ() evaluates its arguments twice, so the lines are taken first
  const std::string taken6 = ring.Take();
  CHECK_EQ(taken6, std::string("1300\t2 lines of the native log were left out while it was busy\n1300\tAfter\n"));
  CHECK_EQ(ring.BusyCount(), 0u);
}

static void TestFullRingDropsTheOldestLines() {
  DiagnosticLogRing ring;
  const int total = static_cast<int>(DiagnosticLogRing::kSlots) + 10;
  for (int i = 0; i < total; ++i) {
    ring.TryAppend(1000 + i, ("Line " + std::to_string(i)).c_str());
  }
  std::vector<std::string> lines = SplitLines(ring.Take());
  CHECK_EQ(lines.size(), DiagnosticLogRing::kSlots + 1);
  if (lines.size() == DiagnosticLogRing::kSlots + 1) {
    CHECK_EQ(lines[0], std::string("1010\t10 older lines of the native log were overwritten"));
    CHECK_EQ(lines[1], std::string("1010\tLine 10"));
    CHECK_EQ(lines.back(), std::to_string(1000 + total - 1) + "\tLine " + std::to_string(total - 1));
  }
}

static void TestLongLinesAreCutOnACharacter() {
  DiagnosticLogRing ring;
  // 238 ASCII bytes and a 3-byte character that doesn't fit into the 239 bytes of a line
  std::string message(238, 'a');
  message += "\xE2\x82\xAC tail";
  ring.TryAppend(1000, message.c_str());
  std::string expected = "1000\t" + std::string(238, 'a') + "\n";
  // CHECK_EQ() evaluates its arguments twice, so the lines are taken first
  const std::string taken7 = ring.Take();
  CHECK_EQ(taken7, expected);
  // A character that fits whole stays
  std::string fits(236, 'b');
  fits += "\xE2\x82\xAC tail";
  ring.TryAppend(1000, fits.c_str());
  // CHECK_EQ() evaluates its arguments twice, so the lines are taken first
  const std::string taken8 = ring.Take();
  CHECK_EQ(taken8, "1000\t" + std::string(236, 'b') + "\xE2\x82\xAC\n");
}

static void TestManyThreads() {
  DiagnosticLogRing ring;
  std::atomic<bool> done{false};
  std::atomic<int> kept{0};
  std::atomic<int> refused{0};
  std::vector<std::thread> writers;
  for (int t = 0; t < 4; ++t) {
    writers.emplace_back([&, t]() {
      for (int i = 0; i < 20000; ++i) {
        const std::string line = "Thread " + std::to_string(t) + " line " + std::to_string(i);
        if (ring.TryAppend(static_cast<uint64_t>(i), line.c_str())) {
          kept++;
        } else {
          refused++;
        }
      }
    });
  }
  size_t takenLines = 0;
  std::thread reader([&]() {
    while (!done.load()) {
      takenLines += SplitLines(ring.Take()).size();
    }
  });
  for (std::thread& writer : writers) {
    writer.join();
  }
  done.store(true);
  reader.join();
  takenLines += SplitLines(ring.Take()).size();
  CHECK_EQ(kept.load() + refused.load(), 80000);
  CHECK(takenLines > 0);
}

int main() {
  test_support::RunTest("the native log keeps each line until it is taken once", TestLinesAreTakenOnce);
  test_support::RunTest("a line that repeats the one before within a second is counted", TestRepeatsAreCounted);
  test_support::RunTest("a line never waits for the lock: it is counted and reported with the next one", TestBusyLinesAreCountedNotAwaited);
  test_support::RunTest("a full ring drops its oldest lines and says how many", TestFullRingDropsTheOldestLines);
  test_support::RunTest("a long line is cut on a whole UTF-8 character", TestLongLinesAreCutOnACharacter);
  test_support::RunTest("lines from several threads while another one takes them", TestManyThreads);
  return test_support::Summary();
}
