Moonlight S90C ist eine angepasste Version von [Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen) 1.19.0 von brightcraft. Sie ist auf den Samsung S90C abgestimmt, die Verbesserungen an Bild, Ton, Verbindung, Stabilität und Bedienung kommen aber allen Samsung-Fernsehern mit Tizen zugute. Speziell auf den S90C zugeschnitten sind:

- der App-Name mit Icon
- der Button *Samsung S90C optimization*
- die neuen Standardwerte samt einigen Grenzwerten aus den Daten des S90C: 100 Mbit/s im WLAN nach seiner Decoder-Spezifikation und eine Warnung erst bei 4K über 120 FPS
- die deutschsprachige Dokumentation

Die App heißt auf dem TV „Moonlight S90C“ und hat eine eigene Paket-ID (MLightS90C). Sie wird deshalb neben der normalen Moonlight-App installiert, mit eigenen Einstellungen und eigener Kopplung. Beim ersten Start den PC einmal koppeln (PIN in Sunshine eingeben).

### Welche Datei installieren?

- **Tizen 9 und neuer: `Moonlight-ForceGM.wgt`.** Diese Variante fordert vom TV dessen Spielmodus (Game Mode) an. Den Schalter *Game mode* in der App (Settings → Video Settings) dabei aus lassen. Er wählt nur den Latenzmodus des Decoders und kann unter Tizen 9 und neuer das Bild einfrieren lassen.
- **Ältere Tizen-Versionen: `Moonlight.wgt`.**
- Welche Tizen-Version der TV hat, zeigt Moonlight unter Settings → About → *System information* (*Platform Version*).
- Die Dateien heißen wie bei Moonlight Tizen. Auf dem TV erscheint die App trotzdem als „Moonlight S90C“.

### Alle Änderungen seit Moonlight Tizen 1.19.0

Kennzeichnung:

- **S90C** heißt: auf den S90C zugeschnitten.
- **Experimentell** heißt: neue Einstellung, die standardmäßig aus ist und die man selbst einschalten muss.

Alle anderen Änderungen an der App gelten automatisch für alle Samsung-TVs mit Tizen, außer beim Punkt steht eine Bedingung. Beispiele sind „nur mit dem Audio-Backend Web Audio“, „nur über 4K mit 60 FPS“ oder „nur bei LAN“. Die Punkte unter Dokumentation und Build ändern nichts an der App auf dem TV. Ein Schlüsselbild (Keyframe) ist ein vollständiges Bild, auf dem die folgenden Bilder aufbauen.

#### Eigene App und Installation

- **S90C:** Die App heißt jetzt „Moonlight S90C“ und hat ein blaues „S90C“-Abzeichen im Icon. Eigenständig sind die Paket-ID (MLightS90C), die Widget-ID, die Service-ID und die App-Beschreibung („Moonlight Game Streaming (Samsung S90C build)“). Deshalb lässt sie sich neben der normalen Moonlight-App installieren und hat eigene Einstellungen und eine eigene Kopplung mit dem PC. Die Versionsnummer bleibt 1.19.0.
- Die Smart-Hub-Vorschau dieser App und die der normalen Moonlight-App kommen sich nicht mehr in die Quere:
  - Moonlight S90C nutzt dafür einen eigenen Port (8889 statt 8888) und eigene Vorschaubilder.
  - Das Leeren des Box-Art-Caches lässt die Bilder der normalen Moonlight-App in Ruhe.
  - Kacheln, die frühere Vorabversionen dieser App gespeichert haben, werden auf den neuen Port umgestellt.

#### Bild und Video

- *Video frame pacing* (standardmäßig an) richtet sich jetzt nach der üblichen Ankunftszeit der Bilder. Bisher zählte nur das eine Bild, das gerade ein Messfenster (1 Sekunde) abschließt und zufällig verspätet sein kann.
  - Ein einzelnes spätes Bild hält die folgenden Bilder deshalb nicht mehr um bis zu mehrere zehn Millisekunden zurück.
  - Eine spätere Ankunftszeit übernimmt das Pacing erst, wenn zwei Messfenster hintereinander sie bestätigen. So verzögert der Bilderschwall nach einem kurzen Netzwerkhänger nicht die nächste Sekunde.
  - Am Ende jeder Wartezeit wartet das Pacing nur noch 0,2 statt 1 ms aktiv. Das spart Rechenzeit.
