**New since 2.3.0:**
- One warning on Tizen 9 or 10 if *Ultra low latency mode* is on from before a TV update or from 2.3.0 or older
- Tizen 10 (2026 models) in the guide: set up like Tizen 9, not yet tested on such a TV
- Pairing is ready for PCs whose host reports version 10 or later
- The diagnostic log names a stream setup step that the TV refused
- The app starts its Smart Hub service only on Tizen 5.5 and 6.0, with Preview tiles

**Which file?** Tizen 9 and newer (also 10): `Moonlight-ForceGM.wgt` (keep *Ultra low latency mode* off). Tizen 5.5 to 8: `Moonlight.wgt`.

**Install 2.3.1** over the old app (settings and pairing normally stay), or next to the regular Moonlight app (pair your PC once).

Tested on simulated TVs, hosts, controllers.
