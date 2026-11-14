#pragma once
// The channel mapping that the Opus decoder of a stream is created with (AudDecInit() in auddec.cpp), kept apart from
// the decoder so that C and C++ can include this header: tests/native/opus_channel_layout_test.c runs it behind the
// real parseOpusConfigurations() of moonlight-common-c, with the layouts that Sunshine announces.
//
// moonlight-common-c hands the app the layout of the DESCRIBE answer of the host: the channels, the streams, how many
// of the streams are coupled (stereo), and a mapping with one entry per output channel in the order FL FR FC LFE BL BR
// SL SR (Limelight.h). Opus numbers the channels of all streams in a row, first the left and the right channel of each
// coupled stream, then the mono streams, and entry i of the mapping is the number of the stream channel that output
// channel i plays (get_left_channel(), get_right_channel() and get_mono_channel() in opus/src/opus_multistream.c, which
// the encoder reads the same way for its input channels). Sunshine encodes each of its layouts with the mapping
// 0 1 2 ... (stream_configs in its src/audio.cpp) from channels in the order above, so its channel i is stream channel
// i, and a decoder plays every channel in its place with that same mapping.
//
// For the normal quality of 5.1 and 7.1 the DESCRIBE answer doesn't carry that mapping as it is: moonlight-common-c
// moves the last entry to position 3 there, for the channel order of GeForce Experience (parseOpusConfigurations() in
// RtspConnection.c), and Sunshine rotates its mapping the other way before it sends it, so that both cancel out. Up to
// its commit 8952d44 of 3 November 2026 (its release v2026.914 is from before) Sunshine rotated the entries 3 to 5
// whatever the layout, instead of the entries from 3 to the last one (std::rotate(mapping + 3, mapping + 4,
// mapping + audio::MAX_STREAM_CONFIG) in its src/rtsp.cpp, where MAX_STREAM_CONFIG is the number of its layouts, 6).
// Apollo and Vibeshine still did on 13 November 2026. For 5.1 that is the same. For 7.1 such a host announces
// surround-params=85301245367 instead of 85301245673, which moonlight-common-c turns into the mapping 0 1 2 7 4 5 3 6
// instead of 0 1 2 3 4 5 6 7: the LFE output plays the side right channel of the host, the side left output its LFE and
// the side right output its side left. These hosts encode like a fixed one, so the stream is decoded with
// 0 1 2 3 4 5 6 7.
//
// Only exactly this layout is corrected. No host means it: it would need an encoder that codes side right together
// with the center in one stereo stream. Every other layout of Sunshine (stereo, 5.1 in both qualities, 7.1 in high
// quality, 7.1 in normal quality of a fixed host) comes out of moonlight-common-c as 0 1 2 ..., and GeForce Experience
// pairs other channels (its 5.1 is 0 4 1 5 2 3, the fallback of RtspConnection.c): they are passed on as they are.

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include <Limelight.h>

// Whether the layout is the 7.1 of the normal quality of a host with the faulty rotation described above, as
// moonlight-common-c hands it to the audio renderer
static inline bool IsMisrotatedSurround71Layout(const OPUS_MULTISTREAM_CONFIGURATION* config) {
  static const unsigned char kMisrotatedMapping[8] = { 0, 1, 2, 7, 4, 5, 3, 6 };
  return config->channelCount == 8 && config->streams == 5 && config->coupledStreams == 3 &&
         memcmp(config->mapping, kMisrotatedMapping, sizeof(kMisrotatedMapping)) == 0;
}

// Fills in the mapping to create the Opus decoder of the stream with: the one of the layout, or 0 1 2 3 4 5 6 7 for
// the layout of a host with the faulty rotation. Returns whether the mapping was corrected.
static inline bool GetOpusDecoderMapping(const OPUS_MULTISTREAM_CONFIGURATION* config,
                                         unsigned char mapping[AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT]) {
  memcpy(mapping, config->mapping, AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT);
  if (!IsMisrotatedSurround71Layout(config)) {
    return false;
  }
  for (int i = 0; i < AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT; i++) {
    mapping[i] = (unsigned char)i;
  }
  return true;
}

// Writes the first 'count' entries of a mapping as text for the log, e.g. "0 1 2 7 4 5 3 6"
static inline void FormatOpusMapping(const unsigned char* mapping, int count, char* text, size_t size) {
  size_t length = 0;
  if (size > 0) {
    text[0] = 0;
  }
  for (int i = 0; i < count && i < AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT && length + 1 < size; i++) {
    const int written = snprintf(text + length, size - length, i == 0 ? "%d" : " %d", mapping[i]);
    if (written < 0) {
      break;
    }
    length += (size_t)written;
  }
}
