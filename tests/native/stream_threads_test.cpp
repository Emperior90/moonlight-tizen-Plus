// Checks the bookkeeping of the two threads that start and stop a stream (wasm/stream_threads.hpp): every connection
// thread and every stop thread that was created is joined exactly once, whether the start succeeds, fails on its own
// or is stopped while it starts, no thread is joined twice or by itself, a thread that could not be created is not
// joined, and no thread is left behind however many starts fail. Before the rule, nothing joined the connection thread
// of a start that failed on its own, which costs its stack (2 MB of the fixed heap) and a worker in the WebAssembly
// build, and a stop without a connection thread joined the thread of an earlier stream a second time.
// The threads are real ones, behind functions that keep a register of the threads still to be joined and never pass
// a join on that the platform would not allow. wasm/main.cpp can't be built here (it needs the media classes of the
// TV), so the Module below repeats the order of its calls in StartStream(), ConnectionThreadFunc(),
// OnConnectionStopped() and StopThreadFunc(), with stand-ins for moonlight-common-c and the front end;
// tests/unit/stream-thread-fixes.test.js pins that order in main.cpp.

#include "stream_threads.hpp"

#include "test_support.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <pthread.h>
#include <unistd.h>

// Real threads, with a register of those that were created and not joined yet
struct CountingThreads {
  typedef pthread_t Handle;

  struct Register {
    std::mutex mutex;
    std::vector<pthread_t> toJoin;
    int created = 0;
    int joined = 0;
    // Joins that the platform must never see: of a thread that is not to be joined (joined before, or never
    // created), and of a thread by itself
    int wrongJoins = 0;
    int selfJoins = 0;
    int mostToJoin = 0;
    int failingCreates = 0;
  };
  static Register& State() {
    static Register instance;
    return instance;
  }
  static void Reset() {
    Register& state = State();
    std::lock_guard<std::mutex> lock(state.mutex);
    state.toJoin.clear();
    state.created = state.joined = state.wrongJoins = state.selfJoins = state.mostToJoin = state.failingCreates = 0;
  }
  // The next creates fail, like pthread_create() without memory or a free worker
  static void FailCreates(int count) {
    std::lock_guard<std::mutex> lock(State().mutex);
    State().failingCreates = count;
  }
  static int Created() {
    std::lock_guard<std::mutex> lock(State().mutex);
    return State().created;
  }
  static int Joined() {
    std::lock_guard<std::mutex> lock(State().mutex);
    return State().joined;
  }
  static int ToJoin() {
    std::lock_guard<std::mutex> lock(State().mutex);
    return (int)State().toJoin.size();
  }
  static int MostToJoin() {
    std::lock_guard<std::mutex> lock(State().mutex);
    return State().mostToJoin;
  }
  static int WrongJoins() {
    std::lock_guard<std::mutex> lock(State().mutex);
    return State().wrongJoins + State().selfJoins;
  }

  static bool Create(Handle* thread, void* (*function)(void*), void* context) {
    Register& state = State();
    // Held over the creation, so that the thread is in the register before anyone can join it
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.failingCreates > 0) {
      state.failingCreates--;
      return false;
    }
    if (pthread_create(thread, NULL, function, context) != 0) {
      return false;
    }
    state.created++;
    state.toJoin.push_back(*thread);
    state.mostToJoin = std::max(state.mostToJoin, (int)state.toJoin.size());
    return true;
  }
  static void Join(Handle thread) {
    Register& state = State();
    {
      std::lock_guard<std::mutex> lock(state.mutex);
      if (pthread_equal(pthread_self(), thread)) {
        state.selfJoins++;
        return;
      }
      size_t index = 0;
      while (index < state.toJoin.size() && !pthread_equal(state.toJoin[index], thread)) {
        index++;
      }
      if (index == state.toJoin.size()) {
        state.wrongJoins++;
        return;
      }
      state.toJoin.erase(state.toJoin.begin() + index);
      state.joined++;
    }
    pthread_join(thread, NULL);
  }
  static bool IsCurrentThread(Handle thread) {
    return pthread_equal(pthread_self(), thread) != 0;
  }
};

