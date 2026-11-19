// Checks the cap of the decode buffer in the video decoder path (VidDecSubmitDecodeUnit() of wasm/wasmplayer.cpp,
// included directly), which Moonlight Plus added in 2.3.1 with the bound of upstream moonlight-common-c bf71226 on the
// reassembly of a frame: the buffer grows on demand up to the largest frame that the depacketizer reassembles (32 MiB)
// with the room reserved in a keyframe (MAX_DECODE_BUFFER_LEN). A larger frame is not copied or appended: the path
// returns DR_NEED_IDR, after which moonlight-common-c flushes its queue and asks the host for a keyframe, and it logs
// one line per stream. Before, the buffer grew to the size of any frame in the fixed heap of the module (128 MB), where a
// failed allocation aborts the module. The frame of the largest size still goes through, and the allocated capacity of
// the buffer stays within the cap when it grows in steps. The functions below stand in
// for moonlight-common-c and the rest of the module, like in hdr_metadata_submit_test.cpp.

#include "../../wasm/wasmplayer.cpp"

#include "test_support.h"

#include <cstdarg>
#include <cstring>
#include <string>
#include <vector>

AudioStreamStats g_AudioStreamStats;
MoonlightInstance* g_Instance = nullptr;

// The test sets that the video track is open, a private member that the module writes itself. An explicit template
// instantiation is the one place where C++ lets code name a private member, so PrivateMember hands out a pointer to it.
template <typename Tag, typename Tag::Type Member>
struct PrivateMember {
  friend typename Tag::Type Pointer(Tag) {
    return Member;
  }
};
struct VideoStartedMember {
  using Type = std::atomic<bool> MoonlightInstance::*;
  friend Type Pointer(VideoStartedMember);
};
template struct PrivateMember<VideoStartedMember, &MoonlightInstance::m_VideoStarted>;

static uint64_t nowMs = 0;
static size_t appendedFrames = 0;
static size_t lastAppendedSize = 0;
static std::vector<std::string> logged;

uint64_t LiGetMillis(void) {
  return nowMs;
}
uint64_t LiGetMicroseconds(void) {
  return nowMs * 1000;
}
void LiRequestIdrFrame(void) {}
bool LiGetHdrMetadata(PSS_HDR_METADATA) {
  return false;
}
uint32_t LiGetClientVideoResets(void) {
  return 0;
}
bool LiHostSupportsReferenceFrameInvalidation(void) {
  return false;
}
void LiGetIdrFrameRequestStats(uint32_t* sent, uint32_t* held, uint32_t* slowestAnswerMs) {
  *sent = 0;
  *held = 0;
  *slowestAnswerMs = 0;
}
uint32_t LiGetClientDroppedVideoFrames(void) {
  return 0;
}
int LiGetPendingVideoFrames(void) {
  return 0;
}
bool LiGetEstimatedRttInfo(uint32_t* estimatedRtt, uint32_t* estimatedRttVariance) {
  *estimatedRtt = 3;
  *estimatedRttVariance = 1;
  return true;
}
bool LiGetCurrentHostDisplayHdrMode(void) {
  return false;
}
void LiGetVideoNetworkStats(PVIDEO_NETWORK_STATS stats) {
  std::memset(stats, 0, sizeof(*stats));
}
void LiTerminateConnectionAsync(int) {}
void PostToJs(std::string) {}
void PostToJsAsync(std::string) {}
void MoonlightInstance::ClLogMessage(const char* format, ...) {
  char line[1024];
  va_list args;
  va_start(args, format);
  std::vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  logged.push_back(line);
}
void MoonlightInstance::CancelPendingSetup() {}
void MoonlightInstance::OnConnectionStopped(uint32_t) {}

