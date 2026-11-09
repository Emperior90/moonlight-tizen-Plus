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
// One fault can give several lines. Where the SDK emulates the pipeline errors of an older player from the errors of
// the media element (_mediaElementRegisterOnErrorEMSS() of the glue code), an error of the element also reaches
// OnPipelineError() as a 'general error' with the same text: once from the DOM listener of the emulation, whose check
// for a listener of the app never skips (it receives the event object), and once more from the listener of the app
// (_mediaElementSetOnError()). So an HTMLMediaElement::OnError line followed by one or two EMSS::OnPipelineError lines
// of error 2 with the same text is one error of the element.
inline std::string FormatPlayerErrorLog(const char* origin, int error, const char* name, const char* message, bool streaming) {
  return std::string(origin) + " (error " + std::to_string(error) + ": " + name + ")" +
    (streaming ? " during the stream" : " without a running stream") + ": " +
    (message != nullptr && message[0] != '\0' ? std::string(message) : std::string("(no text)")) + "\n";
}

// The line of the log for a setup call of the video player that the player refused: the listeners of the media source
// and of the audio and video track, through which the app learns that each one opened or closed, and the media source
// of the media element. These calls return a samsung::wasm::Result<void>, whose operation_result is a value of
// samsung::wasm::OperationResult (in operation_result.h of the SDK, e.g. 4 for a listener that is already set or 7 for
// a function that this TV doesn't support). Until 2.3.1 the app ignored these results, so a player that refused one let
// the start wait out the 5 seconds of the media setup and end with -200 (unable to start the stream), with nothing in
// the log to say why. The start still goes on as before; the line only names the cause.
inline std::string FormatPlayerSetupRejectedLog(const char* call, int result) {
  return std::string("The video player of the TV rejected ") + call + " (error " + std::to_string(result) +
    "), so the start may wait in vain and end with -200\n";
}