// What the stand-in for LiStartConnection() does
enum class Start {
  kConnects,
  // Fails on its own, like a blocked RTSP handshake or a video format that the TV rejects
  kFails,
  // Stays in the start until the test lets it go (ReleaseStart()), then connects, or fails if it was interrupted
  kWaits,
};

// The part of the module that starts and stops a stream, with the calls of wasm/main.cpp in their order
class Module {
 public:
  StreamThreadsOf<CountingThreads> threads;

  std::atomic<int> teardowns{0};
  std::atomic<int> teardownsDuringStart{0};
  std::atomic<int> ignoredStops{0};
  std::atomic<int> connectionThreadsEnded{0};
  // What BeginStart() saw
  int connectionThreadsJoinedByStart = 0;
  int connectionThreadsEndedAtLastJoinByStart = -1;
  // The connection thread tries to join itself after its start, and what that returned
  bool connectionThreadJoinsItself = false;
  std::atomic<int> selfJoinsClaimed{0};
  // How long the connection thread takes to return after it posted its termination
  int returnDelayMs = 0;

  // StartStream() of main.cpp, on the main thread
  void StartStream(Start start) {
    BeginStart();
    m_ConnectionCancelled = false;
    {
      std::lock_guard<std::mutex> lock(m_Mutex);
      m_Start = start;
      m_Released = false;
      m_Interrupted = false;
    }
    if (!threads.StartConnectionThread(ConnectionThreadFunc, this)) {
      OnConnectionStopped(0);
    }
  }

  // StopStream() and StopConnection() of main.cpp: a stop request of the user
  void StopStream() {
    CancelPendingSetup();
    OnConnectionStopped(0);
  }

  // OnConnectionStopped() of main.cpp, on the main thread
  void OnConnectionStopped(int error) {
    if (!threads.IssueStop()) {
      ignoredStops++;
      return;
    }
    m_Running = false;
    threads.StartStopThread(StopThreadFunc, this);
    Post("streamTerminated: " + std::to_string(error));
  }

  // What the next start of the app does first, so that a test ends without a thread
  void Finish() {
    BeginStart();
  }

  // The test lets a start that waits go on
  void ReleaseStart() {
    std::lock_guard<std::mutex> lock(m_Mutex);
    m_Released = true;
    m_Changed.notify_all();
  }
  void WaitUntilInStartConnection() {
    std::unique_lock<std::mutex> lock(m_Mutex);
    m_Changed.wait(lock, [this] { return m_InStartConnection; });
  }
  void WaitUntilRunning() {
    std::unique_lock<std::mutex> lock(m_Mutex);
    m_Changed.wait(lock, [this] { return m_Running.load(); });
  }
  // The front end: waits for the next message of the module and returns it
  std::string NextMessage() {
    std::unique_lock<std::mutex> lock(m_Mutex);
    m_Changed.wait(lock, [this] { return !m_Posted.empty(); });
    const std::string message = m_Posted.front();
    m_Posted.erase(m_Posted.begin());
    return message;
  }
  size_t WaitingMessages() {
    std::lock_guard<std::mutex> lock(m_Mutex);
    return m_Posted.size();
  }

 private:
  void BeginStart() {
    if (threads.BeginStart()) {
      connectionThreadsJoinedByStart++;
      connectionThreadsEndedAtLastJoinByStart = connectionThreadsEnded.load();
    }
  }

  // CancelPendingSetup() of connectionlistener.cpp, with LiInterruptConnection()
  void CancelPendingSetup() {
    m_ConnectionCancelled = true;
    std::lock_guard<std::mutex> lock(m_Mutex);
    m_Interrupted = true;
    m_Changed.notify_all();
  }

  // A message for the front end that the module doesn't wait for (PostToJsAsync())
  void Post(const std::string& message) {
    std::lock_guard<std::mutex> lock(m_Mutex);
    m_Posted.push_back(message);
    m_Changed.notify_all();
  }