// The instance and the decoder state of a running 4K60 HEVC stream, as StartStream() and VidDecSetup() leave them.
// The instance is never constructed (the vptr check of UBSan is off for this reason, see run.sh).
static void StartStream() {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  std::memset(storage, 0, sizeof(storage));
  g_Instance = reinterpret_cast<MoonlightInstance*>(storage);
  g_Instance->*Pointer(VideoStartedMember()) = true;
  nowMs = 100000;
  appendedFrames = 0;
  lastAppendedSize = 0;
  logged.clear();

  s_VideoFormat = VIDEO_FORMAT_H265;
  s_Width = 3840;
  s_Height = 2160;
  s_Framerate = 60;
  s_frameDuration = TimeStamp(1.0 / 60);
  s_pktPts = 0s;
  s_FramePacingEnabled = false;
  ResetHdrMetadataState(false);
  s_DecodeBuffer.clear();
  s_DecodeBuffer.shrink_to_fit();
  s_DecodeBuffer.resize(INITIAL_DECODE_BUFFER_LEN);
  s_OversizedFrameLogged = false;
  s_StatString.assign(4096, 0);
  ResetFrameIntervalClock(s_HostIntervalClock);
  ResetFrameIntervalClock(s_PlayerIntervalClock);
  for (int i = 0; i < 2; i++) {
    ResetFrameIntervals(s_HostIntervals[i]);
    ResetFrameIntervals(s_PlayerIntervals[i]);
  }
  memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));
  memset(&m_LastWndVideoStats, 0, sizeof(m_LastWndVideoStats));
  memset(&m_GlobalVideoStats, 0, sizeof(m_GlobalVideoStats));
  m_LastFrameNumber = 0;
  total_bytes = 0;
  s_ReceivedFirstIdrFrame = false;
  s_RecoveryIdrFrames = 0;
  s_ResetsAtLastIdr = 0;
  s_PendingIdrCauses = 0;
  s_ExpectedIdrFrame.store(false);
  GetHostEncoderRestarts().Reset();
  s_SessionTvDroppedFrames = 0;
  s_SessionStartMs = nowMs;
  ResetHostFrameRate();
  s_TerminatingStream = false;
  samsung::wasm::TestAppendPacketHook() = [](const samsung::wasm::ElementaryMediaPacket& packet) {
    appendedFrames++;
    lastAppendedSize = packet.data_size;
    return 0;
  };
}

// Submit one frame of `length` bytes in one buffer, as a keyframe (with its parameter sets in front) or a P-frame
static int Submit(int frameNumber, bool idr, size_t length) {
  static const unsigned char kParameterSets[] = {0x00, 0x00, 0x00, 0x01, 0x40, 0x01, 0x0C, 0x01};
  std::vector<unsigned char> data(length, 0x5A);
  LENTRY parameterSets = {};
  LENTRY picture = {};
  picture.bufferType = BUFFER_TYPE_PICDATA;
  picture.data = reinterpret_cast<char*>(data.data());
  picture.length = (int)length;
  DECODE_UNIT unit = {};
  unit.frameNumber = frameNumber;
  unit.frameType = idr ? FRAME_TYPE_IDR : FRAME_TYPE_PFRAME;
  unit.presentationTimeMs = (unsigned int)(frameNumber * 1000 / 60);
  nowMs = 100000 + unit.presentationTimeMs;
  unit.receiveTimeMs = nowMs - 3;
  unit.enqueueTimeMs = nowMs - 2;
  unit.receiveTimeUs = unit.receiveTimeMs * 1000;
  unit.enqueueTimeUs = unit.enqueueTimeMs * 1000;
  unit.fullLength = (int)length;
  unit.bufferList = &picture;
  if (idr) {
    parameterSets.bufferType = BUFFER_TYPE_VPS;
    parameterSets.data = const_cast<char*>(reinterpret_cast<const char*>(kParameterSets));
    parameterSets.length = (int)sizeof(kParameterSets);
    parameterSets.next = &picture;
    unit.bufferList = &parameterSets;
    unit.fullLength += parameterSets.length;
  }
  return MoonlightInstance::VidDecSubmitDecodeUnit(&unit);
}

static int CountLogs(const char* start) {
  int count = 0;
  for (const std::string& line : logged) {
    if (line.compare(0, std::strlen(start), start) == 0) {
      count++;
    }
  }
  return count;
}

