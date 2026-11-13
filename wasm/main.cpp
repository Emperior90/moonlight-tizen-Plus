#include "moonlight_wasm.hpp"
#include "audio_capabilities.hpp"
#include "audio_stream_stats.hpp"
#include "compact_stats.hpp"
#include "controller_type.hpp"
#include "diagnostic_log.hpp"
#include "host_encoder_restart.hpp"
#include "player_errors.hpp"
#include "video_config.hpp"
#include "wake_on_lan.hpp"

#include <algorithm>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include <pairing.h>
#include <iostream>

extern char* g_UniqueId;

#include <emscripten.h>
#include <emscripten/html5.h>

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <netinet/in.h>
#include <sys/socket.h>
#include <arpa/inet.h>

// Requests the Wasm module to connect to the specified server
#define MSG_START_REQUEST "startRequest"
// Requests the Wasm module to stop streaming
#define MSG_STOP_REQUEST "stopRequest"
// Sent by the Wasm module when streaming has stopped, whether requested by the user or not
#define MSG_STREAM_TERMINATED "streamTerminated: "
// Requests the Wasm module to open the specified URL
#define MSG_OPENURL "openUrl"

using EmssLatencyMode = samsung::wasm::ElementaryMediaStreamSource::LatencyMode;
using EmssRenderingMode = samsung::wasm::ElementaryMediaStreamSource::RenderingMode;

MoonlightInstance* g_Instance;

MoonlightInstance::MoonlightInstance()
  : m_AudioBackend(AudioBackend::Emss),
    m_AudioJitterMs(0),
    m_Running(false),
    m_OpusDecoder(NULL),
    m_MouseLocked(false),
    m_MouseLastPosX(-1),
    m_MouseLastPosY(-1),
    m_WaitingForAllModifiersUp(false),
    m_AccumulatedMilliTicks(0),
    m_MouseDeltaX(0),
    m_MouseDeltaY(0),
    m_HttpThreadPoolSequence(0),
    m_Dispatcher("Curl"),
    m_Mutex(),
    m_EmssStateChanged(),
    m_EmssAudioStateChanged(),
    m_EmssVideoStateChanged(),
    m_EmssReadyState(EmssReadyState::kDetached),
    m_AudioStarted(false),
    m_VideoStarted(false),
    m_AudioSessionId(0),
    m_VideoSessionId(0),
    m_MediaElementListener(this),
    m_MediaElement("wasm_module"),
    m_Source(nullptr),
    m_SourceListener(this),
    m_AudioTrackListener(this),
    m_VideoTrackListener(this),
    m_AudioTrack(),
    m_VideoTrack(),
    m_ConnectionCancelled(false),
    m_SourceClosed(false),
    m_SourceAttached(false) {
      m_Dispatcher.start();
      // Log the errors of the media element that the stream plays in (player_errors.hpp). The element stays for the life
      // of the module, so the listener is set once.
      if (!m_MediaElement.SetListener(&m_MediaElementListener)) {
        ClLogMessage("Setting the listener of the media element failed, so its errors are not logged\n");
      }
    }

MoonlightInstance::~MoonlightInstance() { 
  m_Dispatcher.stop();
}

void MoonlightInstance::OnConnectionStarted(uint32_t unused) {
  // Tell the front end
  PostToJs(std::string("Connection Established"));
}

void MoonlightInstance::OnConnectionStopped(uint32_t error) {
  // Stop only once per stream
  if (!m_StreamThreads.IssueStop()) {
    ClLogMessage("Ignoring a repeated stop request\n");
    return;
  }

  // Not running anymore
  m_Running = false;

  // Unlock the mouse
  UnlockMouse();

  // Spawn teardown thread to cleanup EMSS pipeline
  if (!m_StreamThreads.StartStopThread(MoonlightInstance::StopThreadFunc, NULL)) {
    ClLogMessage("Creating the stop thread failed, so the stream is not torn down\n");
  }

  // Notify the JS code that the stream has ended
  PostToJs(std::string(MSG_STREAM_TERMINATED + std::to_string((int)error)));
}

void MoonlightInstance::StopConnection() {
  // Also interrupts a connection that is still being started (CancelPendingSetup() in connectionlistener.cpp)
  CancelPendingSetup();

  // We'll need to call the listener ourselves since our connection terminated
  // callback won't be invoked for a manually requested termination.
  OnConnectionStopped(0);
}

void* MoonlightInstance::StopThreadFunc(void* context) {
  // We must join the connection thread first, because LiStopConnection must
  // not be invoked during LiStartConnection. Only a thread that is still to be joined
  // (stream_threads.hpp): a stop without a connection thread (it could not be created, the
  // renderer failed, or no stream was started) would join the thread of an earlier stream again.
  g_Instance->m_StreamThreads.JoinConnectionThread();

  // Force raise all modifier keys to avoid leaving them down after disconnecting
  LiSendKeyboardEvent(0xA0, KEY_ACTION_UP, 0);
  LiSendKeyboardEvent(0xA1, KEY_ACTION_UP, 0);
  LiSendKeyboardEvent(0xA2, KEY_ACTION_UP, 0);
  LiSendKeyboardEvent(0xA3, KEY_ACTION_UP, 0);
  LiSendKeyboardEvent(0xA4, KEY_ACTION_UP, 0);
  LiSendKeyboardEvent(0xA5, KEY_ACTION_UP, 0);

  // Not running anymore
  g_Instance->m_Running = false;

  // We also need to stop this thread after the connection thread, because it
  // depends on being initialized there. It's only started once the connection
  // is established, so there's nothing to join if the connection failed to start.
  if (g_Instance->m_InputThread != 0) {
    pthread_join(g_Instance->m_InputThread, NULL);
    g_Instance->m_InputThread = 0;
  }

  // Stop the connection
  LiStopConnection();

  // Close the media source to prepare for the next stream
  g_Instance->CloseMediaSource();

  return NULL;
}