  int LiStartConnection() {
    std::unique_lock<std::mutex> lock(m_Mutex);
    m_InStartConnection = true;
    m_Changed.notify_all();
    int result = m_Start == Start::kFails ? -1 : 0;
    if (m_Start == Start::kWaits) {
      m_Changed.wait(lock, [this] { return m_Released; });
      result = m_Interrupted ? -1 : 0;
    }
    m_InStartConnection = false;
    return result;
  }

  // ConnectionThreadFunc() of main.cpp
  static void* ConnectionThreadFunc(void* context) {
    Module* me = (Module*)context;
    const int err = me->LiStartConnection();
    if (me->connectionThreadJoinsItself && me->threads.JoinConnectionThread()) {
      me->selfJoinsClaimed++;
    }
    if (err != 0) {
      if (me->m_ConnectionCancelled) {
        if (!me->threads.IsStopIssued()) {
          me->Post("streamTerminated: 0");
        }
      } else {
        me->Post("streamTerminated: " + std::to_string(err));
      }
      if (me->returnDelayMs > 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(me->returnDelayMs));
      }
      me->connectionThreadsEnded++;
      return NULL;
    }
    {
      std::lock_guard<std::mutex> lock(me->m_Mutex);
      me->m_Running = true;
      me->m_Changed.notify_all();
    }
    me->connectionThreadsEnded++;
    return NULL;
  }

  // StopThreadFunc() of main.cpp
  static void* StopThreadFunc(void* context) {
    Module* me = (Module*)context;
    me->threads.JoinConnectionThread();
    // LiStopConnection() must not run during LiStartConnection()
    {
      std::lock_guard<std::mutex> lock(me->m_Mutex);
      if (me->m_InStartConnection) {
        me->teardownsDuringStart++;
      }
    }
    me->m_Running = false;
    me->teardowns++;
    return NULL;
  }

  std::mutex m_Mutex;
  std::condition_variable m_Changed;
  Start m_Start = Start::kConnects;
  bool m_Released = false;
  bool m_Interrupted = false;
  bool m_InStartConnection = false;
  std::vector<std::string> m_Posted;
  std::atomic<bool> m_Running{false};
  std::atomic<bool> m_ConnectionCancelled{false};
};

// The front end gets this message next. CHECK_EQ() evaluates its arguments twice, so the message is taken first.
#define CHECK_MESSAGE(module, expected) \
  do { \
    const std::string message = (module).NextMessage(); \
    CHECK_EQ(message, std::string(expected)); \
  } while (0)

// Every thread that was created was joined, and the platform saw no join that it doesn't allow
static void CheckNoThreadIsLeft(int expectedThreads) {
  CHECK_EQ(CountingThreads::Created(), expectedThreads);
  CHECK_EQ(CountingThreads::Joined(), expectedThreads);
  CHECK_EQ(CountingThreads::ToJoin(), 0);
  CHECK_EQ(CountingThreads::WrongJoins(), 0);
}

static void AStreamThatStartsAndIsStopped() {
  CountingThreads::Reset();
  Module module;
  module.StartStream(Start::kConnects);
  module.WaitUntilRunning();
  module.StopStream();
  CHECK_MESSAGE(module, "streamTerminated: 0");
  // The next start waits for the teardown: the stop thread joined the connection thread, the start joins the stop
  // thread and finds no connection thread left
  module.StartStream(Start::kConnects);
  CHECK_EQ(module.teardowns.load(), 1);
  CHECK_EQ(module.connectionThreadsJoinedByStart, 0);
  CHECK_EQ(CountingThreads::Joined(), 2);
  module.WaitUntilRunning();
  // The host ends the second stream (ClConnectionTerminated())
  module.OnConnectionStopped(-102);
  CHECK_MESSAGE(module, "streamTerminated: -102");
  module.Finish();
  CHECK_EQ(module.teardowns.load(), 2);
  CHECK_EQ(module.teardownsDuringStart.load(), 0);
  CHECK_EQ(module.WaitingMessages(), (size_t)0);
  CheckNoThreadIsLeft(4);
  CHECK_EQ(CountingThreads::MostToJoin(), 2);
}