- Der PC kodiert jedes Bild jetzt als ein Stück (1 Slice statt 4). Das komprimiert bei gleicher Bitrate besser, und der Decoder des TVs bekommt ohnehin ganze Bilder.
- SDR-Streams werden jetzt im Farbraum Rec. 709 angefordert, dem Standard für HD- und 4K-Video. Bisher war es Rec. 601 (für SD-Video). HDR-Streams nutzen wie bisher Rec. 2020.
- Bei der Codec-Wahl richtet sich die App jetzt nach den Codecs, die der PC tatsächlich kodieren kann. Sunshine prüft seine Encoder beim Start eines Spiels erneut, z. B. wenn vorher noch kein Bildschirm angeschlossen war. Deshalb liest die App die Liste danach noch einmal.
  - Kann der PC HEVC nicht in 10 Bit kodieren, läuft der Stream in HEVC mit 8 Bit ohne HDR, statt am Encoder zu scheitern.
  - Ist AV1 gewählt und kann der PC kein AV1, gibt es HEVC statt eines 4K-Streams in H.264 ohne HDR.
  - Ist HDR eingeschaltet und kann der PC AV1 nur in 8 Bit, HEVC aber in 10 Bit, gibt es HEVC Main10 mit HDR statt eines AV1-Streams ohne HDR.
  - Muss der PC auf einen anderen Codec oder auf SDR statt HDR ausweichen, zeigt die App einen Hinweis.
  - Meldet der PC weder HEVC noch AV1, etwa weil seine Encoder-Prüfung fehlgeschlagen ist, verlässt sich die App nicht auf diese Liste.
  - Die AV1-Warnung nennt jetzt, was AV1 braucht: einen AV1-Encoder im PC und einen AV1-Decoder im TV. Kann der PC kein AV1 kodieren, weicht der Stream auf HEVC aus.
- Bei Streams mit mehr Bildpunkten pro Sekunde als 4K mit 60 FPS meldet die App dem TV jetzt HEVC- bzw. AV1-Level 5.2, damit er seinen Decoder passend einrichtet. Beispiele sind 4K mit 90, 120 oder 144 FPS und 1800p mit 120 FPS. Lehnt der TV das ab, bleibt es wie bisher bei Level 5.1.
- Neue Auflösung *3200 x 1800 (1800p)* als Zwischenstufe zwischen 1440p und 4K, mit passenden Bitrate-Voreinstellungen. Sie ist nur auf 4K- und 8K-TVs wählbar.
- **Experimentell:** neue Einstellung *HDR static metadata* (Video Settings).
  - Sie gibt die HDR10-Metadaten des PC-Bildschirms mit jedem HEVC-Schlüsselbild an den TV weiter. Das sind Farbraum und Helligkeit des Mastering-Displays und, falls der PC sie liefert, die höchste Bild- und Durchschnittshelligkeit (MaxCLL/MaxFALL).
  - So kann der TV sein HDR-Tone-Mapping daran ausrichten, also die Anpassung des HDR-Bilds an sein Panel.
  - Sunshine schreibt diese Daten (jedenfalls mit NVIDIA-Encoder) nicht in den Videostrom, sondern schickt sie nur über den Steuerkanal. Die App hat sie bisher verworfen.
  - Treffen die Metadaten ein oder ändern sie sich, fordert die App ein neues Schlüsselbild an, damit sie sofort wirken.
  - Die Einstellung wirkt nur bei HDR-Streams mit HEVC. Startet ein HDR-Stream damit nicht oder sieht er falsch aus, die Einstellung wieder ausschalten.
- Der Bildschirmschoner des TVs wird während des Streams ausgeschaltet und danach wieder eingeschaltet.

#### Ton

Diese Punkte gelten nur für das Audio-Backend *Web Audio* (Settings → Audio Settings → *Audio backend*). Voreingestellt ist weiterhin EMSS. Web Audio ist die Alternative, z. B. wenn der Ton mit EMSS knackt.