void MoonlightInstance::CloseMediaSource() {
  if (!m_Source) {
    return;
  }

  {
    std::unique_lock<std::mutex> lock(m_Mutex);
    m_SourceClosed = false;
  }

  // Close the media source and release tracks to ensure WebKit garbage collection
  m_Source->Close([](samsung::wasm::OperationResult err) {
    g_Instance->m_AudioTrack = samsung::wasm::ElementaryMediaTrack();
    g_Instance->m_VideoTrack = samsung::wasm::ElementaryMediaTrack();

    std::unique_lock<std::mutex> lock(g_Instance->m_Mutex);
    g_Instance->m_SourceClosed = true;
    g_Instance->m_SourceClosedCV.notify_all();
  });

  // Synchronously wait for the source to close before returning, which prevents the
  // next StartStream from stomping on our teardown. The wait is bounded, because the
  // next StartStream waits for the teardown on the main thread, which would freeze
  // the whole application if the source never reported that it closed.
  std::unique_lock<std::mutex> lock(m_Mutex);
  if (!m_SourceClosedCV.wait_for(lock, std::chrono::seconds(5), [this] {
    return m_SourceClosed.load();
  })) {
    ClLogMessage("Timed out waiting for the media source to close\n");
  }

  // Reset EMSS state variables for the next stream
  m_EmssReadyState = EmssReadyState::kDetached;
  m_AudioStarted = false;
  m_VideoStarted = false;
  m_AudioSessionId = 0;
  m_VideoSessionId = 0;
  m_SourceAttached = false;
}

void* MoonlightInstance::InputThreadFunc(void* context) {
  MoonlightInstance* me = (MoonlightInstance*)context;

  while (me->m_Running) {
    me->PollGamepads();
    me->ReportMouseMovement();

    // Poll every 5 ms
    usleep(5 * 1000);
  }

  return NULL;
}

// Whether the codec modes from the server info of the host can be trusted for the codec negotiation. Hosts
// that don't report them send 0. Sunshine reports only H.264 when its encoder probe failed, e.g. because no
// display was attached yet (a virtual display that only appears at launch), and probes again at launch. The
// frontend reads the modes again after the launch request for that reason, but falls back to the earlier ones
// if that fails. Such a stale value would turn an HDR stream into 8-bit or drop AV1 for no reason, so it isn't
// trusted. A host that really can encode only H.264 still gets H.264, because the negotiation also checks the
// RTSP reply of the host.
static bool HasReliableHostCodecModes(int serverCodecModeSupport) {
  return serverCodecModeSupport > 0 && (serverCodecModeSupport & (SCM_MASK_HEVC | SCM_MASK_AV1)) != 0;
}