static void AStartThatFailsOnItsOwnIsJoinedByTheNextStart() {
  CountingThreads::Reset();
  Module module;
  // The thread is still returning when the front end starts the next stream
  module.returnDelayMs = 30;
  module.StartStream(Start::kFails);
  CHECK_MESSAGE(module, "streamTerminated: -1");
  // No stop follows, so no stop thread joins it
  CHECK_EQ(module.teardowns.load(), 0);
  CHECK_EQ(CountingThreads::ToJoin(), 1);
  // The next start joins it before it creates its own thread, and has waited for its return
  module.StartStream(Start::kConnects);
  CHECK_EQ(module.connectionThreadsJoinedByStart, 1);
  CHECK_EQ(module.connectionThreadsEndedAtLastJoinByStart, 1);
  CHECK_EQ(CountingThreads::Joined(), 1);
  CHECK_EQ(CountingThreads::MostToJoin(), 1);
  // That stream runs and stops as usual
  module.WaitUntilRunning();
  module.StopStream();
  CHECK_MESSAGE(module, "streamTerminated: 0");
  module.Finish();
  CHECK_EQ(module.teardowns.load(), 1);
  CHECK_EQ(module.connectionThreadsJoinedByStart, 1);
  CHECK_EQ(module.WaitingMessages(), (size_t)0);
  CheckNoThreadIsLeft(3);
}

static void AStopDuringAStartWaitsForTheConnectionThread() {
  CountingThreads::Reset();
  Module module;
  module.StartStream(Start::kWaits);
  module.WaitUntilInStartConnection();
  // RED while the connection starts: the front end hears of it at once
  module.StopStream();
  CHECK_MESSAGE(module, "streamTerminated: 0");
  // The stop thread doesn't tear down while LiStartConnection() runs
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK_EQ(module.teardowns.load(), 0);
  // The interrupted start gives up
  module.ReleaseStart();
  module.Finish();
  CHECK_EQ(module.teardowns.load(), 1);
  CHECK_EQ(module.teardownsDuringStart.load(), 0);
  // The stop thread joined the connection thread, so the start had none to join, and the cancelled start posted no
  // second termination
  CHECK_EQ(module.connectionThreadsJoinedByStart, 0);
  CHECK_EQ(module.WaitingMessages(), (size_t)0);
  CheckNoThreadIsLeft(2);
}

static void AStopAfterAStartThatFailedOnItsOwnJoinsItsThreadOnce() {
  CountingThreads::Reset();
  Module module;
  module.StartStream(Start::kFails);
  CHECK_MESSAGE(module, "streamTerminated: -1");
  // A stop request all the same: its stop thread joins the thread, and the next start doesn't join it again
  module.StopStream();
  CHECK_MESSAGE(module, "streamTerminated: 0");
  module.StartStream(Start::kFails);
  CHECK_EQ(module.connectionThreadsJoinedByStart, 0);
  CHECK_EQ(module.teardowns.load(), 1);
  CHECK_EQ(CountingThreads::Joined(), 2);
  CHECK_MESSAGE(module, "streamTerminated: -1");
  module.Finish();
  CheckNoThreadIsLeft(3);
}

static void TwoStopsStartOneStopThread() {
  CountingThreads::Reset();
  Module module;
  module.StartStream(Start::kConnects);
  module.WaitUntilRunning();
  // A double RED press, or the gamepad combo while the host ends the stream
  module.StopStream();
  module.StopStream();
  module.OnConnectionStopped(-102);
  CHECK_EQ(module.ignoredStops.load(), 2);
  CHECK_EQ(CountingThreads::Created(), 2);
  CHECK_MESSAGE(module, "streamTerminated: 0");
  CHECK_EQ(module.WaitingMessages(), (size_t)0);
  // Also two stops while the connection still starts, the second after the first one's thread is done
  module.StartStream(Start::kWaits);
  CHECK_EQ(module.teardowns.load(), 1);
  module.WaitUntilInStartConnection();
  module.StopStream();
  module.ReleaseStart();
  while (module.teardowns.load() < 2) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  module.StopStream();
  CHECK_EQ(module.ignoredStops.load(), 3);
  CHECK_MESSAGE(module, "streamTerminated: 0");
  CHECK_EQ(module.WaitingMessages(), (size_t)0);
  module.Finish();
  CHECK_EQ(module.teardowns.load(), 2);
  CHECK_EQ(module.teardownsDuringStart.load(), 0);
  CheckNoThreadIsLeft(4);
}

