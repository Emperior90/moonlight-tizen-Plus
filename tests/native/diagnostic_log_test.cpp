// Checks the native part of the diagnostic log (wasm/diagnostic_log.hpp): the lines that the module logs are kept in a
// ring of fixed size until the front end takes them, one record per line as "<time>\t<text>"; a line never waits for the
// lock (a line that finds it taken is counted and the count goes in with the next line); a line that repeats the one
// before within a second is counted instead of kept; a full ring drops its oldest lines and says how many; and a long
// line is cut on a whole UTF-8 character. The lines of moonlight-common-c, of which some come once per lost packet or
// frame, are limited by their kind (their text without its numbers): the first ten are kept, then one per minute with
// the count of those left out, and the last of them once the kind ended, so that such a line can't push the others out
// of the log however often it comes, while every other line stays. The ring tells 64 kinds apart; more kinds than
// that share the entries without ever keeping more than the entries allow, and every line that is left out is counted
// in a note. The last test logs from several threads while another one takes the lines.

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

// The texts of the taken lines, without their times
static std::vector<std::string> Texts(const std::string& taken) {
  std::vector<std::string> texts;
  for (const std::string& line : SplitLines(taken)) {
    texts.push_back(line.substr(line.find('\t') + 1));
  }
  return texts;
}

static int CountWith(const std::vector<std::string>& texts, const char* part) {
  int count = 0;
  for (const std::string& text : texts) {
    count += text.find(part) != std::string::npos ? 1 : 0;
  }
  return count;
}

static const uint64_t kMinute = DiagnosticLogRing::kKindRefillMs;
static const int kBurst = static_cast<int>(DiagnosticLogRing::kKindBurst);

static void TestALineOfTheLibraryPerFrameIsLimitedByItsKind() {
  DiagnosticLogRing ring;
  uint64_t now = 1000000;
  // A network that loses a packet in every frame of a 60 FPS stream, which the error correction recovers, for ten
  // minutes: 36000 lines of one kind
  int logged = 0;
  uint64_t last = now;
  for (int frame = 0; frame < 36000; frame++) {
    const std::string line = "Recovered 1 video data shards from frame " + std::to_string(4521 + frame) + "\n";
    CHECK(ring.TryAppendLimited(now, line.c_str()));
    logged++;
    last = now;
    now += 1000 / 60;
    if (frame == 600) {
      // A line of the app in between stays, as does a line of another kind of the library
      ring.TryAppend(now, "The PC restarted its video encoder\n");
      ring.TryAppendLimited(now, "Network dropped 1 frame (frame 5122)\n");
    }
  }
  const std::vector<std::string> texts = Texts(ring.Take(now));
  // The first ten, and one for each of the nine minutes after the first, which says how many came in between
  CHECK_EQ(CountWith(texts, "Recovered 1 video data shards"), kBurst + 9);
  CHECK_EQ(texts.size(), static_cast<size_t>(kBurst + 9 + 2));
  if (texts.size() == static_cast<size_t>(kBurst + 9 + 2)) {
    CHECK_EQ(texts[0], std::string("Recovered 1 video data shards from frame 4521"));
    CHECK_EQ(texts[kBurst - 1], std::string("Recovered 1 video data shards from frame 4530"));
    CHECK_EQ(texts[kBurst], std::string("The PC restarted its video encoder"));
    CHECK_EQ(texts[kBurst + 1], std::string("Network dropped 1 frame (frame 5122)"));
    // 60000 / 16 ms = 3750 lines per minute, of which the first ten were kept
    CHECK_EQ(texts[kBurst + 2],
             std::string("Recovered 1 video data shards from frame 8271 (3740 similar lines before it were left out)"));
    CHECK_EQ(texts[kBurst + 3],
             std::string("Recovered 1 video data shards from frame 12021 (3749 similar lines before it were left out)"));
  }
  // Every line is accounted for: the kept ones and the counts they carry, and those since the last kept one, which the
  // last of them reports once the kind was quiet for a minute
  int leftOut = 0;
  for (const std::string& text : texts) {
    const size_t note = text.find(" (");
    if (text.find("Recovered") == 0 && note != std::string::npos) {
      leftOut += std::stoi(text.substr(note + 2));
    }
  }
  const std::string soon = ring.Take(last + kMinute - 1);
  CHECK_EQ(soon, std::string());
  const std::vector<std::string> late = Texts(ring.Take(last + kMinute + 5000));
  CHECK_EQ(late.size(), 1u);
  if (late.size() == 1) {
    const std::string expected = "Recovered 1 video data shards from frame 40520 (the last of ";
    CHECK_EQ(late[0].substr(0, expected.size()), expected);
    CHECK(late[0].find(" similar lines that were left out, 65 s ago)") != std::string::npos);
    leftOut += std::stoi(late[0].substr(expected.size()));
  }
  CHECK_EQ(kBurst + 9 + leftOut, logged);
  // Reported once
  const std::string again = ring.Take(last + 10 * kMinute);
  CHECK_EQ(again, std::string());
}

