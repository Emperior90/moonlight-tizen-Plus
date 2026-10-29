#include "moonlight_wasm.hpp"
#include "connection_ports.hpp"

#include <cstdarg>
#include <cstring>
#include <string>

#include <emscripten.h>
#include <emscripten/threading.h>

void MoonlightInstance::CancelPendingSetup() {
  // Mark the connection as cancelled and wake up the media pipeline setup if it's waiting,
  // so that the connection thread can return from LiStartConnection. The flag is set while
  // holding the mutex, so that a wait that is just about to start can't miss the wake-up.
  {
    std::unique_lock<std::mutex> lock(m_Mutex);
    m_ConnectionCancelled = true;
    m_EmssStateChanged.notify_all();
    m_EmssAudioStateChanged.notify_all();
    m_EmssVideoStateChanged.notify_all();
  }

  // Interrupt a connection that is still being started, so that LiStartConnection gives up at its next step (the RTSP
  // requests and the ENet waits check the flag) instead of setting up the whole stream for nothing: the host stops
  // building the session sooner, and a quick restart waits less for the connection thread. A TCP connect or an RTSP
  // receive that is already running still takes its time (up to 15 s). LiStartConnection clears the flag when it
  // begins, so ClStageStarting() sets it again for a stop that came before that. The idea comes from the fork of
  // mmadej20 (moonlight-tizen-modern, e7d877b).
  LiInterruptConnection();
}

void MoonlightInstance::ClStageStarting(int stage) {
  // LiStartConnection clears the interrupt flag at its start (Connection.c), after which a stop that came during the
  // start of the connection thread would be lost. The first stage starts after that, so interrupt again here.
  if (g_Instance && g_Instance->m_ConnectionCancelled) {
    LiInterruptConnection();
  }
  PostToJs(std::string("ProgressMsg: Starting ") + std::string(LiGetStageName(stage)) + std::string("..."));
}

// The ports of the host PC in the port flags of moonlight-common-c, as the stream uses them: the default ports of
// LiStringifyPortFlags(), moved like the RTSP port in the session URL of the host (wasm/connection_ports.hpp), e.g.
// TCP 50021 instead of TCP 48010 for a Sunshine host with the port 50000, or "" when there are none
static std::string GetHostPortList(unsigned int portFlags) {
  char ports[kPortListLength];
  LiStringifyPortFlags(portFlags, ", ", ports, sizeof(ports));
  return MovePortList(ports, g_Instance ? GetPortOffsetFromSessionUrl(g_Instance->GetRtspUrl()) : 0);
}

void MoonlightInstance::ClStageFailed(int stage, int errorCode) {
  if (g_Instance && g_Instance->m_ConnectionCancelled) {
    return;
  }
  // The stream termination message already explains why the video setup failed
  if (stage == STAGE_VIDEO_STREAM_START && errorCode == ERROR_VIDEO_SETUP_FAILED) {
    return;
  }
  // Name the ports of the host PC that the stage needs, which a firewall or the router may block (e.g. TCP 48010,
  // UDP 48000 and UDP 48010 for the RTSP handshake)
  PostToJs(std::string("DialogMsg: ") + FormatStageFailedMessage(LiGetStageName(stage), errorCode,
                                                                   GetHostPortList(LiGetPortFlagsFromStage(stage))));
}

void MoonlightInstance::ClConnectionStarted(void) {
  emscripten_sync_run_in_main_runtime_thread(EM_FUNC_SIG_V, onConnectionStarted);
}

void MoonlightInstance::ClConnectionTerminated(int errorCode) {
  // Name the ports of the host PC that the cause of the termination points to (UDP 47998 and UDP 48000 when no video
  // arrived), which the message of the termination that follows shows
  const std::string ports = GetHostPortList(LiGetPortFlagsFromTerminationErrorCode(errorCode));
  if (!ports.empty()) {
    PostToJs(std::string("TerminationPortsMsg: ") + ports);
  }

  // The host can end the connection while it's still being started, for example when the
  // TV never starts the video stream. Wake up the media pipeline setup in that case, so
  // that the connection thread returns and the stop thread can join it. Otherwise both
  // stay blocked, and the next stream freezes the application while waiting for them.
  g_Instance->CancelPendingSetup();

  // Leave the teardown to the stop thread that OnConnectionStopped starts, which joins the
  // connection thread first, because LiStopConnection must not be invoked during
  // LiStartConnection. Stopping here as well would run a second LiStopConnection at the same
  // time as the stop thread of a stop request (RED, the gamepad combo) that comes in meanwhile.
  emscripten_sync_run_in_main_runtime_thread(EM_FUNC_SIG_VI, onConnectionStopped, errorCode);
}

void MoonlightInstance::ClDisplayMessage(const char* message) {
  if (g_Instance && g_Instance->m_ConnectionCancelled) {
    return;
  }
  PostToJs(std::string("DialogMsg: ") + std::string(message));
}

void MoonlightInstance::ClDisplayTransientMessage(const char* message) {
  PostToJs(std::string("TransientMsg: ") + std::string(message));
}

void onConnectionStarted() {
  g_Instance->OnConnectionStarted(0);
}

void onConnectionStopped(int errorCode) {
  g_Instance->OnConnectionStopped(errorCode);
}

void MoonlightInstance::ClLogMessage(const char* format, ...) {
  va_list va;
  char message[1024];

  va_start(va, format);
  vsnprintf(message, sizeof(message), format, va);
  va_end(va);

  // fprintf(stderr, ...) processes message in parts, so logs from different
  // threads may interleave. Send whole message at once to minimize this.
  emscripten_log(EM_LOG_CONSOLE, "%s", message);
}

void MoonlightInstance::ClConnectionStatusUpdate(int connectionStatus) {
  // This runs on the video receive thread, so the message is posted without waiting for the main thread,
  // otherwise the UDP socket would not be drained while the main thread is busy
  if (g_Instance->m_DisableWarningsEnabled == false) {
    switch (connectionStatus) {
      case CONN_STATUS_OKAY:
        PostToJsAsync(std::string("NoWarningMsg: ") + std::string("Connection to PC has been improved."));
        break;
      case CONN_STATUS_POOR:
        PostToJsAsync(std::string("WarningMsg: ") + std::string("Slow connection to PC.\nReduce your bitrate!"));
        break;
      default:
        break;
    }
  }
}

CONNECTION_LISTENER_CALLBACKS MoonlightInstance::s_ClCallbacks = {
  .stageStarting = MoonlightInstance::ClStageStarting,
  .stageFailed = MoonlightInstance::ClStageFailed,
  .connectionStarted = MoonlightInstance::ClConnectionStarted,
  .connectionTerminated = MoonlightInstance::ClConnectionTerminated,
  .logMessage = MoonlightInstance::ClLogMessage,
  .rumble = MoonlightInstance::ClControllerRumble,
  .connectionStatusUpdate = MoonlightInstance::ClConnectionStatusUpdate,
  .setHdrMode = MoonlightInstance::ClSetHdrMode,
};
