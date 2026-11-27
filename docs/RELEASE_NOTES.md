**New since 2.3.5:**
- The sound is decoded in floating point, as a test: *Audio CPU* in the full statistics tells whether it is lighter on your TV
- The picture and the sound read the clock fewer times, which saves the TV a little work per frame
- A controller that rumbles often no longer fills the diagnostic log
- The diagnostic log hints whether the browser of the TV is a 32- or a 64-bit one, and tells what its video element counted per stream

**Which file?** `Moonlight-ForceGM.wgt` on Tizen 9 and newer, `Moonlight.wgt` on Tizen 5.5 to 8.

**Install 2.3.6** over the old app (settings and pairing normally stay), or next to the regular Moonlight app (pair your PC once).

Tested on simulated TVs and hosts; the sound, the picture and the rumble need a TV.
