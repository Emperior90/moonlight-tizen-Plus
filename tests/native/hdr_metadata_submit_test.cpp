// Checks where the HDR10 static metadata goes in the video decoder path (VidDecSubmitDecodeUnit() and ClSetHdrMode() of
// wasm/wasmplayer.cpp, included directly) while 'HDR static metadata' is on: into every keyframe of an AV1 stream as
// metadata OBUs right after its sequence header (wasm/av1_hdr_metadata.hpp), and into every keyframe of an HEVC stream as
// SEI messages before its first slice, as before; nothing goes into other frames, while the switch is off or while the
// host has sent no metadata. A host that sends its metadata during the stream gets asked for a keyframe that carries it,
// for AV1 as for HEVC. The stub of AppendPacket() (TestAppendPacketHook() in stubs/samsung/wasm/common.h) keeps a copy of
// every appended frame; the functions below stand in for moonlight-common-c and the rest of the module, like in
// stats_overlay_test.cpp.

#include "../../wasm/wasmplayer.cpp"

#include "test_support.h"

#include <cstring>
#include <string>
#include <vector>

AudioStreamStats g_AudioStreamStats;
MoonlightInstance* g_Instance = nullptr;

// The test sets two members of the instance that the module writes itself: that the video track is open, and the
// configured bitrate. They are private, and an explicit template instantiation is the one place where C++ lets code name
// a private member, so PrivateMember hands out pointers to them.
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
struct StreamConfigMember {
  using Type = STREAM_CONFIGURATION MoonlightInstance::*;
  friend Type Pointer(StreamConfigMember);
};
template struct PrivateMember<VideoStartedMember, &MoonlightInstance::m_VideoStarted>;
template struct PrivateMember<StreamConfigMember, &MoonlightInstance::m_StreamConfig>;

using Bytes = std::vector<unsigned char>;

static uint64_t nowMs = 0;
static int idrRequests = 0;
static bool hostSentMetadata = true;
static std::vector<Bytes> appended;
static std::vector<std::string> logged;

uint64_t LiGetMillis(void) {
  return nowMs;
}
void LiRequestIdrFrame(void) {
  idrRequests++;
}
// The metadata of a host display with BT.2020 primaries, 1000 nits peak, 0.005 nits black, MaxCLL 1000 and MaxFALL 400
bool LiGetHdrMetadata(PSS_HDR_METADATA metadata) {
  if (!hostSentMetadata) {
    std::memset(metadata, 0, sizeof(*metadata));
    return false;
  }
  *metadata = {};
  metadata->displayPrimaries[0] = {35400, 14600};
  metadata->displayPrimaries[1] = {8500, 39850};
  metadata->displayPrimaries[2] = {6550, 2300};
  metadata->whitePoint = {15635, 16450};
  metadata->maxDisplayLuminance = 1000;
  metadata->minDisplayLuminance = 50;
  metadata->maxContentLightLevel = 1000;
  metadata->maxFrameAverageLightLevel = 400;
  return true;
}
uint32_t LiGetClientVideoResets(void) {
  return 0;
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
  return true;
}
void LiGetVideoNetworkStats(PVIDEO_NETWORK_STATS stats) {
  std::memset(stats, 0, sizeof(*stats));
}
void LiTerminateConnectionAsync(int) {}
void PostToJs(std::string) {}
void PostToJsAsync(std::string) {}
void MoonlightInstance::ClLogMessage(const char* format, ...) {
  logged.push_back(format);
}
void MoonlightInstance::CancelPendingSetup() {}
void MoonlightInstance::OnConnectionStopped(uint32_t) {}

// The metadata of LiGetHdrMetadata() as AV1 metadata OBUs (MDCV and CLL), worked out by hand in
// av1_hdr_metadata_test.cpp
static const Bytes kAv1Metadata = {
  0x2A, 0x1A, 0x02, 0xB5, 0x3F, 0x4A, 0xC1, 0x2B, 0x85, 0xCC, 0x08, 0x21, 0x89, 0x0B, 0xC7, 0x50, 0x0D, 0x54, 0x39,
  0x00, 0x03, 0xE8, 0x00, 0x00, 0x00, 0x00, 0x52, 0x80, 0x2A, 0x06, 0x01, 0x03, 0xE8, 0x01, 0x90, 0x80,
};
// The OBUs of an AV1 keyframe as Sunshine sends it (a temporal delimiter, a sequence header and a frame), and of the
// frames after it (a temporal delimiter and a frame)
static const Bytes kAv1Head = {0x12, 0x00, 0x0A, 0x0B, 0x00, 0x00, 0x00, 0x2D, 0x4C, 0xFF, 0xB3, 0xDF, 0xFF, 0x98, 0x08};
static const Bytes kAv1Frame = {0x32, 0x05, 0x10, 0x00, 0x8A, 0x7F, 0x01};