- **Experimentell:** neue Einstellung *Audio clock sync*.
  - Die Uhren von PC und TV laufen nie ganz gleich schnell. Ohne Ausgleich wächst die Tonverzögerung deshalb bis zum 1,5-Fachen des Jitter-Puffers. Danach werden alle paar Minuten 5 ms Ton übersprungen, oder es entsteht eine Lücke so lang wie der Puffer, wenn er leerläuft.
  - Mit *Audio clock sync* spielt die App den Ton unhörbar um bis zu 0,05 % schneller oder langsamer. So hält sie die Verzögerung beim Jitter-Puffer.
  - Die Hilfetexte zu *Audio clock sync* und *Audio jitter buffer* beschreiben das genau. Sie verweisen auch auf die Puffergröße, die die Leistungsstatistik mit *Audio clock sync* nach 10 Minuten vorschlägt.
- Muss die App die Abtastrate umrechnen, nutzt sie jetzt eine kubische statt einer linearen Interpolation. Die erhält die Höhen besser. Umgerechnet wird, wenn die Tonausgabe des TVs nicht mit 48 kHz läuft oder *Audio clock sync* aktiv ist.
- Laufen die Uhren von PC und TV auseinander, wächst die Tonverzögerung nur noch bis zum 1,5-Fachen des Jitter-Puffers statt bis zum Doppelten. *Audio jitter buffer* lässt sich jetzt bis auf 25 ms senken (vorher 50 ms).
- Nach einem Aussetzer kürzt die App den aufgelaufenen Ton auf Jitter-Puffer plus zwei Pakete. Vorher blieb die Tonverzögerung nach einem Aussetzer minutenlang erhöht, bis zur Obergrenze (in Moonlight Tizen 1.19.0 das Doppelte des Jitter-Puffers). Diese gekürzten Pakete zählt die Statistik getrennt von den übersprungenen.
- Behoben: Jedes verlorene Tonpaket erhöhte die Tonverzögerung um 5 ms. Jetzt wird die Lücke mit genau einer Paketlänge überbrückt statt mit 10 ms.
- Schweigt der PC und Sunshine schickt deshalb keinen Ton, zählen Statistik und Log das nicht mehr als Aussetzer. Am Ton selbst ändert sich dadurch nichts.

#### Verbindung und Stabilität

- Behoben: Die Fehlerkorrektur (FEC) rekonstruiert verlorene Pakete aus Zusatzdaten. Bei jeder Reparatur hielt sie den Empfang der Videodaten auf. Bei großen Blöcken dauerte das schon auf einem PC-Prozessor rund 15 ms, auf dem TV noch länger. Jetzt entfällt eine überflüssige Rechnung. Das Ergebnis ist dasselbe, die Reparatur geht aber schneller.
- **Experimentell:** neue Einstellung *Reference frame invalidation* (Video Settings, nur HEVC und AV1). Nach einem Paketverlust kann sich das Bild damit erholen, ohne dass der PC ein komplettes Schlüsselbild schicken muss. Das vermeidet Datenspitzen und unscharfe Bilder. Bleiben nach einem Bildverlust Fehler im Bild, die Einstellung wieder ausschalten.
- Behoben: Nahm die App fälschlich einen Bildverlust an, konnte das Bild bis zu 2 Sekunden stehen bleiben (120 Bilder bei 60 FPS).
  - Das betraf die Standardeinstellung ohne *Reference frame invalidation*.
  - Diese Vorhersage läuft jetzt nur noch mit *Reference frame invalidation*, wie in der offiziellen Streaming-Bibliothek moonlight-common-c.
  - Ist *Reference frame invalidation* an und kommt ein Schlüsselbild nur teilweise an, fordert die App jetzt wie dort ein neues Schlüsselbild an. Bisher versuchte sie die Reparatur per Reference Frame Invalidation.