void* MoonlightInstance::ConnectionThreadFunc(void* context) {
  MoonlightInstance* me = (MoonlightInstance*)context;
  int err;
  SERVER_INFORMATION serverInfo;

  // Post a status update before we begin
  PostToJs(std::string("Starting connection to ") + me->m_Host);

  // Populate the server information
  LiInitializeServerInformation(&serverInfo);
  serverInfo.address = me->m_Host.c_str();
  serverInfo.serverInfoAppVersion = me->m_AppVersion.c_str();
  serverInfo.serverInfoGfeVersion = me->m_GfeVersion.c_str();
  serverInfo.rtspSessionUrl = me->m_RtspUrl.c_str();

  // Initialize the server codec mode support with default value
  serverInfo.serverCodecModeSupport = 0;
  // Handle setting of server codec mode support values ​​based on the selected video format
  if (me->m_StreamConfig.supportedVideoFormats & VIDEO_FORMAT_H264) { // H.264
    // Apply the appropriate value for the H.264 server codec
    serverInfo.serverCodecModeSupport |= SCM_H264;
    PostToJs("Selecting the server code mode to: SCM_H264");
  }
  if (me->m_StreamConfig.supportedVideoFormats & VIDEO_FORMAT_H265) { // HEVC
    // Apply the appropriate value for the HEVC server codec
    serverInfo.serverCodecModeSupport |= SCM_HEVC;
    PostToJs("Selecting the server code mode to: SCM_HEVC");
  }
  if (me->m_StreamConfig.supportedVideoFormats & VIDEO_FORMAT_H265_MAIN10) { // HEVC Main10
    // Apply the appropriate value for the HEVC Main10 server codec
    serverInfo.serverCodecModeSupport |= SCM_HEVC_MAIN10;
    PostToJs("Selecting the server code mode to: SCM_HEVC_MAIN10");
  }
  if (me->m_StreamConfig.supportedVideoFormats & VIDEO_FORMAT_AV1_MAIN8) { // AV1
    // Apply the appropriate value for the AV1 server codec
    serverInfo.serverCodecModeSupport |= SCM_AV1_MAIN8;
    PostToJs("Selecting the server code mode to: SCM_AV1_MAIN8");
  }
  if (me->m_StreamConfig.supportedVideoFormats & VIDEO_FORMAT_AV1_MAIN10) { // AV1 Main10
    // Apply the appropriate value for the AV1 Main10 server codec
    serverInfo.serverCodecModeSupport |= SCM_AV1_MAIN10;
    PostToJs("Selecting the server code mode to: SCM_AV1_MAIN10");
  }
  // Handle fall back logic for server codec mode support
  if (serverInfo.serverCodecModeSupport == 0) { // Unset
    // Fallback to H.264 if no server codec was selected
    serverInfo.serverCodecModeSupport = SCM_H264;
    PostToJs("Selecting the fallback server code mode to: SCM_H264");
  }
  // Use the codec modes that the host reported in its server info instead, like moonlight-qt does. The
  // negotiation then only picks a profile that the host can really encode, e.g. HEVC Main instead of a
  // Main10 stream that the encoder can't start. Hosts that don't report them keep the modes from above,
  // and so do hosts that report neither HEVC nor AV1 (see HasReliableHostCodecModes).
  if (HasReliableHostCodecModes(me->m_ServerCodecModeSupport)) {
    serverInfo.serverCodecModeSupport = me->m_ServerCodecModeSupport;
    char hostModes[64];
    snprintf(hostModes, sizeof(hostModes), "0x%x", (unsigned int)me->m_ServerCodecModeSupport);
    PostToJs(std::string("Using the server codec mode support of the host: ") + hostModes);
  }

  // Select the audio renderer capabilities for the backend and the setting 'Surround audio quality' (see
  // audio_capabilities.hpp), and log them by name
  const int audioCapabilities = GetAudioRendererCapabilities(me->m_AudioBackend == AudioBackend::WebAudio,
    me->m_EfficientSurroundAudio, me->m_StreamConfig.audioConfiguration);
  MoonlightInstance::s_ArCallbacks.capabilities = audioCapabilities;
  std::string audioCapabilityNames = "CAPABILITY_DIRECT_SUBMIT";
  if (audioCapabilities & CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION) {
    audioCapabilityNames += " | CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION";
  }
  if (audioCapabilities & CAPABILITY_SLOW_OPUS_DECODER) {
    audioCapabilityNames += " | CAPABILITY_SLOW_OPUS_DECODER";
  }
  PostToJs("Selecting the audio renderer capabilities to: " + audioCapabilityNames);

  // Initialize the video decoder capabilities. One slice per frame (the default) gives the best compression,
  // because the hardware decoder of the TV gets whole frames anyway. Several slices only help software decoders
  // that decode them in parallel, and each additional slice costs bits at the same bitrate.
  MoonlightInstance::s_DrCallbacks.capabilities = 0;
  // Handle setting of the reference frame invalidation capabilities based on the toggle switch state
  if (me->m_RefFrameInvalidationEnabled) {
    // Let the host recover from packet loss by invalidating the lost reference frames, instead of sending an IDR
    // frame, which is either much larger than the other frames (a traffic spike on the 100 Mbps Ethernet port of
    // the TV) or, when the encoder caps its size, visibly blurry. The recovery frame references an older frame, so
    // it keeps the usual size and quality. With Sunshine's NVENC encoder, the larger reference buffer that this
    // requests (5 frames for HEVC, 8 for AV1, instead of 1) only gives the host older frames to fall back on.
    // Every frame still references a single frame, so compression efficiency is unchanged. It's only enabled
    // for HEVC and AV1, because H.264 RFI is unreliable on many hardware decoders.
    MoonlightInstance::s_DrCallbacks.capabilities |= CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC | CAPABILITY_REFERENCE_FRAME_INVALIDATION_AV1;
    PostToJs("Selecting the video decoder capabilities to: CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC | CAPABILITY_REFERENCE_FRAME_INVALIDATION_AV1");
  } else {
    PostToJs("Selecting the video decoder capabilities to: none (one slice per frame)");
  }

  err = LiStartConnection(&serverInfo, &me->m_StreamConfig, &MoonlightInstance::s_ClCallbacks,
    &MoonlightInstance::s_DrCallbacks, &MoonlightInstance::s_ArCallbacks, NULL, 0, NULL, 0);
  if (err != 0) {
    // If the connection failed on its own, no stop thread will be started to tear it down,
    // so close the media source here. Otherwise it stays attached and the next stream can't
    // set up its media pipeline. This is done before notifying the JS code, so that the
    // next stream can't be started while the source is still closing.
    if (!me->m_ConnectionCancelled && me->m_SourceAttached) {
      me->CloseMediaSource();
    }

    // Notify the JS code that the stream has ended!
    // NB: We pass error code 0 here to avoid triggering a "Connection terminated" warning message.
    // The message is the last thing this thread does, and it doesn't wait for the front end to handle it
    // (PostToJsAsync()): no stop thread joins the thread of a start that failed on its own, so the next
    // StartStream() does, on the main thread (stream_threads.hpp). The front end starts that stream after this
    // message at the earliest, and this thread must not wait for the main thread then, which waits for it.
    if (me->m_ConnectionCancelled) {
      // A stop request that cancelled the start has already told the JS code
      if (!me->m_StreamThreads.IsStopIssued()) {
        PostToJsAsync(MSG_STREAM_TERMINATED + std::to_string(0));
      }
    } else {
      PostToJsAsync(MSG_STREAM_TERMINATED + std::to_string(err));
    }
    return NULL;
  }

  // Set running state before starting connection-specific threads
  me->m_Running = true;

  pthread_create(&me->m_InputThread, NULL, MoonlightInstance::InputThreadFunc, me);

  return NULL;
}

static void HexStringToBytes(const char* str, char* output) {
  for (size_t i = 0; i < strlen(str); i += 2) {
    sscanf(&str[i], "%2hhx", &output[i / 2]);
  }
}