// The NAL units of an HEVC keyframe, in Annex B format: parameter sets and a slice
static const Bytes kHevcVps = {0x00, 0x00, 0x00, 0x01, 0x40, 0x01, 0x0C, 0x01};
static const Bytes kHevcSps = {0x00, 0x00, 0x00, 0x01, 0x42, 0x01, 0x01, 0x02};
static const Bytes kHevcPps = {0x00, 0x00, 0x00, 0x01, 0x44, 0x01, 0xC1, 0x72};
static const Bytes kHevcSlice = {0x00, 0x00, 0x00, 0x01, 0x26, 0x01, 0xAF, 0x09};

static Bytes Join(std::initializer_list<Bytes> parts) {
  Bytes result;
  for (const Bytes& part : parts) {
    result.insert(result.end(), part.begin(), part.end());
  }
  return result;
}

// The instance and the decoder state of a running 4K60 HDR stream in the given format, as StartStream() and
// VidDecSetup() leave them. The instance is never constructed (the vptr check of UBSan is off for this reason, see
// run.sh).
static void StartStream(int videoFormat, bool metadataSwitch) {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  std::memset(storage, 0, sizeof(storage));
  g_Instance = reinterpret_cast<MoonlightInstance*>(storage);
  g_Instance->*Pointer(VideoStartedMember()) = true;
  (g_Instance->*Pointer(StreamConfigMember())).bitrate = 150000;
  nowMs = 100000;
  idrRequests = 0;
  hostSentMetadata = true;
  appended.clear();
  logged.clear();

  s_VideoFormat = videoFormat;
  s_Width = 3840;
  s_Height = 2160;
  s_Framerate = 60;
  s_frameDuration = TimeStamp(1.0 / 60);
  s_pktPts = 0s;
  s_FramePacingEnabled = false;
  s_HdrMetadataEnabled = metadataSwitch;
  s_Av1HdrMetadataLogged = 0;
  s_DecodeBuffer.resize(INITIAL_DECODE_BUFFER_LEN);
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
  s_SessionTvDroppedFrames = 0;
  s_SessionStartMs = nowMs;
  ResetHostFrameRate();
  s_TerminatingStream = false;
  samsung::wasm::TestAppendPacketHook() = [](const samsung::wasm::ElementaryMediaPacket& packet) {
    const unsigned char* data = static_cast<const unsigned char*>(packet.data);
    appended.emplace_back(data, data + packet.data_size);
    return 0;
  };
}

// Submit one frame made of the given buffers (each with its type) and return the result of the decoder path
static int Submit(int frameNumber, bool idr, const std::vector<std::pair<int, Bytes>>& buffers) {
  std::vector<LENTRY> entries(buffers.size());
  int fullLength = 0;
  for (size_t i = 0; i < buffers.size(); i++) {
    entries[i].bufferType = buffers[i].first;
    entries[i].data = const_cast<char*>(reinterpret_cast<const char*>(buffers[i].second.data()));
    entries[i].length = (int)buffers[i].second.size();
    entries[i].next = i + 1 < buffers.size() ? &entries[i + 1] : nullptr;
    fullLength += entries[i].length;
  }
  DECODE_UNIT unit = {};
  unit.frameNumber = frameNumber;
  unit.frameType = idr ? FRAME_TYPE_IDR : FRAME_TYPE_PFRAME;
  unit.frameHostProcessingLatency = 40;
  unit.presentationTimeMs = (unsigned int)(frameNumber * 1000 / 60);
  nowMs = 100000 + unit.presentationTimeMs;
  unit.receiveTimeMs = nowMs - 3;
  unit.enqueueTimeMs = nowMs - 2;
  unit.fullLength = fullLength;
  unit.bufferList = entries.data();
  return MoonlightInstance::VidDecSubmitDecodeUnit(&unit);
}

// Submit a frame and check that the decoder path took it (CHECK_EQ evaluates its arguments twice, so not in it)
static void SubmitOk(int frameNumber, bool idr, const std::vector<std::pair<int, Bytes>>& buffers) {
  const int result = Submit(frameNumber, idr, buffers);
  CHECK_EQ(result, DR_OK);
}

static bool HasLog(const char* start) {
  for (const std::string& line : logged) {
    if (line.compare(0, std::strlen(start), start) == 0) {
      return true;
    }
  }
  return false;
}

static void Av1KeyframesGetTheMetadataAfterTheSequenceHeader() {
  StartStream(VIDEO_FORMAT_AV1_MAIN10, true);
  SubmitOk(1, true, {{BUFFER_TYPE_PICDATA, Join({kAv1Head, kAv1Frame})}});
  SubmitOk(2, false, {{BUFFER_TYPE_PICDATA, Join({Bytes{0x12, 0x00}, kAv1Frame})}});
  // A keyframe that comes in two buffers (moonlight-common-c doesn't split AV1 frames, but nothing relies on it)
  SubmitOk(3, true, {{BUFFER_TYPE_PICDATA, Bytes(kAv1Head.begin(), kAv1Head.begin() + 6)},
                            {BUFFER_TYPE_PICDATA, Join({Bytes(kAv1Head.begin() + 6, kAv1Head.end()), kAv1Frame})}});
  CHECK_EQ(appended.size(), (size_t)3);
  CHECK(appended[0] == Join({kAv1Head, kAv1Metadata, kAv1Frame}));
  CHECK(appended[1] == Join({Bytes{0x12, 0x00}, kAv1Frame}));
  CHECK(appended[2] == Join({kAv1Head, kAv1Metadata, kAv1Frame}));
  // One line in the log per stream
  CHECK(HasLog("HDR static metadata: inserted into AV1 keyframes"));
  CHECK_EQ(logged.size(), (size_t)1);
}