- Die App erkennt, ob der TV per LAN oder WLAN verbunden ist. Der LAN-Anschluss von Samsung-Fernsehern schafft in der Regel nur 100 Mbit/s. Deshalb begrenzen die Bitrate-Voreinstellungen die Bitrate bei LAN auf 75 Mbit/s, und über 80 Mbit/s erscheint bei LAN eine Warnung.
- Die Warnung „Slow connection to PC. Reduce your bitrate!“ erscheint nur noch bei echten Netzwerkverlusten. Verwirft der TV selbst Bilder (volle Warteschlange, nach einem Decoder-Reset), bleibt sie aus.
- Behoben: Ging Moonlight in den Hintergrund (Home-Taste, andere App), lief der Stream unbegrenzt weiter. Das belastete das Netzwerk und konnte den TV hängen lassen, wenn eine andere App ihr Video startete.
  - Jetzt endet der Stream nach einer Minute im Hintergrund.
  - Er endet sofort, wenn der TV der App das Video wegnimmt oder die Verbindung noch aufgebaut wird.
  - Ein kurz geöffnetes TV-Menü wie das Schnellmenü beendet ihn deshalb nicht sofort. Verdeckt es die App länger als eine Minute, endet der Stream aber auch dann.
  - Ein Hinweis erklärt, wie man weiterspielt: Das Spiel läuft am PC weiter und lässt sich durch erneutes Auswählen fortsetzen.
  - Ein Start, der noch unterwegs war, startet keinen Stream mehr, wenn die App inzwischen im Hintergrund ist. Ein Beispiel ist der verzögerte Start nach dem Beenden eines anderen Spiels am PC.
- Ist der Puffer des TV-Videoplayers kurz voll, versucht die App das Bild bis zu einer Bilddauer lang erneut. Lehnt der Player das Videoformat 3 Sekunden lang ab, endet der Stream mit einer Meldung. Vorher forderte die App bei schwarzem Bild endlos neue Schlüsselbilder an.
- Fällt die Medienwiedergabe des TVs während des Streams oder schon beim Verbindungsaufbau aus, endet der Stream jetzt mit einer Meldung. Vorher blieb ein eingefrorenes oder schwarzes Bild stehen.
- Stürzt die Streaming-Engine ab (das WebAssembly-Modul oder einer seiner Threads), erscheint eine Meldung. Nach dem Schließen startet Moonlight neu, statt ohne Hinweis einzufrieren.
- Behoben: Mehrere Stopps zur selben Zeit bauten die Verbindung doppelt ab, im schlimmsten Fall bis zum Absturz der Streaming-Engine. Auslöser waren z. B. ein doppelter Druck auf die rote Taste, die Gamepad-Kombination und ein Abbruch durch den PC zur selben Zeit. Jetzt baut die App die Verbindung nur einmal ab und kehrt nur einmal zur App-Liste zurück.
- Für die Fehlersuche schreibt die App mehr ins Log. Am Bild ändert sich dadurch nichts. Neu im Log stehen:
  - die Größe des UDP-Empfangspuffers, die der TV beim Streamstart tatsächlich gewährt
  - ob der TV ein Empfangs-Timeout unterstützt (sonst prüft die App vor jedem Empfang, ob Daten angekommen sind)
  - warum der TV eine Ton- oder Videospur geschlossen hat
  - wann die Videospur während des Streams neu geöffnet wurde und wie viele Bilder in der Zwischenzeit verworfen wurden
  - wann die App verdeckt und wieder angezeigt wird
  - die Ablehnungsgründe des TV-Videoplayers mit Namen
  - der Speicherstand der Streaming-Engine am Ende jedes Streams

#### Bedienung

- **S90C:** neuer Button *Samsung S90C optimization* (Settings → Basic Settings → *Apply the optimal streaming settings for this TV*).
  - Vor dem Übernehmen zeigt er die für den S90C empfohlenen Werte an.
  - Bild: die höchste Auflösung des TVs bis 4K, mit 60 FPS und HEVC. Auf HDR-fähigen TVs HEVC Main10 mit HDR.
  - Bitrate passend zur Verbindung: 75 Mbit/s bei LAN, 100 Mbit/s bei WLAN, 80 Mbit/s wenn unbekannt.
  - Weitere Werte: *Video frame pacing* an, eingeschränkter Farbbereich, *Unlock all frame rates* an und *Optimize bitrate presets* aus. Auf Tizen 6 bis 8 außerdem *Game mode* an.
  - Der Dialog gibt Tipps zur LAN- oder WLAN-Verbindung.
  - Unter Tizen 9 und neuer verweist er auf die ForceGM-Variante. Ist sie schon installiert, sagt er das, statt zur Installation aufzufordern.
  - Die Werte werden erst nach Bestätigung übernommen.
  - Der Button funktioniert auf jedem Samsung-TV. Auf anderen Modellen als dem S90C weist der Dialog darauf hin, dass die Werte dort nicht optimal sein müssen.
