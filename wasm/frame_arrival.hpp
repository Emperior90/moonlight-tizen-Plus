#pragma once
// The rate at which the frames of the stream arrive on the TV, for the line 'Frames arrive at: 275 Mbps' of the full
// statistics, the report of the session and 'Last session' in System information. moonlight-common-c measures each
// frame from its first packet to its last data packet, per FEC block (arrivalTimeUs and arrivalBytes of DECODE_UNIT in
// Limelight.h, RtpVideoQueue.c): parity packets don't count, since they follow the data of their block and a block
// that arrived complete doesn't wait for them; a block that needed FEC recovery counts up to the parity packet that
// completed it, so a missing packet counts as time without bytes and the frame reads about as much too low as packets
// were missing. The bytes are those at IP level, the packets with their IP and UDP headers. The video decoder thread
// sums the time and the bytes over the frames of a stats window, and the rate is the bytes over the time: a single
// frame is too short to tell (a 4K frame at 150 Mbps takes about 8 ms to arrive, and the clock of the TV may count in
// steps of about 0.1 ms).
// It is the speed at which the TV receives a frame: for 4K60 at 150 Mbps over 5 GHz Wi-Fi, the 8.65 ms per frame that
// the overlay of a TV showed make about 275 Mbps, well below the link rate that the router shows for that TV. On a
// faster path it shows how fast the PC sends the packets of a frame. It is not the bitrate of the stream, which counts
// the time between the frames too. Both ends of a span are the times when the receive thread of the app read the
// packets, not when they reached the TV: if the thread reads them more slowly than they come in (its work per packet,
// or a hold-up in the middle of a frame), the figure shows that slower pace and is too low for the network, and the
// frame receive time rises with it; if it reads a backlog at once (a hold-up just before a frame), it is too high.
// tests/native/frame_arrival_test.c checks the figures of moonlight-common-c, tests/native/stats_overlay_test.cpp this
// rate with the full statistics and the report.

#include <cstdint>

// What a rate needs at least, over a stats window or a session: frames with arrival figures, and time between their
// first and last data packets. Fewer frames, or too little time for the steps of the clock (200 steps of 0.1 ms; e.g.
// a still picture whose frames have one or two packets), give no rate rather than a wild one.
constexpr uint32_t kFrameArrivalMinFrames = 10;
constexpr uint64_t kFrameArrivalMinTimeUs = 20000;

// The rate in megabits per second (bits per microsecond), rounded, from the bytes and the time summed over the frames
// with arrival figures, or 0 when they don't make a rate (kFrameArrivalMinFrames, kFrameArrivalMinTimeUs)
inline uint32_t FrameArrivalMbps(uint64_t totalBytes, uint64_t totalTimeUs, uint32_t frames) {
  if (frames < kFrameArrivalMinFrames || totalTimeUs < kFrameArrivalMinTimeUs || totalBytes == 0) {
    return 0;
  }
  const uint64_t mbps = (totalBytes * 8 + totalTimeUs / 2) / totalTimeUs;
  return mbps > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(mbps);
}
