// Decodes with the Opus library that tests/native/run.sh builds from the source files CMakeLists.txt lists, which are
// only those of the decoder. The program uses the functions the app calls (wasm/auddec.cpp:
// opus_multistream_decoder_create() and opus_multistream_decode()), so it only links when no file the decoder needs is
// missing from the list. It decodes stereo, 5.1 and 7.1 as the host sends them (the channel mappings of Sunshine),
// with CELT, SILK and hybrid packets and with packet loss concealment, and exits with 1 when a call fails.

#include <opus_multistream.h>
#include <stdio.h>
#include <string.h>

#define FRAME_DATA_LEN 40

struct Layout {
  const char* name;
  int channels;
  int streams;
  int coupled;
  unsigned char mapping[8];
};

static const struct Layout kLayouts[] = {
  { "stereo", 2, 1, 1, { 0, 1 } },
  { "5.1", 6, 4, 2, { 0, 4, 1, 5, 2, 3 } },
  { "7.1", 8, 5, 3, { 0, 6, 1, 7, 2, 3, 4, 5 } },
};

// A multistream packet with one frame of the given configuration (TOC config, see RFC 6716 section 3.1) per stream:
// every stream but the last is self-delimited (its length follows its TOC byte). The frame data is arbitrary, which
// the range decoder of Opus accepts like any other bit stream.
static int BuildPacket(const struct Layout* layout, int config, unsigned char* packet) {
  int length = 0;
  for (int stream = 0; stream < layout->streams; stream++) {
    int stereo = stream < layout->coupled;
    packet[length++] = (unsigned char)((config << 3) | (stereo << 2));
    if (stream < layout->streams - 1) {
      packet[length++] = FRAME_DATA_LEN;
    }
    for (int i = 0; i < FRAME_DATA_LEN; i++) {
      packet[length++] = (unsigned char)((stream * 37 + i * 101 + config) & 0xFF);
    }
  }
  return length;
}

int main(void) {
  static opus_int16 pcm[960 * 8];
  unsigned char packet[8 * (FRAME_DATA_LEN + 2)];
  // CELT fullband 5 ms (Moonlight's frames), SILK wideband 20 ms, hybrid fullband 20 ms
  const int configs[3] = { 29, 9, 15 };
  const int frameSizes[3] = { 240, 960, 960 };
  int failed = 0;

  for (size_t l = 0; l < sizeof(kLayouts) / sizeof(kLayouts[0]); l++) {
    const struct Layout* layout = &kLayouts[l];
    int error = 0;
    OpusMSDecoder* decoder = opus_multistream_decoder_create(48000, layout->channels, layout->streams, layout->coupled,
                                                             layout->mapping, &error);
    if (decoder == NULL || error != OPUS_OK) {
      printf("not ok - %s: opus_multistream_decoder_create() failed (%d)\n", layout->name, error);
      failed = 1;
      continue;
    }
    for (int c = 0; c < 3; c++) {
      int length = BuildPacket(layout, configs[c], packet);
      int decoded = opus_multistream_decode(decoder, packet, length, pcm, frameSizes[c], 0);
      printf("%s - %s, TOC config %d: %d samples\n", decoded == frameSizes[c] ? "ok" : "not ok", layout->name, configs[c],
             decoded);
      failed |= decoded != frameSizes[c];
    }
    // A lost packet, which the app conceals with one frame (wasm/auddec.cpp)
    int concealed = opus_multistream_decode(decoder, NULL, 0, pcm, 240, 0);
    printf("%s - %s, lost packet: %d samples\n", concealed == 240 ? "ok" : "not ok", layout->name, concealed);
    failed |= concealed != 240;
    opus_multistream_decoder_destroy(decoder);
  }
  return failed;
}