MessageResult MoonlightInstance::StartStream(std::string host, int httpPort, std::string width, std::string height, std::string fps, std::string bitrate,
  std::string rikey, std::string rikeyid, std::string appversion, std::string gfeversion, std::string rtspurl, int serverCodecModeSupport,
  bool framePacing, bool optimizeGames, bool rumbleFeedback, bool mouseEmulation, std::string buttonMappings,
  std::string audioBackend, std::string audioConfig, bool audioSync, int audioJitterMs, bool playHostAudio, bool decryptHostAudio,
  std::string videoCodec, bool hdrMode, bool fullRange, bool gameMode, bool disableWarnings, int performanceStats,
  bool refFrameInvalidation, bool hdrMetadata, std::string controllerType, std::string surroundQuality) {
  
  // Wait for the teardown of the stream before (its stop thread), and join the connection thread of a start that
  // failed on its own, which no stop thread joined: until then it keeps its stack and its worker (stream_threads.hpp).
  // That thread posted its termination without waiting for the front end and returned, so this only waits for a
  // thread that is returning. Before the state below is reset, which that thread read.
  const uint64_t joinStartMs = LiGetMillis();
  if (m_StreamThreads.BeginStart()) {
    ClLogMessage("Joined the connection thread of the earlier start, which had failed on its own (%d ms)\n",
      (int)(LiGetMillis() - joinStartMs));
  }
  m_ConnectionCancelled = false;
  m_SourceClosed = false;
  m_SourceAttached = false;
  m_InputThread = 0;
  // The first HDR mode message of this stream is the one of its first encoder, which can arrive as soon as the control
  // stream connects, before the video decoder is set up (host_encoder_restart.hpp)
  GetHostEncoderRestarts().Reset();

  PostToJs("Setting the Host address to: " + host + ":" + std::to_string(httpPort));
  PostToJs("Setting the Video resolution to: " + width + "x" + height);
  PostToJs("Setting the Video frame rate to: " + fps + " FPS");
  PostToJs("Setting the Video bitrate to: " + bitrate + " Kbps");
  PostToJs("Setting the App version to: " + appversion);
  PostToJs("Setting the GFE version to: " + gfeversion);
  PostToJs("Setting the RTSP session URL to: " + rtspurl);
  PostToJs("Setting the Server codec mode support to: " + std::to_string(serverCodecModeSupport));
  PostToJs("Setting the Video frame pacing to: " + std::to_string(framePacing));
  PostToJs("Setting the Optimize game settings to: " + std::to_string(optimizeGames));
  PostToJs("Setting the Rumble feedback to: " + std::to_string(rumbleFeedback));
  PostToJs("Setting the Mouse emulation to: " + std::to_string(mouseEmulation));
  PostToJs("Setting the Button mapping to: " + std::to_string(std::count(buttonMappings.begin(), buttonMappings.end(), '\n') +
                                                                (buttonMappings.empty() ? 0 : 1)) + " controller lines");
  PostToJs("Setting the Controller type sent to the PC to: " + controllerType);
  PostToJs("Setting the Audio backend to: " + audioBackend);
  PostToJs("Setting the Audio configuration to: " + audioConfig);
  PostToJs("Setting the Surround audio quality to: " + surroundQuality);
  PostToJs("Setting the Audio synchronization to: " + std::to_string(audioSync));
  PostToJs("Setting the Audio jitter buffer to: " + std::to_string(audioJitterMs) + " ms");
  PostToJs("Setting the Play host audio to: " + std::to_string(playHostAudio));
  PostToJs("Setting the Decrypt host audio to: " + std::to_string(decryptHostAudio));
  PostToJs("Setting the Video codec to: " + videoCodec);
  PostToJs("Setting the Video HDR mode to: " + std::to_string(hdrMode));
  PostToJs("Setting the Full color range to: " + std::to_string(fullRange));
  PostToJs("Setting the Game mode to: " + std::to_string(gameMode));
  PostToJs("Setting the Disable connection warnings to: " + std::to_string(disableWarnings));
  PostToJs("Setting the Performance statistics to: " + std::to_string(performanceStats) + " (0 off, 1 compact, 2 full)");
  PostToJs("Setting the Reference frame invalidation to: " + std::to_string(refFrameInvalidation));
  PostToJs("Setting the HDR static metadata to: " + std::to_string(hdrMetadata));

  // Populate the stream configuration
  LiInitializeStreamConfiguration(&m_StreamConfig);
  m_StreamConfig.width = stoi(width);
  m_StreamConfig.height = stoi(height);
  m_StreamConfig.fps = stoi(fps);
  m_StreamConfig.bitrate = stoi(bitrate); // kilobits per second
  m_StreamConfig.packetSize = 1392;
  m_StreamConfig.streamingRemotely = STREAM_CFG_AUTO;

  // Initialize the audio backend with default value
  m_AudioBackend = AudioBackend::Emss;
  // Handle setting of the audio backend based on the selected backend
  if (audioBackend == "EMSS") { // Elementary Media Stream Source
    // Apply the appropriate value for the EMSS backend
    m_AudioBackend = AudioBackend::Emss;
    PostToJs("Selecting the audio backend to: AUDIO_BACKEND_EMSS");
  } else if (audioBackend == "WebAudio") { // Web Audio
    // Apply the appropriate value for the Web Audio backend
    m_AudioBackend = AudioBackend::WebAudio;
    PostToJs("Selecting the audio backend to: AUDIO_BACKEND_WEB_AUDIO");
  } else if (audioBackend == "Disabled") { // No audio output
    // Apply the appropriate value when the audio output is disabled
    m_AudioBackend = AudioBackend::Disabled;
    PostToJs("Selecting the audio backend to: AUDIO_BACKEND_DISABLED");
  } else { // Unknown
    // Default case for unsupported audio backend selection
    ClLogMessage("Unsupported audio backend '%s' detected! Reverting to the default backend...\n", audioBackend.c_str());
    PostToJs("Selecting the fallback audio backend to: AUDIO_BACKEND_EMSS");
  }

  // Initialize the audio configuration with default value
  m_StreamConfig.audioConfiguration = 0;
  // Handle setting of audio configuration values ​​based on the selected audio
  if (audioConfig == "Stereo") { // Stereo
    // Apply the appropriate value for the Stereo audio
    m_StreamConfig.audioConfiguration |= AUDIO_CONFIGURATION_STEREO;
    PostToJs("Selecting the audio config to: AUDIO_CONFIGURATION_STEREO");
  } else if (audioConfig == "51Surround") { // 5.1 Surround
    // Apply the appropriate value for the 5.1 Surround audio
    m_StreamConfig.audioConfiguration |= AUDIO_CONFIGURATION_51_SURROUND;
    PostToJs("Selecting the audio config to: AUDIO_CONFIGURATION_51_SURROUND");
  } else if (audioConfig == "71Surround") { // 7.1 Surround
    // Apply the appropriate value for the 7.1 Surround audio
    m_StreamConfig.audioConfiguration |= AUDIO_CONFIGURATION_71_SURROUND;
    PostToJs("Selecting the audio config to: AUDIO_CONFIGURATION_71_SURROUND");
  } else { // Unknown
    // Default case for unsupported audio selection
    ClLogMessage("Unsupported audio config '%s' detected! Reverting to the default audio...\n", audioConfig.c_str());
  }
  // Handle fall back logic for audio configuration
  if (m_StreamConfig.audioConfiguration == 0) { // Unset
    // Fallback to Stereo if no audio was selected
    m_StreamConfig.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
    PostToJs("Selecting the fallback audio config to: AUDIO_CONFIGURATION_STEREO");
  }
  // Store the audio configuration value from the stream configurations
  m_AudioConfig = m_StreamConfig.audioConfiguration;

  // The quality of a stream with more than 2 channels: Efficient, or High (also for any other value; the front end
  // sends one of the two, and Efficient where none was chosen), which the connection thread applies to 5.1 and 7.1
  // only (ConnectionThreadFunc())
  m_EfficientSurroundAudio = surroundQuality == "Efficient";
  if (!m_EfficientSurroundAudio) {
    PostToJs("Selecting the surround audio quality to: High");
  } else if (CHANNEL_COUNT_FROM_AUDIO_CONFIGURATION(m_StreamConfig.audioConfiguration) > 2) {
    PostToJs("Selecting the surround audio quality to: Efficient (normal quality, 10 ms packets)");
  } else {
    // The front end passes the setting whatever the audio configuration is, and stereo keeps its quality
    PostToJs("Selecting the surround audio quality to: Efficient (not applied: stereo)");
  }

  // Initialize the supported video format with default value
  m_StreamConfig.supportedVideoFormats = 0;
  // Handle setting of supported video format values ​​based on the selected codec
  if (videoCodec == "H264") { // H.264
    // Apply the appropriate value for the H.264 codec
    m_StreamConfig.supportedVideoFormats |= VIDEO_FORMAT_H264;
    PostToJs("Selecting the video format to: VIDEO_FORMAT_H264");
  } else if (videoCodec == "HEVC") { // HEVC
    // Apply the desired HDR or SDR profile ​for the HEVC codec based on the HDR toggle switch state
    m_StreamConfig.supportedVideoFormats |= hdrMode ? VIDEO_FORMAT_H265_MAIN10 : VIDEO_FORMAT_H265;
    PostToJs(hdrMode ? "Selecting the video format to: VIDEO_FORMAT_H265_MAIN10" : "Selecting the video format to: VIDEO_FORMAT_H265");
  } else if (videoCodec == "AV1") { // AV1
    // Leave AV1 out when the host reported its codec modes and can't encode AV1 at all, or can't encode it
    // in 10-bit for an HDR stream while it can encode HEVC Main10. The second case keeps HDR instead of an
    // 8-bit AV1 stream. Hosts without reliable codec modes are offered AV1 as before.
    bool hostLacksAv1 = false;
    if (HasReliableHostCodecModes(serverCodecModeSupport)) {
      if ((serverCodecModeSupport & SCM_MASK_AV1) == 0) {
        hostLacksAv1 = true;
      } else if (hdrMode && (serverCodecModeSupport & SCM_AV1_MAIN10) == 0 && (serverCodecModeSupport & SCM_HEVC_MAIN10) != 0) {
        hostLacksAv1 = true;
      }
    }
    if (!hostLacksAv1) {
      // Apply the desired HDR or SDR profile ​for the AV1 codec based on the HDR toggle switch state
      m_StreamConfig.supportedVideoFormats |= hdrMode ? VIDEO_FORMAT_AV1_MAIN10 : VIDEO_FORMAT_AV1_MAIN8;
      PostToJs(hdrMode ? "Selecting the video format to: VIDEO_FORMAT_AV1_MAIN10" : "Selecting the video format to: VIDEO_FORMAT_AV1_MAIN8");
    } else {
      PostToJs("Skipping the video format AV1, because the host can't encode it with the selected HDR mode");
    }
    // Offer HEVC with the same bit depth as a fallback. The negotiation checks AV1 first, so AV1 still wins
    // whenever the host offers it. Without this, a host that can't encode AV1 (or that re-probed its encoders
    // after the server info was fetched) would get a 4K H.264 stream without HDR, which the TV likely can't
    // decode, because Samsung TVs decode H.264 at most at level 5.1, which ends at 4K at 30 FPS.
    m_StreamConfig.supportedVideoFormats |= hdrMode ? VIDEO_FORMAT_H265_MAIN10 : VIDEO_FORMAT_H265;
    PostToJs(hdrMode ? "Selecting the fallback video format to: VIDEO_FORMAT_H265_MAIN10" : "Selecting the fallback video format to: VIDEO_FORMAT_H265");
  } else { // Unknown
    // Default case for unsupported codec selection
    ClLogMessage("Unsupported video codec '%s' detected! Reverting to the default codec...\n", videoCodec.c_str());
  }
  // Handle fall back logic for supported video formats
  if (m_StreamConfig.supportedVideoFormats == 0) { // Unset
    // Fallback to H.264 if no codec was selected
    m_StreamConfig.supportedVideoFormats = VIDEO_FORMAT_H264;
    PostToJs("Selecting the fallback video format to: VIDEO_FORMAT_H264");
  }
  // Remember the codec and bit depth that were selected, so that the video setup can tell the user when the
  // host could only provide a fallback (another codec, or SDR instead of HDR)
  if (videoCodec == "AV1") {
    m_RequestedVideoFormat = hdrMode ? VIDEO_FORMAT_AV1_MAIN10 : VIDEO_FORMAT_AV1_MAIN8;
  } else if (videoCodec == "HEVC") {
    m_RequestedVideoFormat = hdrMode ? VIDEO_FORMAT_H265_MAIN10 : VIDEO_FORMAT_H265;
  } else {
    m_RequestedVideoFormat = VIDEO_FORMAT_H264;
  }

  // Apply the color range of the toggle switch, which a stream with HDR on leaves at the limited range of HDR10 (see
  // GetStreamColorRange() in video_config.hpp)
  m_StreamConfig.colorRange = GetStreamColorRange(fullRange, hdrMode, m_StreamConfig.supportedVideoFormats);
  if (fullRange && m_StreamConfig.colorRange == COLOR_RANGE_LIMITED) {
    PostToJs("Selecting the color range to: COLOR_RANGE_LIMITED, because a stream with HDR on uses the limited range whatever the Full color range switch says");
  }

  // Request the Rec. 709 colorspace, which is the standard for HD and 4K video that the TV expects, instead
  // of the default Rec. 601 for SD video, which shifts the colors when the TV doesn't follow the stream's
  // colorspace info. HDR streams use Rec. 2020 regardless, because the host selects it for HDR displays.
  m_StreamConfig.colorSpace = COLORSPACE_REC_709;
  PostToJs("Selecting the colorspace to: COLORSPACE_REC_709");

  // Apply encryption audio only when decrypt host audio is enabled, otherwise disable encryption
  m_StreamConfig.encryptionFlags = decryptHostAudio ? ENCFLG_AUDIO : ENCFLG_NONE;

  // Load the rikey and rikeyid into the stream configuration
  HexStringToBytes(rikey.c_str(), m_StreamConfig.remoteInputAesKey);
  int rikeyiv = htonl(stoi(rikeyid));
  memcpy(m_StreamConfig.remoteInputAesIv, &rikeyiv, sizeof(rikeyiv));

  // Manage gamepad input states based on selected settings
  HandleGamepadInputState(rumbleFeedback, mouseEmulation, buttonMappings, GetControllerTypeFromSetting(controllerType));

  // Apply the desired latency mode ​based on the toggle switch state
  EmssLatencyMode selectedLatencyMode = gameMode ? EmssLatencyMode::kUltraLow : EmssLatencyMode::kLow;
  PostToJs(gameMode ? "Selecting the latency mode to: LATENCY_MODE_ULTRA_LOW" : "Selecting the latency mode to: LATENCY_MODE_LOW");
  // Create the media source with the selected latency and rendering modes
  m_Source = std::make_unique<samsung::wasm::ElementaryMediaStreamSource>(
    selectedLatencyMode,
    EmssRenderingMode::kMediaElement
  );
  // Set the source listener to the media source. Without it the app never learns that the source opened or closed, so
  // the start waits out the 5 seconds of the media setup and ends with -200 (unable to start the stream). Log a player
  // that rejects the listener, so that the diagnostic log names the cause of that -200.
  auto sourceListenerResult = m_Source->SetListener(&m_SourceListener);
  if (!sourceListenerResult) {
    ClLogMessage("%s", FormatPlayerSetupRejectedLog("the listener of the media source",
      static_cast<int>(sourceListenerResult.operation_result)).c_str());
  }

  // Store the parameters from the start message
  m_Host = host;
  m_AppVersion = appversion;
  m_GfeVersion = gfeversion;
  m_RtspUrl = rtspurl;
  m_ServerCodecModeSupport = serverCodecModeSupport;
  m_FramePacingEnabled = framePacing;
  m_AudioSyncEnabled = audioSync;
  m_AudioJitterMs = audioJitterMs;
  m_DisableWarningsEnabled = disableWarnings;
  m_PerformanceStatsLevel = ClampPerformanceStatsLevel(performanceStats);
  m_RefFrameInvalidationEnabled = refFrameInvalidation;
  m_HdrMetadataEnabled = hdrMetadata;

  // Initialize the rendering surface before starting the connection
  if (InitializeRenderingSurface(m_StreamConfig.width, m_StreamConfig.height)) {
    // Start the worker thread to establish the connection
    if (!m_StreamThreads.StartConnectionThread(MoonlightInstance::ConnectionThreadFunc, this)) {
      // Without the thread there is no connection: end the start like one whose renderer failed, instead of
      // leaving a start that never ends
      ClLogMessage("Creating the connection thread failed\n");
      OnConnectionStopped(0);
    }
  } else {
    // Failed to initialize renderer
    OnConnectionStopped(0);
  }

  return MessageResult::Resolve();
}

