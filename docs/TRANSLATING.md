# Translating Moonlight Plus

The app shows its texts in English, German, Spanish, French or Brazilian Portuguese. It follows the language of the TV, and the language can be chosen in Settings → UI Settings → *Language*. This page is for anyone who adds a text to the app, corrects a translation or adds a language.

## Contents

- [How the languages work](#how-the-languages-work)
- [Adding or changing a text](#adding-or-changing-a-text)
- [Rules for every language](#rules-for-every-language)
- [German glossary](#german-glossary)
- [Spanish glossary](#spanish-glossary)
- [French glossary](#french-glossary)
- [Adding a language](#adding-a-language)

## How the languages work

- The English texts are the keys. `wasm/static/locales/en-US.json` maps each English text to itself, and every other locale file maps the same keys to its translation.
- `wasm/platform/i18n.js` lists the languages in `LOCALES`, each with the name it has in its own language (*English*, *Deutsch*, *Español*, *Français*, *Português (Brasil)*), in the order of the language menu after *Auto*.
- With *Auto* the app takes the language of the TV (`tizen.systeminfo` `LOCALE`, else the languages of the browser): first the locale itself, then a locale of the same language, so de-AT and de-CH get German, es-MX, es-US and es-419 get Spanish, fr-CA, fr-BE and fr-CH get French, and pt-PT gets Brazilian Portuguese. The other languages of Spain (ca, eu, gl) are languages of their own and get English. Any other language gets English. A stored language that the app no longer has counts as *Auto*.
- Each language adds about 60 KB to the package, so the app keeps to a few languages that its users need.

## Adding or changing a text

1. Use the English text in the code: `t('Text')`, `snackbarLog('Text')`, `warningDialog('Title', 'Text')` or `data-i18n="Text"` in `wasm/index.html`.
2. Run `node wasm/static/js/i18n-sync.js`. It collects the texts of `wasm/`, writes them to `en-US.json` and adds a new key to every other locale file with the English text.
3. Translate the new keys in every locale file by hand.
4. Run `node tests/tools/i18n-check.js` (part of `npm test --prefix tests`). It fails if a locale file is out of sync, misses a key or has a key too many, still has the English text of a key, or changes a placeholder, an HTML tag, a line break, the leading dash of a help text or the spaces at its start or end. A text that is really the same as in English (a codec name, a number, a key name) goes into `tests/tools/i18n-same-as-english/<locale>.json`.

## Rules for every language

- **Placeholders** such as `%1$s` stay, each exactly once; their order in the sentence may change.
- **HTML** such as `<br>`, `<b>` and `<strong>` stays. Write characters as they are, never as `&amp;`: the texts of `data-i18n` elements are set as text, so a character reference would show as it is.
- **Help texts** of the settings start with `- ` and the lines of the navigation guide with `— `. Keep them: the stylesheet hides the first character of a help text.
- **Whole sentences:** a word is never put in front of another translated text. A line that names a value has a template of its own, and so does the same line without a value: *Starting the %1$s...* for the progress line of a stage of the connection, *Gamepads: None* next to *Gamepad %1$s: …*, *Registered by Moonlight: None* next to *Registered by Moonlight: %1$s*. So each language builds its own sentence and agrees *none* with its noun (Spanish *ninguna* for *teclas*, French *aucune* for *manettes*, German *keine* in lower case after a colon). The single word *None* is only the value of its own, e.g. the target of a button in the button mapping.
- **Key names stay as printed** on the remote, the keyboard and the gamepad: OK, RETURN, Play/Pause, CH+, SELECT, START, A, B, LB, RB, F1. Keys without a printed name get the word of the language (the arrow keys, the coloured keys).
- **Names of settings, menu entries and values** in a sentence are written as the translated UI shows them, e.g. the name of the *Unlock all frame rates* switch in the hint of the optimal settings dialog.
- **Product names** stay: Moonlight Plus, Sunshine, GeForce Experience, GameStream, Wake-on-LAN, ForceGM, HEVC, AV1, HDR. A section of the English guide is named by its English heading.
- **Length:** a translation may be longer than the English text, but chips, badges and menu entries have little room. Keep their words short and check the screens (the browser tests check the settings rows and the compact statistics line in every language).

## German glossary

The German texts address the user with the informal *du* and use the words of the German UI of Samsung TVs.

| English | German | Note |
|---|---|---|
| host, host PC | PC | *Host* only in compounds and for host software: *Host-Audio*, *Hosts wie Wolf* |
| pair, pairing | koppeln, Kopplung | *gekoppelt*, *nicht gekoppelt* |
| gamepad, controller | Controller | |
| remote | Fernbedienung | |
| TV | TV | *der TV*, *des TVs*, not *Fernseher* |
| settings | Einstellungen | sections: *Grundeinstellungen*, *Oberflächeneinstellungen*, *PC-Einstellungen*, *Eingabeeinstellungen*, *Audioeinstellungen*, *Videoeinstellungen*, *Erweiterte Einstellungen*, *Info* |
| Auto | Automatisch | |
| On, Off | An, Aus | |
| stream, streaming | Stream, streamen | *beim Streamen*, *Streaming-Einstellungen* |
| Stream Menu | Stream-Menü | |
| resume, quit | fortsetzen, beenden | |
| hide, hidden | ausblenden, ausgeblendet | |
| favorite | Favorit | *Zu Favoriten hinzufügen*, *Aus Favoriten entfernen* |
| recently played | zuletzt gespielt | |
| wake | aufwecken | *PC aufwecken* |
| frame rate | Bildrate | FPS stays |
| bitrate | Bitrate | Mbps stays |
| resolution | Auflösung | |
| frame, keyframe | Frame, Keyframe | |
| frame pacing | Frame-Pacing | |
| dropped frames | verworfene Frames | |
| game mode | Spielmodus | the decoder modes stay *Ultra Low Latency* and *Low Latency* |
| rumble | Vibration | |
| mouse emulation | Mausemulation | |
| button mapping | Tastenbelegung, Belegung | *Belegung aller Controller*, *Eigene Belegung* |
| calibrate, calibration | kalibrieren, Kalibrierung | *Sticks kalibriert* |
| stick | Stick | *linker Stick*, *rechter Stick* |
| input test | Eingabetest | |
| diagnostic log | Diagnoseprotokoll | |
| session | Sitzung | *Letzte Sitzung*, *Diese Sitzung*, *Vorige Sitzung* |
| hint | Tipp | |
| performance statistics | Leistungsstatistik | levels: *Aus*, *Kompakt*, *Vollständig* |
| jitter buffer | Jitter-Puffer | |
| Audio clock sync | Audio-Taktabgleich | |
| Wi-Fi | WLAN | Ethernet stays |
| Support (button) | Hilfe | |
| Starting (start screen) | Wird gestartet | a status above the title of the game; the progress line of a stage has a template of its own: *RTSP-Handshake wird gestartet …* |
| remote keys | OK, RETURN, PLAY/PAUSE, CH+, CH-, VOL+, VOL-, MUTE | the arrows *OBEN*, *UNTEN*, *LINKS*, *RECHTS*, the colour keys *ROT* and *GELB* (*rote Taste*, *gelbe Taste* in a sentence) |
| keyboard keys | ENTER, ESC, LEERTASTE, STRG + ALT + SHIFT | |
| gamepad keys | A, B, X, Y, SELECT, START, LB, RB | *STEUERKREUZ*, *L-STICK*, *R-STICK*, *LINKE* and *RECHTE SCHULTERTASTE* |

Write *z. B.*, *evtl.* and decimal commas (*0,5 Mbps*), and a typographic ellipsis with a space before it (*wird geladen …*). `tests/unit/german-texts.test.js` checks the *du*, the main terms of this table and the key names.

## Spanish glossary

The Spanish texts address the user with the informal *tú* (*Selecciona*, *Pulsa*, *¿Seguro que quieres …?*) in a neutral European Spanish that users in Latin America understand: words that only one region uses (*ordenador*, *computadora*) are avoided.

| English | Spanish | Note |
|---|---|---|
| host | equipo | *Añadir equipo*, *Ajustes del equipo* |
| PC | PC | *el PC*, *Enviar al PC*, *Despertar el PC* |
| pair, pairing | vincular, vinculación | |
| gamepad, controller | mando | *Mandos* |
| remote | mando a distancia | |
| TV | televisor | |
| settings | Ajustes | sections: *Ajustes básicos*, *Ajustes de interfaz*, *Ajustes del equipo*, *Ajustes de entrada*, *Ajustes de audio*, *Ajustes de vídeo*, *Ajustes avanzados*, *Acerca de* |
| Auto | Automático | |
| On, Off | Activado, Desactivado | |
| stream, streaming | transmisión | not *retransmisión* |
| Stream Menu | Menú de transmisión | |
| resume, quit | reanudar, cerrar | |
| hide, hidden | ocultar, oculta | |
| favorite | favorita (an app), favoritos | *Añadir a favoritos*, *Quitar de favoritos* |
| frame, keyframe | fotograma, fotograma clave | FPS stays |
| frame rate | frecuencia de fotogramas | |
| bitrate | tasa de bits | Mbps stays |
| game mode | modo de juego | |
| rumble | vibración del mando | |
| mouse emulation | emulación del ratón | |
| button mapping | asignación de botones | |
| stick | stick | *stick izquierdo*, *stick derecho* |
| input test | prueba de controles | |
| diagnostic log | registro de diagnóstico | |
| session | sesión | |
| hint | consejo | |
| performance statistics | estadísticas de rendimiento | levels: *Desactivado*, *Compacto*, *Completo* |
| Support (button) | Ayuda | |
| remote keys | OK, RETURN, Play/Pause, CH+, CH-, VOL+, VOL-, MUTE | the arrows *ARRIBA*, *ABAJO*, *IZQUIERDA*, *DERECHA*, the colour keys *ROJO* and *AMARILLO* (*botón rojo* in a sentence) |
| gamepad keys | A, B, X, Y, SELECT, START, LB, RB | *CRUCETA*, *STICK IZQUIERDO*, *STICK DERECHO* |

A question opens with ¿ and an exclamation with ¡; quotes are « » without spaces (*«Mostrar las aplicaciones ocultas»*). Write *p. ej.*, decimal commas (*0,5 Mbps*) and a typographic ellipsis without a space (*Iniciando…*).

## French glossary

The French texts address the user with *vous*, as the menus of French TVs do (*Sélectionnez*, *Appuyez*, *Voulez-vous vraiment … ?*).

| English | French | Note |
|---|---|---|
| host, host PC | PC | *Ajouter un PC*, *Paramètres des PC*; *hôte* only for the hostname and for host software (*nom d’hôte*, *hôtes de type Wolf*, *audio de l’hôte*) |
| pair, pairing | associer, association | |
| gamepad, controller | manette | |
| remote | télécommande | |
| TV | téléviseur | |
| settings | Paramètres | sections: *Paramètres généraux*, *Paramètres de l’interface*, *Paramètres des PC*, *Paramètres des commandes*, *Paramètres audio*, *Paramètres vidéo*, *Paramètres avancés*, *À propos* |
| Auto | Automatique | |
| On, Off | Activé, Désactivé | |
| stream, streaming | streaming | *pendant le streaming* |
| Stream Menu | Menu de streaming | |
| resume, quit | reprendre, quitter | |
| hide, hidden | masquer, masquée | |
| favorite | favori | *Ajouter aux favoris*, *Retirer des favoris* |
| frame, keyframe | image, image clé | FPS stays |
| frame rate | fréquence d’images | |
| bitrate | débit | Mbps stays (*Mo* for megabytes) |
| game mode | mode Jeu | as in the picture settings of the TV |
| rumble | vibrations | |
| mouse emulation | émulation de la souris | |
| button mapping | attribution des boutons | |
| stick | stick | *stick gauche*, *stick droit* |
| input test | test des commandes | |
| diagnostic log | journal de diagnostic | |
| session | session | |
| hint | conseil | |
| performance statistics | statistiques de performances | levels: *Désactivé*, *Compact*, *Complet* |
| Support (button) | Aide | |
| remote keys | OK, RETURN, Play/Pause, CH+, CH-, VOL+, VOL-, MUTE | the arrows *HAUT*, *BAS*, *GAUCHE*, *DROITE*, the colour keys *ROUGE* and *JAUNE* (*touche rouge* in a sentence) |
| gamepad keys | A, B, X, Y, SELECT, START, LB, RB | *CROIX*, *STICK GAUCHE*, *STICK DROIT* |

Put a no-break space (U+00A0) before : ; ? ! and inside « » (*« Afficher les applications masquées »*), so that the sign never starts a line, and use the typographic apostrophe (*l’application*). Write *par exemple*, decimal commas (*0,5 Mbps*) and a typographic ellipsis without a space (*Démarrage…*).

`tests/unit/spanish-french-texts.test.js` checks the *tú* and the *vous*, the punctuation of each language, the main terms of these tables and the key names.

## Adding a language

1. Add the locale with its own name to `LOCALES` in `wasm/platform/i18n.js`, e.g. `{ code: 'it-IT', name: 'Italiano' }`.
2. Create `wasm/static/locales/<locale>.json` as `{}` and run `node wasm/static/js/i18n-sync.js`, which fills in every key with the English text.
3. Translate every text, and list the texts that stay English in `tests/tools/i18n-same-as-english/<locale>.json` (`{ "description": "...", "keys": [...] }`). If the language uses a character that the Manrope subset of the app lacks (`wasm/static/fonts/Manrope-latin-wght.woff2`, Latin-1 and the punctuation of the UI), the font test fails: add the character to the subset and to the `unicode-range` of its face in `wasm/static/css/style.css`, as was done for ¿ ¡ « ».
4. Run `npm test --prefix tests`. The checks of the locale list (`tests/unit/i18n-locales.test.js`), the font (`tests/unit/theme-assets.test.js`) and the layout (`tests/browser/theme-settings.test.js`, `tests/browser/performance-stats-levels.test.js`) cover the new language once its file exists. Check the screens in the new language as well, since a test can't judge a wrapped word.
5. Name the translators in the changelog and in the credits of the README.
