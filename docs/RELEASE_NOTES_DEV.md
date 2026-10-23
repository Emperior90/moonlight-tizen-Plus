**Build für den Samsung S90C (55")**, optimiert für 4K60 HDR mit hoher Bitrate über WLAN, niedrige Latenz und lange Sessions.

### Welche Datei installieren?

- **Tizen 9 (S90C nach dem Update): `Moonlight-ForceGM.wgt`**. Diese Variante schaltet den Spielmodus des TVs ein. In der App *Game mode* dabei aus lassen.
- Tizen 7/8: `Moonlight.wgt`.
- Die App heißt auf dem TV **„Moonlight S90C“** und hat eine eigene Paket-ID, sie wird also **neben** der normalen Moonlight-App installiert, statt sie zu ersetzen. Beim ersten Start den PC einmal neu koppeln, denn Einstellungen und Kopplung sind getrennt von der anderen App.
- Ein früherer S90C-Build (vor dieser Version) steht weiter als „Moonlight“ auf dem TV. Du kannst ihn deinstallieren oder die normale Moonlight-App darüber installieren.

### Neu in diesem Build

**Eigene App „Moonlight S90C“**

- Eigener Name, eigene Paket-ID und ein Icon mit blauem „S90C“-Schriftzug, damit diese Version und die normale Moonlight-App gleichzeitig installiert sein können und im TV-Menü unterscheidbar sind.
- Die Smart-Hub-Vorschau nutzt einen eigenen Port, damit sich die beiden Apps nicht in die Quere kommen.

**Home-Taste beendet den Stream**

- Geht die App in den Hintergrund (Home-Taste, andere App, Eingangswechsel), endet der Stream sofort. Vorher lief er im Hintergrund weiter, belegte Decoder und WLAN, und beim Öffnen einer anderen Streaming-App konnte der TV hängen bleiben. Das Spiel läuft am PC weiter: Moonlight S90C öffnen und das Spiel auswählen.
- Die WLAN-Signalstärke im Overlay zeigt kein „NaN“ mehr, wenn der TV keinen Wert liefert.

**Stabilität und Bedienung**

- Die **rote Taste** während „Starting…“ bricht den Start sauber ab: Die App kehrt zur App-Liste zurück und startet später keinen Stream mehr. Vorher konnte ein Stream trotzdem anlaufen, ohne Ton und ohne funktionierende rote und gelbe Taste.
- Doppeltes Rot, die Gamepad-Kombination und ein Abbruch durch den PC zur selben Zeit lösen nur noch einen Abbau aus. Vorher konnte die Verbindung zweimal gleichzeitig abgebaut werden, bis hin zum Absturz der Engine.
- Smart-Hub-Kacheln starten keinen zweiten Stream über einem laufenden.
- Stürzt die Streaming-Engine ab, erscheint ein Dialog und die App startet neu, statt stumm einzufrieren.
- Lehnt der TV-Player den Modus dauerhaft ab oder fällt seine Medienquelle aus, endet der Stream mit einer Meldung statt mit schwarzem oder eingefrorenem Bild. Einen kurz vollen Player-Puffer versucht die App bis zu eine Bilddauer lang erneut.

**Ton (Web Audio)**

- Nach einem Aussetzer startet der Ton wieder bei etwa Puffer + 10 ms, statt minutenlang beim 1,5-Fachen des Puffers zu bleiben (Simulation: ~113 statt ~153 ms bei 100 ms Puffer).
- Die Hilfetexte zu *Audio clock sync* und zum Jitter-Puffer beschreiben jetzt, was wirklich passiert.

**Statistik-Overlay (gelbe Taste)**

- Neue Zeile *TV player rejections*: erscheint nur, wenn der TV-Player Bilder ablehnt, mit dem Grund.
- Neue Zeile *WASM heap top*: Speicher der Engine gegen die festen 128 MB, um Speicherlecks in langen Sessions zu erkennen.
- *Session recovery keyframes* zählt nur noch echte Wiederherstellungen. Keyframes nach einem Reset am TV, nach der Rückkehr in die App oder als Antwort auf die Anforderung beim Start zählen nicht mehr mit.
- Bilder, die verworfen werden, während die App verdeckt ist (z. B. Home-Taste), zählen nicht mehr als Netzwerkverlust.

**Optimierungsplan**

- Eine einzige Bitrate-Leiter: 100 → 120 → 135 → 150 Mbit/s, je 15–20 Minuten. Endwert = höchste bestandene Stufe minus 15 Mbit/s.
- FEC: bei dir 5 % lassen, nur bei Netzwerk-Drops oder knappem *Worst FEC block* auf 10 % erhöhen.
- Dauertest jetzt 2,5 Stunden, über die ~2-h-Marke hinaus, an der das Ruckeln bisher auftrat.
- Alle Overlay-Zeilen erklärt, neuer Test für Verlassen und Zurückkehren (Home-Taste, TV-Menüs, Eingangswechsel).

### Aus früheren Builds dieses Branches

Button „Samsung S90C optimization“, überarbeitetes Frame Pacing, Session-Zähler im Overlay, schnellere Fehlerkorrektur (FEC), Codec-Level 5.2 für 4K über 60 FPS, BT.709-Farben, optionale HDR-Metadaten und *Audio clock sync*, sichere AV1-Aushandlung mit HEVC als Ersatz, Bildschirmschoner während des Streams aus und weniger Last auf dem Haupt-Thread. Die vollständige Liste steht im CHANGELOG.

### So testest du

Die einseitige **Kurzanleitung** (`docs/S90C-Kurzanleitung.md`, Link unten) fasst Einrichtung, Bitrate-Leiter und Dauertest zusammen. In Kürze:

1. Overlay einschalten (Settings → Advanced Settings → *Performance statistics*, im Stream mit der gelben Taste).
2. Grundlinie und Bitrate-Leiter nach Phase 1 und 2 im Plan, für jede Stufe den Stream neu starten.
3. Optional HEVC gegen AV1 (Phase 3): erst mit gleicher, dann mit etwa 20 % weniger Bitrate.
4. Dauertest 2,5 Stunden (Phase 5) und der Lebenszyklus-Test.

### Bekannte Einschränkungen

- Auf einem echten S90C ist dieser Stand nicht getestet. Geprüft sind Kompilierung, Browser-Tests mit simulierten Tizen-APIs und Simulationen des Ton- und Zählercodes.
- Ob der TV-Player *buffer full* überhaupt meldet und was mit einem Stream passiert, während die App verdeckt ist, zeigt erst der TV. Die App protokolliert beides.