MessageResult MoonlightInstance::StopStream() {
  // Begin connection teardown
  StopConnection();

  return MessageResult::Resolve();
}

extern "C" void http_cancel_request();

MessageResult MoonlightInstance::CancelRequest() {
  ClLogMessage("%s: Canceling any ongoing HTTP request...\n", __func__);
  // Begin canceling the HTTP request
  http_cancel_request();

  return MessageResult::Resolve();
}

void MoonlightInstance::STUN_private(int callbackId) {
  unsigned int wanAddr;
  char addrStr[128] = {};

  if (LiFindExternalAddressIP4("stun.moonlight-stream.org", 3478, &wanAddr) == 0) {
    inet_ntop(AF_INET, &wanAddr, addrStr, sizeof(addrStr));
    PostPromiseMessage(callbackId, "resolve", std::string(addrStr, strlen(addrStr)));
  } else {
    PostPromiseMessage(callbackId, "resolve", "");
  }
}

void MoonlightInstance::STUN(int callbackId) {
  m_Dispatcher.post_job(std::bind(&MoonlightInstance::STUN_private, this, callbackId), false);
}

void MoonlightInstance::Pair_private(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber) {
  char* ppkstr = NULL;
  int err = gs_pair(atoi(serverMajorVersion.c_str()), address.c_str(), (unsigned short)httpPort, randomNumber.c_str(), &ppkstr);

  // The PIN stays out of the log, like the remote input key of a stream. A wrong PIN is GS_PIN_WRONG (-7), which
  // pairingDialog() in index.js reports as such.
  ClLogMessage("Paired host address: %s:%d with result: %d\n", address.c_str(), httpPort, err);
  if (err == 0) {
    PostPromiseMessage(callbackId, "resolve", ppkstr);
    free(ppkstr);
  } else {
    PostPromiseMessage(callbackId, "reject", std::to_string(err));
  }
}