- Die Bitrate bleibt jetzt erhalten, wenn man Auflösung, Bildrate, Codec oder HDR ändert.
  - Das gilt für eine von Hand gewählte und für die empfohlene Bitrate.
  - Vorher sprang sie bei jeder Änderung von Auflösung oder Bildrate auf die Voreinstellung, auch beim erneuten Auswählen des aktuellen Werts. Bei Codec und HDR geschah das nur mit eingeschaltetem *Optimize bitrate presets*.
  - Nach dem Umschalten von *Optimize bitrate presets* gelten wieder die Voreinstellungen, bis man die Bitrate selbst ändert. So macht es auch moonlight-qt.
  - Beim ersten Mal erklärt ein Hinweis, wie man die Voreinstellungen zurückbekommt.
  - Begrenzt die App eine Voreinstellung bei LAN auf 75 Mbit/s, sagt sie das einmal an.
- Im Bitrate-Menü ändern HOCH und RUNTER die Bitrate jetzt in 5-Mbit/s-Schritten, LINKS und RECHTS weiterhin in 0,5-Mbit/s-Schritten. Die Navigationshilfe ist entsprechend ergänzt.
- Neue Warnhinweise:
  - bei H.264 über 1080p, weil Samsung-TVs H.264 in der Regel nur bis 1080p dekodieren. Die Warnung erscheint auch beim Start der App, wenn H.264 mit einer Auflösung über 1080p gespeichert ist.
  - **S90C:** bei 4K mit mehr als 120 FPS (also 144 FPS), weil das über der Decoder-Spezifikation des S90C liegt. Andere TVs können schon bei niedrigeren Bildraten an ihre Grenze kommen. Die App warnt dort aber auch erst bei 144 FPS.
  - bei 90 FPS, weil 90 FPS nicht gleichmäßig in die 60- oder 120-Hz-Ausgabe des TVs passen und Bewegungen weniger flüssig wirken können
- Behoben: Die Warnung zu Auflösung und Bildrate verglich die Werte als Text statt als Zahlen und erschien deshalb in den falschen Fällen.
- Behoben: *Restore Defaults* schaltete *Video frame pacing* und *Host address field mode* aus, obwohl beide standardmäßig an sind.
- Behoben: Drückte man während „Starting…“ die rote Taste, konnte der Stream trotzdem anlaufen. Er lief dann ohne Ton, und die rote und die gelbe Taste waren ohne Funktion. Jetzt bricht der Start sauber ab. Eine gedrückt gehaltene rote Taste löst nur einen einzigen Stopp bzw. Abbruch aus.
- Behoben: Eine Smart-Hub-Kachel konnte einen zweiten Stream über einem laufenden starten. Jetzt erscheint der Hinweis „Stop the current stream first (RED button).“
- Behoben: Bei gefangenem Mauszeiger drückte die Zurück-Taste die linke Maustaste am PC, ohne sie wieder loszulassen. Beim Fangen des Mauszeigers fordert die App außerdem kein Schlüsselbild mehr an.
- Gamepad-Tasten, die beim Streamende noch gedrückt sind (z. B. die Stopp-Kombination), lösen im Menü keine Aktion mehr aus. Ein gehaltenes Steuerkreuz scrollt beim Streamstart nicht weiter.
- Nach dem Ende eines Streams zeigt die App „Loading Apps...“, bis die App-Liste geladen ist.
- Überarbeitete Hilfetexte:
  - *Optimize game settings* erklärt, was die Option bei Sunshine bewirkt. Bei aktivierter Display-Konfiguration stellt Sunshine den PC-Bildschirm auf die Auflösung des Streams um. Mit Sunshines Standardeinstellung folgt die Bildwiederholrate ohnehin der gewählten Bildrate. Es gehen nur Modi, die der PC-Bildschirm anbietet.
  - *Game mode* rät, den Schalter unter Tizen 9 und neuer mit beiden Varianten aus zu lassen.
  - *Optimize bitrate presets* sagt, dass die Option eine niedrige Bitrate berechnet (etwa 45 Mbit/s für 4K mit 60 FPS in HEVC mit HDR). Für die beste Bildqualität sollte man sie aus lassen und die Bitrate von Hand setzen.
  - *Video HDR* sagt, dass HDR auch am PC-Bildschirm eingeschaltet sein muss, sonst kommt 10-Bit-SDR an.