static void AStopWithoutAConnectionThreadJoinsNone() {
  CountingThreads::Reset();
  Module module;
  // Before the first start: there is no thread, and its handle was never set
  module.StopStream();
  CHECK_MESSAGE(module, "streamTerminated: 0");
  // A stream that runs and stops, so that the handle of a joined thread is left
  module.StartStream(Start::kConnects);
  CHECK_EQ(module.teardowns.load(), 1);
  module.WaitUntilRunning();
  module.StopStream();
  CHECK_MESSAGE(module, "streamTerminated: 0");
  // A start whose connection thread can't be created ends like a stopped one, and its stop thread must not join the
  // thread of the stream before once more
  CountingThreads::FailCreates(1);
  module.StartStream(Start::kConnects);
  CHECK_MESSAGE(module, "streamTerminated: 0");
  // Neither thread can be created: the start still ends (after the teardown of the one before), and the next one works
  CountingThreads::FailCreates(2);
  module.StartStream(Start::kConnects);
  CHECK_EQ(module.teardowns.load(), 3);
  CHECK_MESSAGE(module, "streamTerminated: 0");
  module.StartStream(Start::kConnects);
  CHECK_EQ(module.teardowns.load(), 3);
  module.WaitUntilRunning();
  module.StopStream();
  CHECK_MESSAGE(module, "streamTerminated: 0");
  module.Finish();
  CHECK_EQ(module.teardowns.load(), 4);
  CHECK_EQ(module.connectionThreadsJoinedByStart, 0);
  CHECK_EQ(module.WaitingMessages(), (size_t)0);
  // 2 connection threads and 4 stop threads
  CheckNoThreadIsLeft(6);
}

static void TheConnectionThreadNeverJoinsItself() {
  CountingThreads::Reset();
  Module module;
  module.connectionThreadJoinsItself = true;
  module.StartStream(Start::kWaits);
  module.WaitUntilInStartConnection();
  // The start has returned, so the thread is to be joined when it tries
  module.ReleaseStart();
  module.WaitUntilRunning();
  // It is left for the stop thread
  module.StopStream();
  module.Finish();
  CHECK_EQ(module.selfJoinsClaimed.load(), 0);
  CHECK_EQ(module.teardowns.load(), 1);
  CheckNoThreadIsLeft(2);
  // The same for the thread of a start that fails on its own, which tries as soon as it runs: the next start joins it
  CountingThreads::Reset();
  Module failing;
  failing.connectionThreadJoinsItself = true;
  failing.StartStream(Start::kFails);
  CHECK_MESSAGE(failing, "streamTerminated: -1");
  failing.Finish();
  CHECK_EQ(failing.selfJoinsClaimed.load(), 0);
  CHECK_EQ(failing.connectionThreadsJoinedByStart, 1);
  CheckNoThreadIsLeft(1);
}

static void* ReturnAtOnce(void*) {
  return NULL;
}