void MoonlightInstance::Pair(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber) {
  ClLogMessage("%s with host address: %s:%d\n", __func__, address.c_str(), httpPort);
  m_Dispatcher.post_job(std::bind(&MoonlightInstance::Pair_private, this, callbackId, serverMajorVersion, address, httpPort, randomNumber), false);
}

void MoonlightInstance::WakeOnLan(int callbackId, std::string macAddress, std::string subnetBroadcast) {
  m_Dispatcher.post_job(std::bind(&MoonlightInstance::WakeOnLan_private, this, callbackId, macAddress, subnetBroadcast), false);
}

void MoonlightInstance::WakeOnLan_private(int callbackId, std::string macAddress, std::string subnetBroadcast) {
  unsigned char magicPacket[kMagicPacketSize];
  unsigned char mac[6];

  // Validate and parse the MAC address
  if (!ParseMacAddress(macAddress, mac)) {
    ClLogMessage("Invalid MAC address format: %s\n", macAddress.c_str());
    PostPromiseMessage(callbackId, "reject", "Invalid MAC address format");
    return;
  }

  // A host that didn't report its MAC address has 00:00:00:00:00:00, which no packet can wake. Say so at once, instead
  // of leaving the promise of the request unsettled and the dialog waiting forever.
  if (IsZeroMacAddress(mac)) {
    ClLogMessage("Not sending a magic packet: the MAC address of the host is unknown (%s)\n", macAddress.c_str());
    PostPromiseMessage(callbackId, "reject", kWakeOnLanUnknownMacError);
    return;
  }

  BuildMagicPacket(mac, magicPacket);

  // Create UDP socket
  int udpSocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (udpSocket == -1) {
    ClLogMessage("Failed to create socket\n");
    PostPromiseMessage(callbackId, "reject", "Failed to create socket");
    return;
  }

  // Enable broadcasting
  int broadcast = 1;
  if (setsockopt(udpSocket, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast)) == -1) {
    ClLogMessage("Failed to enable broadcast\n");
    close(udpSocket);
    PostPromiseMessage(callbackId, "reject", "Failed to enable broadcast");
    return;
  }

  // The limited broadcast, the broadcast address of the subnet of the TV and, over IPv6, the link-local all-nodes
  // address ff02::1 (wasm/wake_on_lan.hpp)
  std::vector<WakeOnLanTarget> targets;
  in_addr address;
  address.s_addr = htonl(INADDR_BROADCAST);
  targets.push_back(MakeWakeOnLanTarget(udpSocket, address));
  if (ParseSubnetBroadcastAddress(subnetBroadcast, &address)) {
    targets.push_back(MakeWakeOnLanTarget(udpSocket, address));
  }
  int udp6Socket = socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
  if (udp6Socket != -1) {
    in6_addr allNodes;
    inet_pton(AF_INET6, "ff02::1", &allNodes);
    targets.push_back(MakeWakeOnLanTarget(udp6Socket, allNodes));
  }

  const int sent = SendWakeOnLanRounds(targets,
    [&magicPacket](int socket, const sockaddr* destination, socklen_t length) {
      return sendto(socket, magicPacket, sizeof(magicPacket), 0, destination, length) == (ssize_t)sizeof(magicPacket);
    },
    [](int milliseconds) {
      usleep(milliseconds * 1000);
    });

  close(udpSocket);
  if (udp6Socket != -1) {
    close(udp6Socket);
  }

  ClLogMessage("Sent %d of %d magic packets to MAC address: %s (subnet broadcast: %s)\n", sent,
               kWakeOnLanRounds * (int)targets.size() * (int)(sizeof(kWakeOnLanPorts) / sizeof(kWakeOnLanPorts[0])),
               macAddress.c_str(), subnetBroadcast.empty() ? "unknown" : subnetBroadcast.c_str());
  if (sent == 0) {
    PostPromiseMessage(callbackId, "reject", "Failed to send magic packet to MAC address " + macAddress);
    return;
  }

  PostPromiseMessage(callbackId, "resolve", "Magic packet sent successfully to MAC address: " + macAddress);
}