#### Weniger Last für den TV

- Die Streaming-Engine wird auf Geschwindigkeit statt auf kleine Dateigröße optimiert gebaut (Compiler-Option -O2 statt -Os).
- Während des Streams fragt die Oberfläche die Gamepads nicht mehr alle 5 ms selbst ab, denn das übernimmt der Stream ohnehin. Das entlastet den Haupt-Thread.
- Alle Gamepads werden pro Abfrage mit einem einzigen Aufruf gelesen statt mit einem Aufruf pro Gamepad-Platz. Das lässt dem Haupt-Thread mehr Luft, unter anderem für die Tonausgabe mit Web Audio.
- Der Controller-Zustand geht nur noch bei einer Änderung an den PC, zur Sicherheit zusätzlich alle 100 ms. Vorher geschah das 200-mal pro Sekunde. Das verringert den Datenverkehr vom TV zum PC, vor allem im WLAN.
- Bei eingeschalteter Leistungsstatistik muss der Videodecoder nicht mehr warten, bis die Oberfläche die Statistik verarbeitet hat.
- Verbindungswarnungen halten den Empfang der Videodaten nicht mehr auf. Auch die Controller-Vibration wird jetzt ohne Warten an die Oberfläche übergeben.

#### Statistik-Overlay

Die Leistungsstatistik erscheint im Stream, wenn *Performance statistics* eingeschaltet ist (Settings → Advanced Settings, standardmäßig aus). Im Stream blendet die gelbe Taste sie ein und aus.

- *Configured bitrate* zeigt die eingestellte Bitrate.
- *Host frame rate (30 s)* zeigt die über 30 Sekunden gemessene Bildrate des PCs. So erkennt man, wenn der PC-Bildschirm mit 59,94 statt 60 Hz läuft.
- Drei Zeilen zeigen getrennt, wie es den Bildern im TV ergeht:
  - *Average frame receive time*: wie lange ein Bild für den Empfang braucht
  - *Average frame wait time*: wie lange es auf die Verarbeitung wartet
  - *Pending frames*: wie viele Bilder anstehen, mit der Höchstzahl pro Sekunde
- Die irreführende Zeile *Average decoding time* entfällt. Die Pacing-Zeile heißt jetzt *Average frame pacing delay*.
- Neue Summen über die ganze Sitzung:
  - *Session frames dropped by network* zählt Bilder, die im Netzwerk verloren gingen.
  - *Session frames dropped by the TV* zählt getrennt davon die Bilder, die der TV selbst verworfen hat (volle Warteschlange oder vom Player abgelehnt). Die Zeile nennt auch die Zahl der Resets der Videowiedergabe.
  - *Session recovery keyframes* zählt nur echte Reparatur-Schlüsselbilder. Nicht mitgezählt werden Schlüsselbilder, die die App selbst beim Öffnen der Videospur oder bei neuen HDR-Metadaten anfordert. Auch die Schlüsselbilder nach einem Reset der Videowiedergabe fehlen hier, weil die Resets in der Zeile *Session frames dropped by the TV* stehen.
  - Bilder, die ankommen, während die Videowiedergabe des TVs geschlossen ist (z. B. wenn die App verdeckt ist), zählen nicht als Netzwerkverlust.
- Eine Zeile zeigt, ob der TV per LAN oder WLAN verbunden ist. Im WLAN steht dort die Signalstärke, die alle 5 Sekunden aktualisiert wird. Liefert der TV keinen Wert, fehlt die Signalstärke.
- Drei Zeilen zur Fehlerkorrektur und zum Empfangspuffer:
  - *Session FEC recoveries* zeigt, wie oft die Fehlerkorrektur in der Sitzung verlorene Pakete repariert hat. Dazu kommen die längste Reparatur und die Zahl langsamer (ab 8 ms) und fehlgeschlagener Reparaturen.
  - *Worst FEC block* zeigt, wie knapp der schlimmste Block war.
  - *UDP receive buffer* zeigt den angeforderten und den vom TV gemeldeten UDP-Empfangspuffer.