static void TestTheKindOfALineIsItsTextWithoutItsNumbers() {
  DiagnosticLogRing ring;
  uint64_t now = 5000000;
  // Three kinds that take turns, as after a lost frame: each has its own count
  for (int i = 0; i < 50; i++) {
    ring.TryAppendLimited(now, ("Unrecoverable frame " + std::to_string(700 + i) + ": 10+1=11 received < 12 needed\n").c_str());
    ring.TryAppendLimited(now, ("Sending RFI request for unrecoverable frame " + std::to_string(700 + i) + "\n").c_str());
    ring.TryAppendLimited(now, ("Invalidate reference frame request sent (" + std::to_string(690 + i) + " to " +
                                std::to_string(700 + i) + ")\n").c_str());
    now += 20;
  }
  // A line without a number is a kind too
  for (int i = 0; i < 50; i++) {
    ring.TryAppendLimited(now, "Video decode unit queue overflow\n");
    ring.TryAppendLimited(now, "IDR frame request sent\n");
    now += 300;
  }
  std::vector<std::string> texts = Texts(ring.Take(now));
  CHECK_EQ(CountWith(texts, "Unrecoverable frame"), kBurst);
  CHECK_EQ(CountWith(texts, "Sending RFI request"), kBurst);
  CHECK_EQ(CountWith(texts, "Invalidate reference frame request sent"), kBurst);
  CHECK_EQ(CountWith(texts, "Video decode unit queue overflow"), kBurst);
  CHECK_EQ(CountWith(texts, "IDR frame request sent"), kBurst);
  CHECK_EQ(texts.size(), static_cast<size_t>(5 * kBurst));
  // The same text with other words is another kind, also with the same numbers
  ring.TryAppendLimited(now, "Unrecoverable frame 750 (block 1 of 4): 10+1=11 received < 12 needed\n");
  texts = Texts(ring.Take(now));
  CHECK_EQ(texts.size(), 1u);
  // A kind that was quiet gets one more line per minute, up to the first ten again
  now += 3 * kMinute + 1;
  for (int i = 0; i < 50; i++) {
    ring.TryAppendLimited(now, ("Sending RFI request for unrecoverable frame " + std::to_string(900 + i) + "\n").c_str());
  }
  texts = Texts(ring.Take(now));
  // Three minutes are three lines, of which the first reports the 40 that were left out before
  CHECK_EQ(CountWith(texts, "Sending RFI request"), 3);
  if (texts.size() >= 2) {
    CHECK_EQ(texts[0], std::string("Sending RFI request for unrecoverable frame 900 (40 similar lines before it were left out)"));
    CHECK_EQ(texts[1], std::string("Sending RFI request for unrecoverable frame 901"));
  }
  // The four kinds that ended meanwhile report their 40 lines each by the last of them
  CHECK_EQ(CountWith(texts, "(the last of 40 similar lines that were left out, "), 4);
  CHECK_EQ(CountWith(texts, "Unrecoverable frame 749: 10+1=11 received < 12 needed (the last of 40 similar lines"), 1);
  CHECK_EQ(CountWith(texts, "IDR frame request sent (the last of 40 similar lines"), 1);
  CHECK_EQ(texts.size(), 7u);
  now += 60 * kMinute;
  for (int i = 0; i < 50; i++) {
    ring.TryAppendLimited(now, ("Sending RFI request for unrecoverable frame " + std::to_string(1000 + i) + "\n").c_str());
  }
  texts = Texts(ring.Take(now));
  CHECK_EQ(CountWith(texts, "Sending RFI request"), kBurst);
  if (!texts.empty()) {
    CHECK_EQ(texts[0], std::string("Sending RFI request for unrecoverable frame 1000 (47 similar lines before it were left out)"));
  }
}