static void NoHandleIsOverwrittenWhileItsThreadIsToBeJoined() {
  CountingThreads::Reset();
  StreamThreadsOf<CountingThreads> threads;
  CHECK(threads.StartConnectionThread(ReturnAtOnce, NULL));
  // A second thread without BeginStart() would lose the first one
  CHECK(!threads.StartConnectionThread(ReturnAtOnce, NULL));
  CHECK_EQ(CountingThreads::Created(), 1);
  CHECK(threads.IssueStop());
  CHECK(threads.IsStopIssued());
  CHECK(threads.StartStopThread(ReturnAtOnce, NULL));
  CHECK(!threads.StartStopThread(ReturnAtOnce, NULL));
  CHECK_EQ(CountingThreads::Created(), 2);
  // The next start joins both, the connection thread once, and lets the new start be stopped
  CHECK(threads.BeginStart());
  CHECK(!threads.IsStopIssued());
  CHECK(!threads.JoinConnectionThread());
  CHECK(!threads.BeginStart());
  CheckNoThreadIsLeft(2);
  // A thread that could not be created is not to be joined, and the next one can be created
  CountingThreads::FailCreates(1);
  CHECK(!threads.StartConnectionThread(ReturnAtOnce, NULL));
  CHECK(!threads.JoinConnectionThread());
  CountingThreads::FailCreates(1);
  CHECK(!threads.StartStopThread(ReturnAtOnce, NULL));
  CHECK(threads.StartConnectionThread(ReturnAtOnce, NULL));
  CHECK(threads.StartStopThread(ReturnAtOnce, NULL));
  CHECK(threads.BeginStart());
  CheckNoThreadIsLeft(4);
}

static void FiftyStartsThatFailOnTheirOwnLeaveNoThread() {
  CountingThreads::Reset();
  Module module;
  for (int start = 0; start < 50; start++) {
    module.StartStream(Start::kFails);
    CHECK_MESSAGE(module, "streamTerminated: -1");
    // Only the thread of this start is left, however many failed before
    CHECK_EQ(CountingThreads::ToJoin(), 1);
    CHECK_EQ(module.connectionThreadsJoinedByStart, start);
  }
  CHECK_EQ(CountingThreads::MostToJoin(), 1);
  CHECK_EQ(module.teardowns.load(), 0);
  module.Finish();
  CHECK_EQ(module.WaitingMessages(), (size_t)0);
  CheckNoThreadIsLeft(50);
}

static void StartsOfEveryKindInTurnLeaveNoThread() {
  CountingThreads::Reset();
  Module module;
  int expectedThreads = 0;
  for (int round = 0; round < 20; round++) {
    // Fails on its own
    module.StartStream(Start::kFails);
    CHECK_MESSAGE(module, "streamTerminated: -1");
    // Connects and is stopped
    module.StartStream(Start::kConnects);
    module.WaitUntilRunning();
    module.StopStream();
    CHECK_MESSAGE(module, "streamTerminated: 0");
    // Is stopped while it starts
    module.StartStream(Start::kWaits);
    module.WaitUntilInStartConnection();
    module.StopStream();
    module.ReleaseStart();
    CHECK_MESSAGE(module, "streamTerminated: 0");
    // Has no thread
    CountingThreads::FailCreates(1);
    module.StartStream(Start::kConnects);
    CHECK_MESSAGE(module, "streamTerminated: 0");
    // Fails on its own and is stopped all the same
    module.StartStream(Start::kFails);
    CHECK_MESSAGE(module, "streamTerminated: -1");
    module.StopStream();
    CHECK_MESSAGE(module, "streamTerminated: 0");
    // 4 connection threads and 4 stop threads
    expectedThreads += 8;
    CHECK_EQ(CountingThreads::Created(), expectedThreads);
    CHECK(CountingThreads::ToJoin() <= 2);
  }
  module.Finish();
  // A connection thread and a stop thread at most, never one of an earlier start as well
  CHECK(CountingThreads::MostToJoin() <= 2);
  CHECK_EQ(module.teardownsDuringStart.load(), 0);
  CHECK_EQ(module.teardowns.load(), 80);
  CHECK_EQ(module.WaitingMessages(), (size_t)0);
  CheckNoThreadIsLeft(expectedThreads);
}

struct Claimers {
  StreamThreadsOf<CountingThreads> threads;
  std::atomic<bool> go{false};
  std::atomic<int> joins{0};
};

static void* JoinWhenToldTo(void* context) {
  Claimers* claimers = (Claimers*)context;
  while (!claimers->go.load()) {
    std::this_thread::yield();
  }
  if (claimers->threads.JoinConnectionThread()) {
    claimers->joins++;
  }
  return NULL;
}