- *TV player rejections* erscheint, sobald der Videoplayer des TVs Bilder abgelehnt hat. Die Zeile zählt sie nach Grund: Puffer voll, Schlüsselbild nötig, Spur nicht bereit, anderes. Bei vollem Puffer zeigt sie auch, wie viele Bilder der erneute Versuch gerettet hat.
- *WASM heap top* zeigt den Speicherverbrauch der Streaming-Engine. So fällt ein Speicherleck bei langen Sitzungen auf, bevor die App abstürzt.
- *Moonlight hidden during the stream* zählt, wie oft die App während des Streams verdeckt war und wie oft der TV das Video geschlossen hat.
- Mit dem Audio-Backend *Web Audio* zeigen neue Zeilen:
  - Jitter-Puffer, Vorlauf und Browser-Latenz
  - Aussetzer sowie übersprungene und verlorene Ton-Pakete
  - die Korrektur von *Audio clock sync* und eine vorgeschlagene Puffergröße

#### Dokumentation

- **S90C:** neuer ausführlicher Optimierungsplan auf Deutsch (`docs/S90C-Optimierungsplan.md`). Er gibt Hinweise zu Netzwerk, PC und TV-Einstellungen und beschreibt einen Testablauf. Er enthält unter anderem:
  - eine Bitrate-Stufenfolge für WLAN (100, 120, 135 und 150 Mbit/s) mit festen Kriterien, wann eine Stufe als bestanden gilt, und einer Regel für den Endwert
  - Hinweise, wann man die Fehlerkorrektur (FEC) in Sunshine erhöhen sollte
  - einen Dauertest über 2,5 Stunden
  - einen Vergleich AV1 gegen HEVC und Hinweise zur richtigen Bildwiederholrate des PC-Bildschirms
  - die ganze Latenzkette (Spielmodus des TVs, Frame Generation, Frame Pacing, Encoder, Tonpuffer) und Hinweise zur Bildqualität im Stand und in Bewegung
  - Encoder-Empfehlungen für Sunshine, etwa Split Frame Encoding und eine VBV-Erhöhung nur über WLAN
  - eine realistische Einschätzung von 4K mit 120 FPS: Das Overlay zählt die an den Player übergebenen Bilder und kann nicht belegen, dass der TV 120 Bilder zeigt
  - typische Fehlerbilder und ihre Lösungen
- **S90C:** Der Plan beschreibt außerdem:
  - wie man im Sunshine-Log prüft, was tatsächlich ausgehandelt wurde (HDR, Bittiefe, Farbbereich, Encoder-Optionen) und welche Bitrate der Encoder bekommt
  - einen Latenztest mit einer Kamera und einen Schärfetest mit 1 Pixel breiten Linien
  - die automatische Abschaltung des TVs nach spätestens 4 Stunden ohne Bedienung
  - einen Test für Verlassen und Rückkehr: Home-Taste, TV-Menüs, Eingangswechsel, rote Taste während des Starts
  - alle Zeilen der Leistungsstatistik
- **S90C:** neue einseitige Kurzanleitung zum Einrichten und Testen auf dem S90C (`docs/S90C-Kurzanleitung.md`).
- Abschnitt A des Plans wertet ein konkretes Setup aus, das des Autors. Auch die Kurzanleitung geht an einigen Stellen davon aus, z. B. bei der FEC-Einstellung. Die übrigen Kapitel des Plans gelten für jeden S90C.
- Die README weist darauf hin, dass dieser Fork für den Samsung S90C optimiert ist, und verweist auf den Optimierungsplan.

#### Build

- Die Download-Dateien heißen weiterhin `Moonlight.wgt` und `Moonlight-ForceGM.wgt`. Der Build übernimmt die vom Tizen-Werkzeug erzeugte Datei unabhängig von ihrem neuen Namen.
- Die Build-Abläufe für Vorab- und stabile Versionen laufen nacheinander. So kann ein Release nicht das ForceGM-Paket eines anderen Stands erhalten.
- Die Beschreibung von Vorabversionen entsteht automatisch aus den Versionshinweisen. Sie enthält Links zum Commit, zum Changelog, zur Kurzanleitung und zum Optimierungsplan.
- Der Workflow „Release (Development)“ kann eine getestete Vorabversion mit unveränderten Dateien zu einem vollständigen Release machen. So ist dieses Release entstanden. Es bekommt dabei ein eigenes Tag (hier `v1.19.0-s90c.1`), das die Update-Prüfung der App nicht als neuere Version liest. Das betrifft nur GitHub, nicht die App auf dem TV.

