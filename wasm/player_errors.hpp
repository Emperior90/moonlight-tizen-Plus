#pragma once
// The lines of the diagnostic log for the errors that the video player of the TV reports on its own, outside the calls
// of the app: an error of the media pipeline (ElementaryMediaStreamSourceListener::OnPipelineError() of the Samsung SDK
// 1.39.4.7, whose public headers lack it while the glue code of the build has it) and an error of the HTML media
// element (HTMLMediaElementListener::OnError()). Until now neither left a trace, so a frozen picture without a track
// close had no explanation in the log. The listeners in wasm/wasmplayer.cpp only log them and change nothing in the
// stream. The header has no other dependencies, so the native tests can check it on its own
// (tests/native/player_errors_test.cpp).

#include <string>

// Name of an error of the media pipeline, by its value in samsung::wasm::MediaPipelineError, which follows the
// MediaPipelineError of the EMSS glue (CONFIG_ERROR = 0, DRM_ERROR, GENERAL_ERROR, OUT_OF_MEMORY, UNKNOWN_ERROR)
inline const char* MediaPipelineErrorName(int error) {
  static const char* const kNames[] = {"configuration error", "DRM error", "general error", "out of memory", "unknown error"};
  return error >= 0 && error < static_cast<int>(sizeof(kNames) / sizeof(kNames[0])) ? kNames[error] : "unknown error";
}

// Name of an error of the HTML media element, by its value in samsung::html::MediaError, which follows the codes of
// MediaError of HTML (MEDIA_ERR_ABORTED = 1, MEDIA_ERR_NETWORK, MEDIA_ERR_DECODE, MEDIA_ERR_SRC_NOT_SUPPORTED)
inline const char* MediaElementErrorName(int error) {
  static const char* const kNames[] = {"aborted", "network error", "decode error", "source not supported"};
  return error >= 1 && error <= static_cast<int>(sizeof(kNames) / sizeof(kNames[0])) ? kNames[error - 1] : "unknown error";
}

// The line of the log for an error of the player: where it came from, its value and name, whether a stream was running
// (an error while the app tears the player down is expected), and the text of the player. Samsung owns the text only
// during the call of the listener, so it is copied into the line at once.
inline std::string FormatPlayerErrorLog(const char* origin, int error, const char* name, const char* message, bool streaming) {
  return std::string(origin) + " (error " + std::to_string(error) + ": " + name + ")" +
    (streaming ? " during the stream" : " without a running stream") + ": " +
    (message != nullptr && message[0] != '\0' ? std::string(message) : std::string("(no text)")) + "\n";
}
