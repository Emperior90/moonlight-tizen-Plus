**New since 2.3.1:**
- *Full* statistics and *Last session* show how fast frames arrive (not the bitrate) and the longest time of a frame per step
- Frame times are finer than whole milliseconds (about 0.1 ms where the TV allows)
- The log names what the TV supports of WebAssembly and if its sockets take the network priority
- *Session recovery keyframes* no longer counts restarts of the PC's encoder
- A start the PC doesn't answer no longer hangs on *Starting…*

**Which file?** `Moonlight-ForceGM.wgt` on Tizen 9 and newer, `Moonlight.wgt` on Tizen 5.5 to 8.

**Install 2.3.2** over the old app (settings and pairing normally stay), or next to the regular Moonlight app (pair your PC once).

Tested on simulated TVs and hosts; the new figures and fixes still need a TV.