// The app never lets two threads try at once (the next start joins the stop thread first), which the rule doesn't rely on
static void OfSeveralThreadsThatTryToJoinAtOnceOneDoes() {
  CountingThreads::Reset();
  const int kRounds = 200;
  const int kClaimers = 4;
  int wrongRounds = 0;
  for (int round = 0; round < kRounds; round++) {
    Claimers claimers;
    CHECK(claimers.threads.StartConnectionThread(ReturnAtOnce, NULL));
    pthread_t others[kClaimers];
    for (int index = 0; index < kClaimers; index++) {
      pthread_create(&others[index], NULL, JoinWhenToldTo, &claimers);
    }
    claimers.go = true;
    for (int index = 0; index < kClaimers; index++) {
      pthread_join(others[index], NULL);
    }
    if (claimers.joins.load() != 1) {
      wrongRounds++;
    }
  }
  CHECK_EQ(wrongRounds, 0);
  CheckNoThreadIsLeft(kRounds);
}

static std::atomic<int> platformThreadsEnded{0};

static void* EndAfterAMoment(void*) {
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  platformThreadsEnded++;
  return NULL;
}

static void* JoinTheConnectionThread(void* context) {
  StreamThreads* threads = (StreamThreads*)context;
  if (threads->JoinConnectionThread()) {
    platformThreadsEnded += 10;
  }
  return NULL;
}

// The functions that the app uses (PlatformThreads), which the other tests replace
static void TheThreadsOfThePlatformAreJoined() {
  StreamThreads threads;
  platformThreadsEnded = 0;
  // A start that failed on its own: the next start waits for its thread
  CHECK(!threads.BeginStart());
  CHECK(threads.StartConnectionThread(EndAfterAMoment, NULL));
  CHECK(threads.BeginStart());
  CHECK_EQ(platformThreadsEnded.load(), 1);
  CHECK(!threads.JoinConnectionThread());
  // A stopped stream: the stop thread waits for the connection thread, and the next start for the stop thread
  CHECK(threads.StartConnectionThread(EndAfterAMoment, NULL));
  CHECK(threads.IssueStop());
  CHECK(!threads.IssueStop());
  CHECK(threads.StartStopThread(JoinTheConnectionThread, &threads));
  CHECK(!threads.BeginStart());
  CHECK_EQ(platformThreadsEnded.load(), 12);
  CHECK(threads.IssueStop());
}

int main() {
  // A join that never returns would hang the run: end it instead
  alarm(120);
  test_support::RunTest("a stream that starts and is stopped: the stop thread joins the connection thread, the next start the stop thread",
                        AStreamThatStartsAndIsStopped);
  test_support::RunTest("a start that fails on its own: the next start joins its connection thread",
                        AStartThatFailsOnItsOwnIsJoinedByTheNextStart);
  test_support::RunTest("a stop during a start: the stop thread waits for the connection thread and joins it",
                        AStopDuringAStartWaitsForTheConnectionThread);
  test_support::RunTest("a stop after a start that failed on its own joins its thread once",
                        AStopAfterAStartThatFailedOnItsOwnJoinsItsThreadOnce);
  test_support::RunTest("two stops start one stop thread and tell the front end once", TwoStopsStartOneStopThread);
  test_support::RunTest("a stop without a connection thread joins none, also after an earlier stream",
                        AStopWithoutAConnectionThreadJoinsNone);
  test_support::RunTest("the connection thread never joins itself", TheConnectionThreadNeverJoinsItself);
  test_support::RunTest("no handle is overwritten while its thread is to be joined",
                        NoHandleIsOverwrittenWhileItsThreadIsToBeJoined);
  test_support::RunTest("fifty starts that fail on their own leave no thread behind",
                        FiftyStartsThatFailOnTheirOwnLeaveNoThread);
  test_support::RunTest("starts of every kind in turn leave no thread behind", StartsOfEveryKindInTurnLeaveNoThread);
  test_support::RunTest("of several threads that try to join the connection thread at once, one does",
                        OfSeveralThreadsThatTryToJoinAtOnceOneDoes);
  test_support::RunTest("the threads of the platform are joined", TheThreadsOfThePlatformAreJoined);
  return test_support::Summary();
}