static constexpr size_t kLargestFrame = 32 * 1024 * 1024;

static void TheLargestFrameOfTheDepacketizerStillFits() {
  StartStream();
  // A keyframe of 32 MiB, the bound of the depacketizer, with the room reserved for the SPS fix-up and the HDR metadata
  const int result = Submit(1, true, kLargestFrame - 8);
  CHECK_EQ(result, DR_OK);
  CHECK_EQ(appendedFrames, (size_t)1);
  CHECK_EQ(lastAppendedSize, kLargestFrame);
  CHECK_EQ(s_DecodeBuffer.size(), (size_t)MAX_DECODE_BUFFER_LEN);
  CHECK_EQ(CountLogs("Dropped a video frame"), 0);
}

static void ALargerFrameIsDroppedWithAKeyframeRequestAndLoggedOnce() {
  StartStream();
  int result = Submit(1, true, 100000);
  CHECK_EQ(result, DR_OK);
  // A P-frame one byte over the largest buffer: not appended, and the buffer stays as it was
  result = Submit(2, false, (size_t)MAX_DECODE_BUFFER_LEN + 1);
  CHECK_EQ(result, DR_NEED_IDR);
  CHECK_EQ(appendedFrames, (size_t)1);
  CHECK_EQ(s_DecodeBuffer.size(), (size_t)INITIAL_DECODE_BUFFER_LEN);
  CHECK_EQ(CountLogs("Dropped a video frame of 33554529 bytes, more than the decode buffer takes (33554528 bytes)"), 1);
  // A keyframe that only goes over with the room reserved in a keyframe
  result = Submit(3, true, kLargestFrame + 1 - 8);
  CHECK_EQ(result, DR_NEED_IDR);
  CHECK_EQ(appendedFrames, (size_t)1);
  // One line per stream
  CHECK_EQ(CountLogs("Dropped a video frame"), 1);
  // The keyframe of the request goes through as before
  result = Submit(4, true, 100000);
  CHECK_EQ(result, DR_OK);
  CHECK_EQ(appendedFrames, (size_t)2);
}

// The buffer grows in steps over a stream. Its capacity, not only its size, stays within the cap: resize() alone grows
// the capacity geometrically (to twice the old one in libc++, the size plus the added bytes at least in libstdc++), so
// frames of 3, 17 and then 32 MiB left a capacity above MAX_DECODE_BUFFER_LEN.
static void TheBufferGrowsInStepsNoFurtherThanTheCap() {
  StartStream();
  const size_t steps[] = {3 * 1024 * 1024, 17 * 1024 * 1024, 20 * 1024 * 1024, kLargestFrame - 8};
  int frameNumber = 1;
  for (size_t length : steps) {
    CHECK_EQ(Submit(frameNumber++, true, length), DR_OK);
    CHECK(s_DecodeBuffer.capacity() <= (size_t)MAX_DECODE_BUFFER_LEN);
    CHECK(s_DecodeBuffer.size() >= length);
  }
  CHECK_EQ(s_DecodeBuffer.capacity(), (size_t)MAX_DECODE_BUFFER_LEN);
  CHECK_EQ(CountLogs("Dropped a video frame"), 0);
  // A smaller frame afterwards reuses the buffer
  CHECK_EQ(Submit(frameNumber++, false, 100000), DR_OK);
  CHECK_EQ(s_DecodeBuffer.capacity(), (size_t)MAX_DECODE_BUFFER_LEN);
}

int main() {
  test_support::RunTest("the largest frame of the depacketizer still fits", TheLargestFrameOfTheDepacketizerStillFits);
  test_support::RunTest("the buffer grows in steps no further than the cap", TheBufferGrowsInStepsNoFurtherThanTheCap);
  test_support::RunTest("a larger frame is dropped with a keyframe request and logged once",
                        ALargerFrameIsDroppedWithAKeyframeRequestAndLoggedOnce);
  return test_support::Summary();
}