static void TestALineWithoutALineBreakIsLimitedLikeAnyOther() {
  DiagnosticLogRing ring;
  uint64_t now = 9000000;
  // VideoDepacketizer.c logs a corrupt frame without a line break at the end of its text, once per frame of a stream
  // that arrives damaged, and then waits for a keyframe: 58 seconds of a 60 FPS stream
  for (int frame = 0; frame < 3480; frame++) {
    ring.TryAppendLimited(now, ("Depacketizer detected corrupt frame: " + std::to_string(100 + frame)).c_str());
    ring.TryAppendLimited(now, "Waiting for IDR frame\n");
    now += 1000 / 60;
  }
  const std::vector<std::string> texts = Texts(ring.Take(now));
  CHECK_EQ(CountWith(texts, "Depacketizer detected corrupt frame"), kBurst);
  CHECK_EQ(CountWith(texts, "Waiting for IDR frame"), kBurst);
  CHECK_EQ(texts.size(), static_cast<size_t>(2 * kBurst));
}

// A line of one of many kinds: the kinds differ by their letters, the lines of a kind by their number
static std::string LineOfKind(int kind, int number) {
  return std::string("Line of kind ") + static_cast<char>('A' + kind / 26) + static_cast<char>('A' + kind % 26) +
         " with the number " + std::to_string(number) + "\n";
}

static void TestAKindThatIsLeftOutKeepsItsEntryAndItsCount() {
  DiagnosticLogRing ring;
  uint64_t now = 20000000;
  // One kind floods and goes quiet
  for (int i = 0; i < 25; i++) {
    ring.TryAppendLimited(now, ("Failed to decrypt control packet of size " + std::to_string(40 + i) + "\n").c_str());
  }
  now += 1000;
  // Then more kinds than the ring tells apart, one line each. All of them are kept: a new kind takes over the entry of
  // the kind that was quiet longest among those that may keep a line. The kind that flooded may keep none, so it keeps
  // its entry and with it the count of its lines.
  const int kinds = static_cast<int>(DiagnosticLogRing::kKinds) + 4;
  for (int k = 0; k < kinds; k++) {
    ring.TryAppendLimited(now, LineOfKind(k, k).c_str());
    now += 10;
  }
  std::vector<std::string> texts = Texts(ring.Take(now));
  CHECK_EQ(CountWith(texts, "Line of kind"), kinds);
  CHECK_EQ(CountWith(texts, "Failed to decrypt control packet"), kBurst);
  CHECK_EQ(texts.size(), static_cast<size_t>(kinds + kBurst));
  // A minute later its entry may keep a line again and is the oldest: a new kind takes it over, after the last of the
  // lines that were left out with their count
  now += kMinute;
  ring.TryAppendLimited(now, "A line of another kind\n");
  texts = Texts(ring.Take(now));
  CHECK_EQ(texts.size(), 2u);
  if (texts.size() == 2) {
    CHECK_EQ(texts[0], std::string("Failed to decrypt control packet of size 64 (the last of 15 similar lines that were left out, 61 s ago)"));
    CHECK_EQ(texts[1], std::string("A line of another kind"));
  }
}

static void TestKindsThatTakeTurnsStayLimitedAndLoseNoCount() {
  DiagnosticLogRing ring;
  uint64_t now = 40000000;
  int logged = 0;
  int kept = 0;
  int leftOut = 0;
  int unexpected = 0;
  // Take the lines and count the kept ones and those that the notes report as left out
  const auto take = [&](uint64_t time) {
    for (const std::string& text : Texts(ring.Take(time))) {
      const size_t last = text.find(" (the last of ");
      const size_t before = text.find(" similar lines before it were left out)");
      if (text.find("Line of kind ") == 0 && last != std::string::npos) {
        leftOut += std::stoi(text.substr(last + 14));
      } else if (text.find("Line of kind ") == 0) {
        kept++;
        if (before != std::string::npos) {
          leftOut += std::stoi(text.substr(text.rfind('(', before) + 1));
        }
      } else if (text.find(" more lines of moonlight-common-c were left out (too many kinds at a time)") != std::string::npos) {
        leftOut += std::stoi(text);
      } else {
        unexpected++;
      }
    }
  };
  // A network that breaks down, seen by more kinds of lines than the ring tells apart, each of them once per frame for
  // 20 seconds of a 60 FPS stream. If a kind that comes back got the lines of a new kind each time, every line would be
  // kept; the entries only ever hand on what they may still keep.
  const int kinds = static_cast<int>(DiagnosticLogRing::kKinds) + 16;
  for (int frame = 0; frame < 1200; frame++) {
    for (int k = 0; k < kinds; k++) {
      CHECK(ring.TryAppendLimited(now, LineOfKind(k, frame).c_str()));
      logged++;
    }
    now += 1000 / 60;
    take(now);
  }
  // Ten lines for each entry, of 96000
  CHECK_EQ(kept, static_cast<int>(DiagnosticLogRing::kKinds) * kBurst);
  CHECK_EQ(logged, kinds * 1200);
  // A minute later every line that was left out is reported, by the last line of its kind or, for a kind that found no
  // entry, by a note of its own
  now += kMinute;
  take(now);
  CHECK_EQ(kept + leftOut, logged);
  CHECK_EQ(unexpected, 0);
  // And each entry may keep one more line, whichever kinds come
  kept = 0;
  for (int k = 0; k < kinds; k++) {
    ring.TryAppendLimited(now, LineOfKind(k, 5000).c_str());
  }
  take(now);
  CHECK_EQ(kept, static_cast<int>(DiagnosticLogRing::kKinds));
}