static void Av1FramesStayAsTheyAreWithoutTheSwitchOrTheMetadata() {
  StartStream(VIDEO_FORMAT_AV1_MAIN10, false);
  SubmitOk(1, true, {{BUFFER_TYPE_PICDATA, Join({kAv1Head, kAv1Frame})}});
  CHECK(appended.back() == Join({kAv1Head, kAv1Frame}));
  StartStream(VIDEO_FORMAT_AV1_MAIN10, true);
  hostSentMetadata = false;
  SubmitOk(1, true, {{BUFFER_TYPE_PICDATA, Join({kAv1Head, kAv1Frame})}});
  CHECK(appended.back() == Join({kAv1Head, kAv1Frame}));
  CHECK(logged.empty());
}

static void AnAv1KeyframeWithoutASequenceHeaderIsLoggedOnce() {
  StartStream(VIDEO_FORMAT_AV1_MAIN10, true);
  const Bytes frame = Join({Bytes{0x12, 0x00}, kAv1Frame});
  SubmitOk(1, true, {{BUFFER_TYPE_PICDATA, frame}});
  SubmitOk(2, true, {{BUFFER_TYPE_PICDATA, frame}});
  CHECK(appended[0] == frame);
  CHECK(appended[1] == frame);
  CHECK(HasLog("HDR static metadata: an AV1 keyframe without a readable sequence header"));
  CHECK_EQ(logged.size(), (size_t)1);
}

static void HevcKeyframesStillGetTheSeiBeforeTheFirstSlice() {
  StartStream(VIDEO_FORMAT_H265_MAIN10, true);
  SubmitOk(1, true, {{BUFFER_TYPE_VPS, kHevcVps}, {BUFFER_TYPE_SPS, kHevcSps}, {BUFFER_TYPE_PPS, kHevcPps},
                            {BUFFER_TYPE_PICDATA, kHevcSlice}});
  CHECK_EQ(appended.size(), (size_t)1);
  const Bytes& frame = appended[0];
  const Bytes parameterSets = Join({kHevcVps, kHevcSps, kHevcPps});
  // The parameter sets, then two prefix SEI NAL units (type 39: 0x4E 0x01) with payload types 137 and 144, then the slice
  CHECK(Bytes(frame.begin(), frame.begin() + parameterSets.size()) == parameterSets);
  CHECK(Bytes(frame.end() - kHevcSlice.size(), frame.end()) == kHevcSlice);
  const Bytes sei(frame.begin() + parameterSets.size(), frame.end() - kHevcSlice.size());
  CHECK(sei.size() > 12);
  CHECK(Bytes(sei.begin(), sei.begin() + 7) == (Bytes{0x00, 0x00, 0x00, 0x01, 0x4E, 0x01, 137}));
  // No AV1 metadata and no log line for HEVC
  CHECK(logged.empty());
}

static void AKeyframeIsRequestedWhenTheMetadataArrivesDuringAStream() {
  for (int format : {VIDEO_FORMAT_AV1_MAIN10, VIDEO_FORMAT_H265_MAIN10}) {
    StartStream(format, true);
    g_Instance->ClSetHdrMode(true);
    CHECK_EQ(idrRequests, 1);
    // Not when HDR goes off, not without the switch, and not for H.264
    g_Instance->ClSetHdrMode(false);
    CHECK_EQ(idrRequests, 1);
  }
  StartStream(VIDEO_FORMAT_AV1_MAIN10, false);
  g_Instance->ClSetHdrMode(true);
  CHECK_EQ(idrRequests, 0);
  StartStream(VIDEO_FORMAT_H264, true);
  g_Instance->ClSetHdrMode(true);
  CHECK_EQ(idrRequests, 0);
}

int main() {
  test_support::RunTest("AV1 keyframes get the metadata after the sequence header", Av1KeyframesGetTheMetadataAfterTheSequenceHeader);
  test_support::RunTest("AV1 frames stay as they are without the switch or the metadata", Av1FramesStayAsTheyAreWithoutTheSwitchOrTheMetadata);
  test_support::RunTest("an AV1 keyframe without a sequence header is logged once", AnAv1KeyframeWithoutASequenceHeaderIsLoggedOnce);
  test_support::RunTest("HEVC keyframes still get the SEI before the first slice", HevcKeyframesStillGetTheSeiBeforeTheFirstSlice);
  test_support::RunTest("a keyframe is requested when the metadata arrives during a stream", AKeyframeIsRequestedWhenTheMetadataArrivesDuringAStream);
  return test_support::Summary();
}