int main(int argc, char** argv) {
  g_Instance = new MoonlightInstance();

  emscripten_set_keyup_callback(kCanvasName, NULL, EM_TRUE, handleKeyUp);
  emscripten_set_keydown_callback(kCanvasName, NULL, EM_TRUE, handleKeyDown);
  emscripten_set_mousedown_callback(kCanvasName, NULL, EM_TRUE, handleMouseDown);
  emscripten_set_mouseup_callback(kCanvasName, NULL, EM_TRUE, handleMouseUp);
  emscripten_set_mousemove_callback(kCanvasName, NULL, EM_TRUE, handleMouseMove);
  emscripten_set_wheel_callback(kCanvasName, NULL, EM_TRUE, handleWheel);

  // As we want to setup callbacks on DOM document and
  // emscripten_set_pointerlock... calls use document.querySelector
  // method, passing first argument to it, I've workaround for it
  // When passing address 0x1, js glue code replace it with document object
  static const char* kDocument = reinterpret_cast<const char*>(0x1);
  emscripten_set_pointerlockchange_callback(kDocument, NULL, EM_TRUE, handlePointerLockChange);
  emscripten_set_pointerlockerror_callback(kDocument, NULL, EM_TRUE, handlePointerLockError);
  EM_ASM(Module['noExitRuntime'] = true);
  unsigned char buffer[128];
  int rc = RAND_bytes(buffer, sizeof(buffer));

  if (rc != 1) {
    std::cout << "RAND_bytes failed\n";
  }
  RAND_seed(buffer, 128);
}

MessageResult startStream(std::string host, int httpPort, std::string width, std::string height, std::string fps, std::string bitrate,
  std::string rikey, std::string rikeyid, std::string appversion, std::string gfeversion, std::string rtspurl, int serverCodecModeSupport,
  bool framePacing, bool optimizeGames, bool rumbleFeedback, bool mouseEmulation, std::string buttonMappings,
  std::string audioBackend, std::string audioConfig, bool audioSync, int audioJitterMs, bool playHostAudio, bool decryptHostAudio,
  std::string videoCodec, bool hdrMode, bool fullRange, bool gameMode, bool disableWarnings, int performanceStats,
  bool refFrameInvalidation, bool hdrMetadata, std::string controllerType, std::string surroundQuality) {
  PostToJs("Starting the streaming session...");
  return g_Instance->StartStream(host, httpPort, width, height, fps, bitrate, rikey, rikeyid, appversion, gfeversion, rtspurl, serverCodecModeSupport,
  framePacing, optimizeGames, rumbleFeedback, mouseEmulation, buttonMappings, audioBackend, audioConfig, audioSync,
  audioJitterMs, playHostAudio, decryptHostAudio, videoCodec, hdrMode, fullRange, gameMode, disableWarnings, performanceStats,
  refFrameInvalidation, hdrMetadata, controllerType, surroundQuality);
}