static void TestALimitedLineNeverWaitsAndKeepsItsNote() {
  DiagnosticLogRing ring;
  // The lock is taken: the line is left out at once and counted like any other
  {
    std::lock_guard<std::mutex> guard(ring.*Pointer(RingMutexMember()));
    std::thread writer([&]() {
      CHECK(!ring.TryAppendLimited(1000, "Waiting for IDR frame\n"));
    });
    writer.join();
  }
  CHECK_EQ(ring.BusyCount(), 1u);
  // The repeats of the line before are counted as for a line of the app, without using up the kind
  for (int i = 0; i < 100; i++) {
    ring.TryAppendLimited(2000 + i, "Waiting for IDR frame\n");
  }
  std::vector<std::string> texts = Texts(ring.Take(3000));
  CHECK_EQ(texts.size(), 3u);
  if (texts.size() == 3) {
    CHECK_EQ(texts[0], std::string("1 lines of the native log were left out while it was busy"));
    CHECK_EQ(texts[1], std::string("Waiting for IDR frame"));
    CHECK_EQ(texts[2], std::string("(the line before came 99 more times)"));
  }
  // A long line is cut for the note about the lines left out, on a whole character: the note takes 42 of the 239
  // bytes, and the 3-byte character at byte 197 doesn't fit whole before it
  const std::string note = " (1 similar lines before it were left out)";
  const std::string longTail = " " + std::string(188, 'h') + "\xE2\x82\xAC tail\n";
  for (int i = 0; i <= kBurst; i++) {
    ring.TryAppendLimited(5000 + i, ("Line " + std::to_string(10 + i) + longTail).c_str());
  }
  ring.Take(6000);
  ring.TryAppendLimited(5000 + kMinute, ("Line 77" + longTail).c_str());
  texts = Texts(ring.Take(5000 + kMinute));
  CHECK_EQ(texts.size(), 1u);
  if (texts.size() == 1) {
    CHECK_EQ(texts[0], "Line 77 " + std::string(188, 'h') + note);
    CHECK(texts[0].size() <= DiagnosticLogRing::kLineBytes - 1);
  }
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
        // Two threads log like the app, two like moonlight-common-c, whose lines are limited by their kind
        const bool appended = t < 2 ? ring.TryAppend(static_cast<uint64_t>(i), line.c_str())
                                    : ring.TryAppendLimited(static_cast<uint64_t>(i), line.c_str());
        if (appended) {
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
  test_support::RunTest("a line of the library that comes once per frame is kept ten times, then once per minute with a count",
                        TestALineOfTheLibraryPerFrameIsLimitedByItsKind);
  test_support::RunTest("the kind of a line of the library is its text without its numbers, and each kind has its own count",
                        TestTheKindOfALineIsItsTextWithoutItsNumbers);
  test_support::RunTest("a line of the library without a line break at its end is limited like any other",
                        TestALineWithoutALineBreakIsLimitedLikeAnyOther);
  test_support::RunTest("a kind that is left out keeps its entry and its count while other kinds come and go",
                        TestAKindThatIsLeftOutKeepsItsEntryAndItsCount);
  test_support::RunTest("more kinds than the ring tells apart, taking turns, stay limited and lose no count",
                        TestKindsThatTakeTurnsStayLimitedAndLoseNoCount);
  test_support::RunTest("a limited line never waits for the lock, counts as a repeat first and is cut for its note",
                        TestALimitedLineNeverWaitsAndKeepsItsNote);
  test_support::RunTest("lines from several threads while another one takes them", TestManyThreads);
  return test_support::Summary();
}
