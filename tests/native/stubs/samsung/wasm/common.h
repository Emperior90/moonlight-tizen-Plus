#pragma once
// Host stand-ins for the Samsung Tizen WASM Player API (samsung::wasm), with the types and members the app's native
// code uses. Every operation succeeds and does nothing; the native tests don't play media. A test can watch the packets
// that the app appends and choose the result of each append with TestAppendPacketHook() (see frame_pacer_test.cpp).
#include <chrono>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>
namespace samsung { namespace wasm {
using Seconds = std::chrono::duration<double>;
using SessionId = uint32_t;
enum class OperationResult { kSuccess, kFailed };
// The errors of the media pipeline of SDK 1.39.4.7 (OnPipelineError), in the order of MediaPipelineError of its glue
enum class MediaPipelineError { kConfigError, kDrmError, kGeneralError, kOutOfMemory, kUnknownError };
enum class DecodingMode { kHardware, kSoftware };
enum class SampleFormat { kS16 };
enum class ChannelLayout { kStereo, k5_1, k7_1 };
template<typename T> struct Result { OperationResult operation_result; T value; explicit operator bool() const { return operation_result == OperationResult::kSuccess; } T& operator*() { return value; } };
template<> struct Result<void> { OperationResult operation_result; explicit operator bool() const { return operation_result == OperationResult::kSuccess; } };
struct ElementaryMediaPacket { Seconds pts; Seconds dts; Seconds duration; bool is_key_frame; size_t data_size; const void* data; uint32_t width; uint32_t height; uint32_t framerate_num; uint32_t framerate_den; SessionId session_id; };
struct ElementaryAudioTrackConfig { std::string mimeType; std::vector<uint8_t> extradata; DecodingMode decoding_mode; SampleFormat sample_format; ChannelLayout channel_layout; uint32_t sample_rate; };
struct ElementaryVideoTrackConfig { std::string mimeType; std::vector<uint8_t> extradata; DecodingMode decoding_mode; uint32_t width; uint32_t height; uint32_t framerate_num; uint32_t framerate_den; };
// Called with every appended packet when set; it returns the result as a value of OperationResult of the real API
// (e.g. 29 for a full buffer), which the app reads as a number
using AppendPacketHook = std::function<int(const ElementaryMediaPacket&)>;
inline AppendPacketHook& TestAppendPacketHook() { static AppendPacketHook hook; return hook; }
class ElementaryMediaTrackListener;
class ElementaryMediaTrack {
 public:
  enum class CloseReason { kSourceClosed, kSourceError, kSourceDetached, kSourceSuspended, kTrackDisabled, kTrackEnded, kTrackSeeking, kUnknown };
  ElementaryMediaTrack() = default;
  ElementaryMediaTrack(ElementaryMediaTrack&&) = default;
  ElementaryMediaTrack& operator=(ElementaryMediaTrack&&) = default;
  Result<void> AppendPacket(const ElementaryMediaPacket& packet) { const AppendPacketHook& hook = TestAppendPacketHook(); return {hook ? static_cast<OperationResult>(hook(packet)) : OperationResult::kSuccess}; }
  void SetListener(ElementaryMediaTrackListener*) {}
};
class ElementaryMediaTrackListener {
 public:
  virtual ~ElementaryMediaTrackListener() = default;
  virtual void OnTrackOpen() {}
  virtual void OnTrackClosed(ElementaryMediaTrack::CloseReason) {}
  virtual void OnSessionIdChanged(SessionId) {}
};
class ElementaryMediaStreamSourceListener {
 public:
  virtual ~ElementaryMediaStreamSourceListener() = default;
  virtual void OnSourceOpen() {}
  virtual void OnSourceOpenPending() {}
  virtual void OnSourceClosed() {}
  virtual void OnPipelineError(MediaPipelineError, const char*) {}
};
class ElementaryMediaStreamSource {
 public:
  enum class ReadyState { kDetached, kClosed, kOpenPending, kOpen, kEnded };
  enum class LatencyMode { kNormal, kLow, kUltraLow };
  enum class RenderingMode { kMediaElement, kVideoTexture };
  ElementaryMediaStreamSource(LatencyMode, RenderingMode) {}
  Result<ElementaryMediaTrack> AddTrack(const ElementaryAudioTrackConfig&) { return {OperationResult::kSuccess, {}}; }
  Result<ElementaryMediaTrack> AddTrack(const ElementaryVideoTrackConfig&) { return {OperationResult::kSuccess, {}}; }
  void Open(std::function<void(OperationResult)>) {}
  void Close(std::function<void(OperationResult)>) {}
  void SetListener(ElementaryMediaStreamSourceListener*) {}
};
}}