MessageResult stopStream() {
  PostToJs("Stopping the streaming session...");
  return g_Instance->StopStream();
}

MessageResult cancelRequest() {
  return g_Instance->CancelRequest();
}

void toggleStats() {
  g_Instance->TogglePerformanceStats();
}

// Called by 'Refresh picture' of the Stream Menu on the main thread (wasm/platform/menus.js): asks the host for a
// keyframe, and answers whether it did, which it doesn't without a running stream (RefreshPicture() in wasmplayer.cpp)
bool requestIdrFrame() {
  return g_Instance->RefreshPicture();
}

// Called by the Stream Menu on the main thread (wasm/platform/menus.js), which shows its surround quality entry only for
// more than 2 channels: the channels of the audio stream that the module decodes, as the RTSP negotiation settled on
// them (AudDecInit() in auddec.cpp), 0 before its setup and while the audio output is disabled
int getAudioChannelCount() {
  return g_AudioStreamStats.channelCount.load();
}

// Called by the front end on the main thread for the diagnostic log (wasm/platform/diagnostics.js): the lines that the
// module logged since the last call, one per line as "<time in ms>\t<text>" (diagnostic_log.hpp)
std::string takeDiagnosticLog() {
  return GetDiagnosticLog().Take();
}

void stun(int callbackId) {
  g_Instance->STUN(callbackId);
}

void pair(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber, std::string uniqueId) {
  if (g_UniqueId) {
    free(g_UniqueId);
  }
  g_UniqueId = strdup(uniqueId.c_str());
  g_Instance->Pair(callbackId, serverMajorVersion, address, httpPort, randomNumber);
}

void wakeOnLan(int callbackId, std::string macAddress, std::string subnetBroadcast) {
  g_Instance->WakeOnLan(callbackId, macAddress, subnetBroadcast);
}

// The JavaScript of the calls below, and of every other MAIN_THREAD_EM_ASM block, runs on the main thread for a native
// thread: while that thread waits for it (MAIN_THREAD_EM_ASM), or later from the queue of proxied calls
// (MAIN_THREAD_ASYNC_EM_ASM). An exception that left such a body would never tell the waiting thread that the call is
// done, and Emscripten 1.39 then stops running proxied calls on the main thread at all (the nesting flag of
// emscripten_current_thread_process_queued_calls() in library_pthread.c stays set), which froze the whole app during a
// stream: a frozen picture, no sound, no input. So each body catches what its handler throws and logs it instead.
// unit/em-asm-guards.test.js runs every block with handlers that throw. The idea comes from the fork of mmadej20
// (moonlight-tizen-modern, gamepad_sampling.hpp of 0b2d840).
void PostToJs(std::string msg) {
  MAIN_THREAD_EM_ASM({
    try {
      handleMessage(UTF8ToString($0));
    } catch (e) {
      console.error('%c[main.cpp, PostToJs]', 'color: gray;', 'Error: handleMessage() failed:', e);
    }
  }, msg.c_str());
}

void PostToJsAsync(std::string msg) {
  // The main thread runs this after the call returns, so hand it a copy that it frees itself
  char* copy = strdup(msg.c_str());
  if (copy == nullptr) {
    return;
  }

  MAIN_THREAD_ASYNC_EM_ASM({
    try {
      const msg = UTF8ToString($0);
      _free($0);
      handleMessage(msg);
    } catch (e) {
      console.error('%c[main.cpp, PostToJsAsync]', 'color: gray;', 'Error: handleMessage() failed:', e);
    }
  }, copy);
}

void PostPromiseMessage(int callbackId, const std::string& type, const std::string& response) {
  MAIN_THREAD_EM_ASM({
    try {
      handlePromiseMessage($0, UTF8ToString($1), UTF8ToString($2));
    } catch (e) {
      console.error('%c[main.cpp, PostPromiseMessage]', 'color: gray;', 'Error: handlePromiseMessage() failed:', e);
    }
  }, callbackId, type.c_str(), response.c_str());
}

void PostPromiseMessage(int callbackId, const std::string& type, const std::vector<uint8_t>& response) {
  MAIN_THREAD_EM_ASM({
    try {
      handlePromiseMessage($0, UTF8ToString($1), HEAPU8.slice($2, $2 + $3));
    } catch (e) {
      console.error('%c[main.cpp, PostPromiseMessage]', 'color: gray;', 'Error: handlePromiseMessage() failed:', e);
    }
  }, callbackId, type.c_str(), response.data(), response.size());
}

EMSCRIPTEN_BINDINGS(handle_message) {
  emscripten::value_object<MessageResult>("MessageResult").field("type", &MessageResult::type).field("ret", &MessageResult::ret);
  emscripten::function("startStream", &startStream);
  emscripten::function("stopStream", &stopStream);
  emscripten::function("cancelRequest", &cancelRequest);
  emscripten::function("toggleStats", &toggleStats);
  emscripten::function("setStreamMenuOpen", &setStreamMenuOpen);
  emscripten::function("toggleMouseEmulation", &toggleMouseEmulation);
  emscripten::function("requestIdrFrame", &requestIdrFrame);
  emscripten::function("getAudioChannelCount", &getAudioChannelCount);
  emscripten::function("takeDiagnosticLog", &takeDiagnosticLog);
  emscripten::function("stun", &stun);
  emscripten::function("pair", &pair);
  emscripten::function("wakeOnLan", &wakeOnLan);
}
