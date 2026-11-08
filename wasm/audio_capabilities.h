#pragma once
// The capabilities that the audio renderer of the module declares to moonlight-common-c for a stream
// (ConnectionThreadFunc() in main.cpp). They decide which audio stream the host sends (getAttributesList() in
// moonlight-common-c/src/SdpGenerator.c), so they are kept apart from the rest of the connection: C and C++ can
// include this header, and tests/native/sdp_audio_quality_test.c runs the SDP negotiation of moonlight-common-c with
// it.

#include <stdbool.h>

#include <Limelight.h>

// - Every backend submits the packets on the receive thread of moonlight-common-c (CAPABILITY_DIRECT_SUBMIT).
// - The Web Audio backend lets the negotiation choose 10 ms packets for video bitrates below 5 Mbps
//   (CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION and LOW_AUDIO_BITRATE_TRESHOLD of moonlight-common-c). The EMSS
//   backend could take them too, since it also takes the samples per frame from the Opus configuration of the stream
//   (startAudioStream() in AudioStream.c, AudDecInit() in auddec.cpp), but it keeps the 5 ms packets of earlier
//   versions there, and the frame duration doesn't matter when the audio output is disabled.
// - The setting 'Surround audio quality': Efficient declares the decoder slow for more than 2 channels
//   (CAPABILITY_SLOW_OPUS_DECODER), so that the host sends its normal quality instead of the high quality that a video
//   bitrate from 15 Mbps on asks for, in 10 ms instead of 5 ms packets. With Sunshine that is 256 instead of 1536 kbps
//   for 5.1 and 450 instead of 2048 kbps for 7.1, in coupled streams instead of one per channel, which took about 45 %
//   less decoding time for 5.1 on a PC. Never for stereo: the flag also makes the RTSP request name the host 0.0.0.0
//   (RtspConnection.c), which Sunshine reads as a request for its low quality stereo of 96 kbps (src/rtsp.cpp). It
//   doesn't depend on the backend, so that a test with the audio output disabled negotiates the same stream.
static inline int GetAudioRendererCapabilities(bool webAudio, bool efficientSurround, int audioConfiguration) {
  int capabilities = CAPABILITY_DIRECT_SUBMIT;
  if (webAudio) {
    capabilities |= CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION;
  }
  if (efficientSurround && CHANNEL_COUNT_FROM_AUDIO_CONFIGURATION(audioConfiguration) > 2) {
    capabilities |= CAPABILITY_SLOW_OPUS_DECODER;
  }
  return capabilities;
}