### Neue Standardeinstellungen

Weil Moonlight S90C eigene Einstellungen hat, beginnt man mit diesen Werten, auch wer vorher die normale Moonlight-App genutzt hat. Nur wer schon eine Vorabversion von Moonlight S90C installiert hatte, behält seine gespeicherten Werte. Mit *Restore Defaults* lassen sie sich auf diese Werte zurücksetzen. Der Button *Samsung S90C optimization* setzt die Bildwerte genauso.

- *Video resolution*: 1280 x 720 (720p) → die höchste Auflösung des TVs bis 4K. Das ist 3840 x 2160 auf 4K- und 8K-TVs, sonst 2560 x 1440 oder 1920 x 1080.
- *Video bitrate*: 10 Mbit/s → je nach Verbindung 75 Mbit/s (LAN), 100 Mbit/s (WLAN) oder 80 Mbit/s (Verbindung nicht erkannt).
  - Der WLAN-Wert folgt der 4K-HEVC-Decoder-Spezifikation des S90C.
  - Die Werte sind für 4K gedacht, gelten aber auch auf TVs ohne 4K-Panel. Dort die Bitrate am besten von Hand senken.
- *Video codec*: H.264 → HEVC.
- *Video HDR*: aus → an, nur auf HDR-fähigen TVs.
- *Unlock all frame rates*: aus → an (der S90C hat ein 144-Hz-Panel). 90, 120 und 144 FPS stehen damit direkt zur Auswahl, voreingestellt bleiben 60 FPS.
- Bitrate beim Ändern von Auflösung oder Bildrate (mit *Optimize bitrate presets* auch von Codec und HDR): sprang auf die Voreinstellung → bleibt, bis man *Optimize bitrate presets* umschaltet.
- *Restore Defaults* schaltet *Video frame pacing* und *Host address field mode* jetzt an. Vorher schaltete es beide fehlerhaft aus.
- Neue Einstellungen *Reference frame invalidation*, *HDR static metadata* und *Audio clock sync*: aus.
- Unverändert bleiben:
  - *Video frame rate* (60 FPS)
  - *Optimize bitrate presets* (aus)
  - *Color range* (eingeschränkter Bereich)
  - *Audio backend* (EMSS)
  - *Audio jitter buffer* (100 ms)
  - *Game mode*, der wie bisher von der Tizen-Version abhängt

### Hinweise

- Dieses Release enthält genau die Dateien der getesteten Vorabversion von Commit 95f5b12, sie wurden nicht neu gebaut. Unter Settings → About → *System information* steht deshalb „App Version: Moonlight S90C v1.19.0 (pre-95f5b12)“. Bei der ForceGM-Variante steht dort „Moonlight S90C-ForceGM …“.
- Diese Version läuft auf dem Samsung S90C des Autors. Andere Modelle hat der Autor nicht getestet, die experimentellen Einstellungen nicht systematisch.
- Die LAN-Grenzen (75 Mbit/s bei den Voreinstellungen, Warnung über 80 Mbit/s) gehen von einem 100-Mbit/s-LAN-Anschluss des TVs aus.
- Die Update-Prüfung der App (*Check for updates*) schaut auf die Releases dieses Projekts, nicht auf die von Moonlight Tizen.
- Manche Vorabversionen dieses Forks stammen aus der Zeit vor der Umbenennung. Sie stehen auf dem TV weiter als „Moonlight“, weil sie die normale Moonlight-App ersetzt haben. Man kann sie deinstallieren oder die normale Moonlight-App darüber installieren. Moonlight S90C wird davon unabhängig daneben installiert.
- Portugiesisch (pt-BR) ist nur teilweise übersetzt. Etwa die Hälfte der neuen Texte erscheint auf Englisch, darunter der S90C-Dialog, die neuen Warnungen, *Reference frame invalidation*, *HDR static metadata* und einige Zeilen der Leistungsstatistik.
