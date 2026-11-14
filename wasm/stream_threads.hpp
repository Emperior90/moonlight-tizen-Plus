#pragma once

// Keeps track of the two threads that start and stop a stream, so that each of them is joined exactly once
// (StartStream(), OnConnectionStopped(), ConnectionThreadFunc() and StopThreadFunc() of main.cpp).
//
// A start creates the connection thread, which runs LiStartConnection() and returns. A stop (the user, the host or a
// failed video player) creates the stop thread, which joins the connection thread first, because LiStopConnection()
// must not run during LiStartConnection(), and then tears the stream down. The next start joins the stop thread before
// it touches the state of the stream. A start that fails on its own gets no stop thread: its connection thread tells
// the front end and returns. Nothing joined that thread, and the next start overwrote its handle. In the WebAssembly
// build a thread that is never joined keeps its stack (2 MB of the fixed heap) and its pooled worker for the rest of
// the run of the app, so every failed start cost both. A stop without a connection thread (the renderer could not be
// set up, or no stream was started yet) joined the handle of an earlier thread once more, or one that was never set.
//
// The rule:
// - A connection thread is to be joined from the moment it was created until one thread claims its join, which only
//   one thread can. A thread that could not be created is never joined.
// - The stop thread claims it (JoinConnectionThread()). A stop is issued once per start (IssueStop()), so a start has
//   one stop thread at most.
// - The next start (BeginStart(), on the main thread) joins the stop thread and then claims a connection thread that
//   no stop thread joined, i.e. the one of a start that failed on its own. That thread posted its termination without
//   waiting for the front end (PostToJsAsync()) and returned, and the front end starts the next stream after that
//   message at the earliest, so this join only waits for a thread that is returning and needs the main thread for
//   nothing.
// - No handle is overwritten while its thread is to be joined, and a thread never joins itself (pthread_join() fails
//   then, and the thread would stay unjoined).
//
// BeginStart() and StartConnectionThread() run on the main thread only. IssueStop() and StartStopThread() run on the
// thread that stops the stream: the main thread, or the input thread for the stop combination of a controller
// (PollGamepads() in gamepad.cpp calls stopStream() there). IssueStop() lets only one of them go on to the stop thread.
//
// The header also counts the starts (StartNumber()), for an answer of the TV that belongs to the stream before and can
// come after the next start: see ReleaseTracksOfClosedSource() at the end.

#include <atomic>
#include <pthread.h>

// The threads of the platform. The native test passes its own functions instead, which count the threads
// (tests/native/stream_threads_test.cpp).
struct PlatformThreads {
  typedef pthread_t Handle;

  static bool Create(Handle* thread, void* (*function)(void*), void* context) {
    return pthread_create(thread, NULL, function, context) == 0;
  }
  static void Join(Handle thread) {
    pthread_join(thread, NULL);
  }
  static bool IsCurrentThread(Handle thread) {
    return pthread_equal(pthread_self(), thread) != 0;
  }
};

template <typename Threads>
class StreamThreadsOf {
 public:
  typedef typename Threads::Handle Handle;
  typedef void* (*ThreadFunction)(void*);

  // StartStream(), before it touches the state of the stream: waits for the teardown of the stream before (joins its
  // stop thread), joins a connection thread that no stop thread joined, and lets the new start be stopped. Returns
  // whether it joined a connection thread, which is the one of a start that failed on its own.
  bool BeginStart() {
    if (m_StopThreadToJoin) {
      Threads::Join(m_StopThread);
      m_StopThreadToJoin = false;
    }
    const bool joinedConnectionThread = JoinConnectionThread();
    m_StopIssued.store(false);
    // After the joins: the threads of the start before, which close its media source, read the number of that start
    m_StartNumber.fetch_add(1);
    return joinedConnectionThread;
  }

  // The number of the start that BeginStart() began last, which is another one for every start
  unsigned int StartNumber() const {
    return m_StartNumber.load();
  }

  // StartStream(), after BeginStart(): creates the connection thread. Returns false when there is none, because it
  // could not be created, or because the one before is still to be joined (BeginStart() was left out), whose handle
  // would be lost.
  bool StartConnectionThread(ThreadFunction function, void* context) {
    if (m_ConnectionThreadToJoin.load()) {
      return false;
    }
    if (!Threads::Create(&m_ConnectionThread, function, context)) {
      return false;
    }
    m_ConnectionThreadToJoin.store(true);
    return true;
  }

  // OnConnectionStopped(): returns whether this is the first stop since BeginStart(). A repeated stop (a double RED
  // press, the gamepad combo racing a termination by the host) must neither start a second stop thread nor tell the
  // front end twice.
  bool IssueStop() {
    return !m_StopIssued.exchange(true);
  }

  // Whether the stream was stopped since BeginStart(), for the connection thread, whose start a stop cancelled
  bool IsStopIssued() const {
    return m_StopIssued.load();
  }

  // OnConnectionStopped(), after IssueStop() returned true: creates the stop thread. Returns false when there is
  // none, because it could not be created, or because the one before is still to be joined.
  bool StartStopThread(ThreadFunction function, void* context) {
    if (m_StopThreadToJoin) {
      return false;
    }
    if (!Threads::Create(&m_StopThread, function, context)) {
      return false;
    }
    m_StopThreadToJoin = true;
    return true;
  }

  // The stop thread, before LiStopConnection(), and BeginStart(): joins the connection thread if it is still to be
  // joined, and returns whether this call did. Never from the connection thread itself, which is left to be joined by
  // another thread.
  bool JoinConnectionThread() {
    // The handle is only read once the flag says that it was written
    if (!m_ConnectionThreadToJoin.load() || Threads::IsCurrentThread(m_ConnectionThread)) {
      return false;
    }
    if (!m_ConnectionThreadToJoin.exchange(false)) {
      return false;
    }
    Threads::Join(m_ConnectionThread);
    return true;
  }

 private:
  Handle m_ConnectionThread = Handle();
  // Claimed by the stop thread or by the main thread
  std::atomic<bool> m_ConnectionThreadToJoin{false};
  Handle m_StopThread = Handle();
  // The stop thread is created by the thread that stops the stream, which tells the front end afterwards, and joined
  // on the main thread by the next start, which the front end asks for after that message at the earliest
  bool m_StopThreadToJoin = false;
  // Set by the thread that stops the stream and read by the connection thread
  std::atomic<bool> m_StopIssued{false};
  // Raised on the main thread and read by the threads that close the media source, and by its answer
  std::atomic<unsigned int> m_StartNumber{0};
};

typedef StreamThreadsOf<PlatformThreads> StreamThreads;

// The answer of the media source of the TV to Close(), which releases the two tracks of the stream that was closed
// (CloseMediaSource() in main.cpp). The stop waits for that answer for 5 seconds at most, so it can come after the
// next StartStream(), and the two tracks are members of the module that the next stream assigns its own tracks to: a
// late answer replaced the tracks of the new stream with empty ones, while its decoder thread appended packets to
// them. closingStart is StartNumber() at the moment Close() was called. An answer that comes after a later start
// leaves the tracks alone: they are the ones of that stream, or will be. Returns whether it released the tracks.
template <typename Threads, typename Track>
bool ReleaseTracksOfClosedSource(const StreamThreadsOf<Threads>& threads, unsigned int closingStart, Track& audioTrack,
                                 Track& videoTrack) {
  if (threads.StartNumber() != closingStart) {
    return false;
  }
  audioTrack = Track();
  videoTrack = Track();
  return true;
}
