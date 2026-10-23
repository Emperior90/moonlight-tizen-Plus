# Kurzanleitung: Moonlight auf dem S90C einrichten und testen

Die Details zu jedem Schritt stehen im [Optimierungsplan](S90C-Optimierungsplan.md). Für den Alltag reicht diese Seite.

## 1. Einmal einrichten

**TV**
- `Moonlight-ForceGM.wgt` aus dem neuesten Pre-Release installieren (Tizen 9). Die App heißt auf dem TV **„Moonlight S90C“** und läuft neben der normalen Moonlight-App. Beim ersten Start den PC einmal neu koppeln (PIN in Sunshine eingeben), denn sie hat eigene Einstellungen und eine eigene Kopplung.
- Bildeinstellungen: *Schärfe 0*, *Kontrastverbesserung*, *Picture Clarity* und *Digital Clean View* aus, Eco-Optionen aus.
- Für Sessions über 4 Stunden *Automatisch ausschalten* deaktivieren (Allgemein → Energie und Energiesparen).

**PC**
- Spiel: **Frame Generation aus**, DLSS Super Resolution Balanced oder Performance, Reflex an, auf 60 FPS begrenzen.
- Virtuelles Display: **60,000 Hz** (nicht 59,94), Windows-HDR an und einmal *Windows HDR Calibration* ausführen.
- Sunshine: **Split Frame Encoding: Enabled**, `fec_percentage` **5**, `nvenc_vbv_increase` 0, Preset P4–P6 lassen.

**App**
- Settings → Basic Settings → **„Samsung S90C optimization“** → Continue.
- Settings → Advanced Settings → **Performance statistics** an.
- *Game mode* (Video Settings) aus lassen, die experimentellen Schalter auch.

## 2. Bedienung im Stream

| Taste | Wirkung |
|---|---|
| **Rot** | Stream beenden (während „Starting…“: Start abbrechen) |
| **Gelb** | Statistik ein/aus |
| Gamepad Back + Start + LB + RB | Stream beenden |

Auf der SolarCell-Fernbedienung erreichst du Rot und Gelb meist über die Taste **„123“**, die die Farbtasten auf dem Bildschirm einblendet.

Die **Home-Taste** (oder der Wechsel in eine andere App) beendet den Stream. Das Spiel läuft am PC weiter: Moonlight S90C wieder öffnen und das Spiel auswählen, dann geht es weiter.

## 3. Die drei Zeilen, auf die es ankommt

Sie sollen über die ganze Session bei **0** bleiben:

| Zeile | Steigt sie, liegt es meist am … | Dann |
|---|---|---|
| *Session frames dropped by network* | WLAN | FRITZ!Box-Ereignisse und Kanal prüfen, Bitrate eine Stufe runter |
| *Session frames dropped by the TV* | TV-Decoder | Bitrate eine Stufe runter |
| *Session recovery keyframes* (1 direkt nach dem Start ist normal) | PC, wenn die beiden Zeilen darüber bei 0 bleiben | Sunshine-Log zu dieser Uhrzeit ansehen |

Setzt der Ton aus (*underruns* in der Zeile *Audio session*): Audio Settings → *Audio jitter buffer* um 25 ms erhöhen.

Knackt der Ton nur bei hoher Bitrate und steht *Audio backend* auf **EMSS** (dann zeigt das Overlay keine Audiozeilen): Bitrate eine Stufe senken. Alternativ *Audio backend* auf **Web Audio** stellen. Dessen Puffer fängt Schwankungen ab, der Ton kommt dafür etwas später.

## 4. Bitrate finden (einmal, ca. 1–1,5 Stunden)

Im Bitrate-Menü (Basic Settings → Video bitrate) ändert Hoch/Runter in 5-Mbit/s-Schritten.

1. **100 Mbit/s**, Stream starten, 15–20 Minuten dieselbe anspruchsvolle Szene spielen.
2. Bleiben die drei Zeilen bei 0, die *Rendering frame rate* bei 60 und der Ton ohne Aussetzer: Stream beenden, nächste Stufe **120**, dann **135**, dann **150**. Für jede Stufe den Stream neu starten.
3. An der ersten Stufe, die nicht besteht, aufhören.
4. **Endwert = höchste bestandene Stufe minus 15** (aber nicht unter 100). Beispiel: 135 besteht, 150 nicht → 120.
5. Besteht schon 100 nicht: 90, dann 80 testen.

## 5. Dauertest (einmal, 2,5 Stunden)

Mit dem Endwert 2,5 Stunden spielen. Bestanden, wenn die drei Zeilen bei 0 bleiben (1 Keyframe nach dem Start ist normal) und der Ton nicht aussetzt.

**Wenn es ruckelt, sofort notieren** (Foto vom Overlay genügt): Uhrzeit, die drei Zeilen, *Incoming frame rate*, *Rendering frame rate* und *Host processing latency*. Damit lässt sich sagen, ob PC, WLAN oder TV die Ursache ist.

## Optional, später

- **Ton näher am Bild:** Audio Settings → *Audio clock sync* an, 10 Minuten spielen, den Wert *suggested buffer* aus der Zeile *Audio session* als Jitter-Puffer übernehmen.
- **AV1 statt HEVC:** Video Settings → Video codec → AV1, erst mit derselben Bitrate, dann mit etwa 20 % weniger. Gleich gut ohne Drops → AV1 behalten (Phase 3 im Plan).
