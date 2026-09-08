# YouTube Recorder

<div align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a> ·
  <b>Deutsch</b> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.it.md">Italiano</a>
</div>

Chrome-Manifest-V3-Erweiterung: Auf der Videoseite einer unterstützten Website — **YouTube, Bilibili, Dailymotion, Vimeo, Instagram, Facebook, TikTok** — startet ein **manueller Klick** die Aufnahme. Sie erfasst die vollständige Oberfläche des aktuellen Tabs samt Seitenton, schneidet im Browser mit Canvas Bild für Bild **den tatsächlich dargestellten Bildbereich des Players (oder einen frei aufgezogenen Bereich)** aus und speichert schließlich eine **Videodatei mit Ton** lokal — bevorzugt nativ **MP4 (H.264/AAC)**, mit automatischem Rückfall auf **WebM**, wenn Browser oder System es nicht unterstützen.

Die aufzunehmende Website wird automatisch erkannt: Die Erweiterung ermittelt die Website aus der Domain der aktuellen Seite und schaltet entsprechend das Präfix des Dateinamens und die Website-Beschriftung im Popup / in den Benachrichtigungen um (siehe „Unterstützte Websites" unten).

## Funktionen

- **Eine Aufnahme für sieben große Video-Plattformen**: Die nativen Videoseiten von YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok laufen alle über dieselbe Kette (tabCapture → Player finden → Canvas-Zuschnitt → MediaRecorder). Die aktuelle Website wird automatisch erkannt und schaltet Dateinamen-Präfix und Website-Texte um; Layout-Unterschiede zwischen alten und neuen Playern jeder Website sind in `src/shared/sites.js` an einer Stelle gebündelt und gewartet (siehe „Unterstützte Websites" unten).
- **Keine Drittanbieter-Abhängigkeiten**: kein npm, kein Build-Schritt, kein ffmpeg, keinerlei Umkodierung (MP4 wird nativ von `MediaRecorder` aufgenommen, nie nachträglich konvertiert).
- **Zwei Aufnahmemodi**
  - **Ganzer Player**: Ermittelt automatisch das *tatsächlich gezeichnete* Rechteck des Players (berechnet aus `object-fit` / `object-position`) und schließt schwarze Balken, Randbereiche des Kinomodus und das Player-Chrome aus.
  - **Bereich auswählen**: Ein Rechteck beliebig auf der Seite aufziehen und nur diesen Bereich aufnehmen.
- **Garantiert sauberes Bild**: Alle Bedienelemente liegen im Popup des Erweiterungssymbols (eine eigenständige Erweiterungsseite, die nicht zum Rendervorgang des erfassten Tabs gehört) — keine Erweiterungs-UI kann im Video auftauchen.
- **Seiten-Tastenkürzel**: Standardmäßig startet die einzelne Taste `R` die Aufnahme im Leerlauf und stoppt/speichert sie während der Aufnahme. Frei änderbar im Popup unter **Einstellungen** (Kombinationen mit `Ctrl` / `Alt` / `Shift` / `Command`). Es wirkt nur auf Videoseiten unterstützter Websites, entwendet keine Tasten anderer Tabs und kollidiert nie mit globalen Browser-Shortcuts.
- **Seite während der Aufnahme gesperrt**: Eine halbtransparente Maske deckt alles *außerhalb* des Bildes ab (mit ausgespartem „Loch" für das Bild) und blockiert Scrollen, Klicks und destruktive Tastenkürzel — während **Wiedergabe/Pause, Suchen, Lautstärke, Untertitel und Wiedergabegeschwindigkeit voll nutzbar bleiben**.
- **Stabiler Zuschnitt**: Feste 30 fps; die Canvas-Größe wird mit dem ersten Bild fixiert; das Zuschnitt-Rechteck muss 3 Bilder in Folge stabil bleiben, bevor die Aufnahme startet, damit keine kurzzeitig zu großen Rechtecke (Werbung, Wechsel in den Kinomodus) im fertigen Video landen.
- **Kein Tonverlust**: Die erfasste Tonspur wird über einen `AudioContext` wiedergegeben, damit der Tab nicht stummgeschaltet wird und kein tonloses Video entsteht.
- **„Aufnahme läuft" auch im Vollbild sichtbar**: Im Vollbild füllt das Bild den Bildschirm und der Maskenhinweis hat keinen Platz. Der Status wird dann durch eine dauerhafte Systembenachrichtigung plus ein immer im Vordergrund liegendes Document-PiP-Statusfenster (REC + Timer + Stopp-Button) angezeigt; hat das Bild schwarze Balken, wird darin zusätzlich ein feiner roter Rahmen gezeichnet. Alle Indikatoren liegen außerhalb des erfassten Bildes und **gelangen nie ins Video**; jeder lässt sich einzeln im Popup unter **Einstellungen → Statusanzeige der Vollbildaufnahme** schalten.
- **Umfassende Ausfallsicherung**: DRM-Schwarzbild-Erkennung, automatisches Stoppen und Exportieren beim Tab-Wechsel oder Navigieren, Selbstheilung bei stockendem Rechteck-Heartbeat, automatischer Download-Wiederholversuch sowie „Zurücksetzen und neu starten" für hängende Sitzungen.
- **Aufnahme ausschließlich durch einen Nutzerklick ausgelöst** — niemals stille Aufzeichnung im Hintergrund.

## Unterstützte Websites

Die Aufnahmekette (tabCapture → Player finden → Canvas-Zuschnitt → MediaRecorder) ist auf jeder Website identisch; es unterscheiden sich nur drei Dinge: die **Injektions-Domains** (`content_scripts.matches` in `manifest.json`), die **DOM-Selektoren** zum Auffinden des Players und der **Website-Name** für Dateinamen-Präfix / Texte. Die folgende Tabelle zeigt die aktuell unterstützten Websites und ihre anwendbaren Seiten:

| Website | Aufnehmbare Seitenformen | Hinweise und Einschränkungen |
| --- | --- | --- |
| YouTube | Video-Seiten (`youtube.com/watch…`, Shorts usw.) | Mitglieder-/Bezahl-/DRM-Inhalte werden schwarz dargestellt (Browserschutz; siehe allgemeine Einschränkungen unten) |
| Bilibili | Video-Seiten (`bilibili.com/video/BV…`) | Sowohl der neue bpx- als auch der alte Bilibili-Player sind abgedeckt; Serien/Filme unter Mitgliedschaft/DRM können schwarz werden; **Live-Streams werden nicht unterstützt** |
| Dailymotion | Video-Seiten (`dailymotion.com/video/…`) | Ist das `<video>` des Players in ein Cross-Origin-iframe / Shadow-DOM verpackt (aus dem Hauptdokument nicht lesbar), wird automatisch auf das Rechteck des Player-Gehäuse-Containers zurückgegriffen |
| Vimeo | Video-Seiten (`vimeo.com/…`) | Private Videos erfordern Login und Anzeigeberechtigung |
| Instagram | Beiträge / Reels / Storys (geöffnete Modalsicht), einzelne Videos im Home-Feed | Manche Inhalte haben erst nach Login ein abspielbares Video |
| Facebook | Watch / Reels / Einzelvideo-Overlays / Videos im Newsfeed | Manche Inhalte erfordern Login; bei mehreren Videos im Feed wird automatisch das „aktuell sichtbare Hauptvideo" getroffen |
| TikTok | Video-Detailseiten (`tiktok.com/@…/video/…`), geöffnete Video-Overlays, einzelne Einträge im For-You-Feed | Bei mehreren Vorschauen im Feed wird automatisch die „aktuell laufende / flächengrößte sichtbare" getroffen |

> **Lokalisierungsmechanismus**: Das Content Script lokalisiert den Aufnahmebereich über das *tatsächlich sichtbare* `<video>` auf der Seite. `src/shared/sites.js` verwaltet zentral die Kandidaten-Selektoren für Player-Container / video der alten und neuen Layouts jeder Website; wird ein Container getroffen, wird dessen inneres `<video>` genommen und aus `object-fit` / `object-position` das tatsächlich dargestellte Bildrechteck abgeleitet (unter Ausschluss von Balken, Chrome und Leerraum). Greifen alle Kandidaten nicht, dient das „dekodierte `<video>` mit der größten sichtbaren Fläche" als generischer Rückfall (rekursiv über offene Shadow-DOMs). Der Hauptplayer muss sein echtes `<video>` also in das Hauptdokument der Seite (oder einen lesbaren offenen Shadow-Root) rendern — **aus anderen Webseiten per Cross-Origin-iframe eingebettete Player sind nicht unterstützt**; rein selbst gezeichnete Flächen per Canvas / WebGL (kein `<video>`) lassen sich nicht automatisch lokalisieren — nutzen Sie **„Bereich auswählen"**.

> **Allgemeine Einschränkungen**:
> - Durch DRM / bezahlte Mitgliedschaft geschützte Videos (bezahlte Filme, Abo-Exklusives, exklusiv lizenzierte Inhalte der Plattformen) erscheinen in der Aufnahme schwarz — eine „geschützter Inhalt"-Beschränkung des Browsers, kein Fehler der Erweiterung;
> - Für Inhalte, die Login erfordern (die meisten Videos auf Instagram / Facebook / TikTok, manche Bilibili-Serien usw.), melden Sie sich zuerst im Browser bei der jeweiligen Website an;
> - Driften die Selektoren nach einem Website-Redesign und teilen sich mehrere sichtbare `<video>`s den Bildschirm, nimmt der Aufnahmebereich standardmäßig das dekodierte mit der größten sichtbaren Fläche — halten Sie das Zielvideo sichtbar im Viewport in Wiedergabe.

## Projektstruktur

```
DESIGN.md                    Technisches Designdokument (Fähigkeiten / Architektur / Nachrichtenprotokoll / Grenzfälle / Datenfluss)
TODO.md                      Aufgabenliste (bei Abnahme abhaken)
src/
├── manifest.json            MV3-Manifest (tabCapture + downloads + activeTab + offscreen + storage + notifications)
├── background.js            Service Worker: Offscreen-Lebenszyklus, Nachrichten-Routing, globaler Status und Badge, Systembenachrichtigungen, Download-Proxy
├── offscreen.html           Host des Offscreen-Dokuments
├── offscreen.js             Aufnahmekern: getUserMedia(Tab-Stream) → verstecktes video → Canvas-Zuschnitt → MediaRecorder → Blob
├── shared/
│   ├── hotkey.js            Gemeinsame Definition des Kürzels „Aufnahme starten / stoppen" (Popup-Einstellungen, Hinweis, Content-Listener)
│   ├── indicator.js         Lesen/Schreiben der drei Schalter der Vollbild-Statusanzeige (pip / notif / border) (popup / content / guard)
│   ├── countdown.js         Gemeinsame Definition und Lesen/Schreiben der Sekunden des „Countdowns vor Aufnahmestart" (popup / content / background)
│   └── sites.js             Erkennung unterstützter Websites (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok)
│                           und Kandidaten-Selektoren der Player pro Website (content / popup / countdown)
├── content/
│   ├── guard.js             Seitensperr-Maske während der Aufnahme (Loch passend zum Bild) + roter Rahmen in schwarzen Balken im Vollbild
│   ├── pip.js               Immer im Vordergrund liegendes Document-PiP-Statusfenster im Vollbild (REC + Timer + Stopp-Button)
│   ├── selector.js          Auswahl-Overlay für den Bereich (nach Klick auf „Bereich aufnehmen" aktiviert)
│   ├── countdown.js         Seiten-Overlay des „Countdowns vor Aufnahmestart" (erst Overlay entfernen, dann Erfassung starten)
│   ├── content.js           Skript ohne Oberfläche: Player-Rechteck-Heartbeat + Meldungen bei Ausblenden/Navigation + Maske ein/aus
│   └── hotkey.js            Listener für das seitenweite Kürzel „Aufnahme starten / stoppen"
├── popup.html               Popup des Erweiterungssymbols: Aufnahmekonsole (Start / Bereich / Stopp / Status / Timer / Hinweise / Einstellungen)
├── popup.js
├── popup/
│   └── settings.js          Einstellungsdialog (Tastenkürzel, Countdown vor Start, Schalter der Vollbild-Statusanzeige)
├── assets/                  Statische Ressourcen
├── icons/                   16/32/48/128 Icons
└── types/                   chrome.*-API-Typdeklarationen (nur Typen)
scripts/verify_extension.py  Statisches Selbstprüfskript
```

## Warum ein Offscreen-Dokument?

`chrome.tabCapture` kann nicht aus einem Content Script aufgerufen werden, während die Pipeline aus `video` / `canvas` / `MediaRecorder` einen Fensterkontext mit DOM benötigt. Ein Popup schließt sich, sobald es den Fokus verliert, und ein Service Worker hat gar kein DOM — daher liegt der Aufnahmekern in einem **Offscreen-Dokument**:

1. Das **Content Script** (es injiziert selbst keine UI, sondern meldet nur Daten) lokalisiert den Player auf der unterstützten Seite (von `shared/sites.js` erkannt) etwa alle 120 ms und meldet das tatsächliche Bildrechteck sowie die Viewport-Basis (CSS-Größe, `devicePixelRatio`, Visual-Viewport-Versatz).
2. **background** erstellt bei Bedarf das Offscreen-Dokument und ruft `chrome.tabCapture.getMediaStreamId()` innerhalb der Nutzer-Geste auf, um eine `streamId` zu erhalten.
3. Das **Offscreen**-Dokument konsumiert den gesamten Tab-Stream über `getUserMedia({ chromeMediaSourceId: streamId })` (Bild + Seitenton).
4. Im **Offscreen**-Dokument: verstecktes `video` spielt den Tab-Stream → verstecktes `canvas` schneidet Bild für Bild mit `drawImage` → die Videospur aus `canvas.captureStream(30)` wird mit der ursprünglichen `audioTrack` zusammengeführt → `MediaRecorder` nimmt auf (`video/mp4` zuerst, schrittweiser Rückfall auf `video/webm`) → die Fragmente werden zu einem Blob zusammengesetzt.
   - Die Koordinatenumrechnung nutzt ein **gemessenes Verhältnis** („Größe des erfassten Bildes ÷ CSS-Größe des Viewports", mit contain-Modell und zentrierter Auffüllung) statt eines naiven `rect × devicePixelRatio` — damit gibt es auf HiDPI-Displays und bei Zoom keinen Versatz.
5. Das Offscreen-Dokument kann `chrome.downloads` **nicht** direkt aufrufen: Es sendet `DOWNLOAD_FILE` an **background**, das den Download ausführt und das Ergebnis über `downloads.onChanged` zurückmeldet.

Details siehe `DESIGN.md`.

## Laden (Entwicklung)

1. Chrome öffnen und `chrome://extensions` aufrufen.
2. Oben rechts den **Entwicklermodus** aktivieren.
3. Auf **Entpackte Erweiterung laden** klicken und das Verzeichnis `src/` dieses Repositorys wählen (kein Build-Schritt, nichts zu kompilieren).

> Voraussetzung: Chrome ≥ 116 (`minimum_chrome_version`, für `chrome.offscreen` erforderlich); native MP4-Ausgabe benötigt Chrome ≥ 126. Die aktuelle stabile Version wird empfohlen.

## Bedienung

1. Eine Videoseite einer unterstützten Website öffnen (siehe „Unterstützte Websites" oben — z. B. eine YouTube-Wiedergabeseite, eine Bilibili-Seite `video/BV…`, eine TikTok-Videodetailseite; beim ersten Besuch einmal aktualisieren, damit die Skripte injiziert werden). Das Video normal abspielbar halten — DRM-/Bezahlvideos werden schwarz, eine Schutzbeschränkung des Browsers.
2. Auf das Erweiterungssymbol klicken → im Popup **Aufnahme starten** klicken (Tab sichtbar halten, Player vollständig im Viewport).
   - Wenn Browser/System kein natives MP4 erzeugen kann (Chrome < 126 oder fehlende H.264/AAC-Encoder), erklärt das Popup den Rückfall auf WebM.
   - Während der Aufnahme zeigt das Symbol ein rotes `REC`-Badge. Das Schließen des Popups beendet die Aufnahme nicht — einfach erneut auf das Symbol klicken.
3. **Bereich aufnehmen** (optional): **Bereich aufnehmen** klicken → das Popup schließt sich → ein Rechteck auf der Seite aufziehen → **Auswahl aufnehmen** klicken (`Esc` verlässt die Auswahl).
   - Während der Aufnahme wird die Schaltfläche **Stopp** automatisch *außerhalb* der Auswahl platziert, damit sie nie ins Video gerät. Füllt die Auswahl fast den gesamten Viewport und ist kein Platz mehr, werden die Bedienelemente auf der Seite ausgeblendet — dann über das Popup oder das Tastenkürzel stoppen.
4. Zum Beenden **Stoppen und speichern** klicken → die Datei wird zusammengesetzt und als `Website-JJJJMMTT-HHMMSS.mp4` heruntergeladen (das Präfix wechselt mit der Website, z. B. `YouTube-20240908-153000.mp4`, `Bilibili-20240908-153000.mp4`; bei Rückfall `.webm`).
5. **Tastenkürzel**: Auf einer Videoseite einer unterstützten Website die Standardtaste `R` drücken, um zu starten; erneut drücken, um zu stoppen und zu speichern.
   - Über **Einstellungen** oben rechts im Popup änderbar: Auf das Tastenfeld klicken und die neue Kombination drücken, `Esc` bricht ab. Änderungen wirken sofort, kein Neuladen nötig.
   - Das Kürzel greift nur, wenn eine unterstützte Videoseite den Fokus hat, und nie in Eingabefeldern wie Suche oder Kommentaren. Konflikte mit Browser- oder Player-Kürzeln der Website werden im Einstellungsbereich gemeldet.
6. **Bildfeinabstimmung** (einklappbarer Bereich unten im Popup): In seltenen Umgebungen (ungewöhnliche Zoom-Kombinationen, gemischte DPI-Monitore) kann ein fester Versatz bleiben — hier vertikale / horizontale Pixelwerte eintragen (positiv = nach unten / rechts).
7. **Die Seite wird während der Aufnahme durch eine Maske gesperrt** (Modus „Ganzer Player"):
   - Außerhalb des Bildes liegt halbtransparentes Schwarz: Buttons und Links sind nicht anklickbar, Mausrad- und Touch-Scrollen werden blockiert, die Scrollposition ist fixiert.
   - **Erlaubt**: Wiedergabe/Pause, Suchen, Lautstärke, Untertitel, Wiedergabegeschwindigkeit — alles reine Wiedergabesteuerung.
   - **Blockiert**: Scroll-/Blättertasten (Leertaste, Bild Auf/Ab, Pos1/Ende, Pfeil Hoch/Runter), Vollbild `f`, Kinomodus `t`, Miniplayer `i`, Stumm `m` und Doppelklick aufs Bild — diese ändern das Layout oder machen die Tonspur stumm.
   - Die Maske lässt das Bild ausgespart und überdeckt damit nichts Aufgezeichnetes — sie erscheint folglich **nie in der Ausgabe**; unter dem Bild (bei wenig Platz darüber) wird „Aufnahme läuft · Seite gesperrt" angezeigt.
   - Das Ändern der Fenstergröße kann eine Webseite nicht verhindern: Wird eine Änderung des Viewports erkannt, erscheint eine Warnung auf der Maske und das Popup empfiehlt eine neue Aufnahme (der Zuschnitt kann verschoben sein).
8. Nach dem Stoppen wird die Maske automatisch entfernt und die Seite ist wieder normal — ohne zurückbleibende Knoten oder Listener.

### Ausgabeformate

| Umgebung | Ausgabe |
| --- | --- |
| Chrome ≥ 126 mit H.264/AAC-Encodern (z. B. aktuelles Chrome unter Windows/macOS) | **MP4** (H.264 + AAC, `.mp4`) |
| Chrome < 126 | WebM (`.webm`) — das Popup nennt den Grund |
| Chrome ≥ 126, aber Plattform ohne Encoder (manche Linux-Builds) | WebM (`.webm`) — das Popup nennt den Grund |

> Es findet keinerlei Umkodierung statt: Wenn MP4 möglich ist, wird es von `MediaRecorder` nativ aufgenommen (ohne Wartezeit, ohne Qualitätsverlust); andernfalls wird auf WebM zurückgefallen.

### Berechtigungen

| Berechtigung | Zweck |
| --- | --- |
| `tabCapture` | Eingeschränkte Berechtigung; erfasst Bild und Ton des aktuellen Tabs nach einem Nutzerklick |
| `downloads` | Speichert die Aufnahme im lokalen Download-Ordner |
| `activeTab` | Temporärer Zugriff auf den aktuellen Tab beim Klick auf das Symbol |
| `offscreen` | Erstellt das Offscreen-Dokument für Erfassung / Zuschnitt / Aufnahme |
| `storage` | `session` hält Aufnahmestatus und Startabsicht; `sync` hält Tastenkürzel, Feinabstimmung und Schalter der Vollbild-Statusanzeige |
| `notifications` | Anzeige der Vollbildaufnahme: dauerhafte Benachrichtigung „Aufnahme läuft" (mit Stopp-Button) + einmalige Erfolgs-/Fehlerquittung beim Speichern (in den Einstellungen abschaltbar) |

Keine `host_permissions`, keine Netzwerkzugriffe, keine Erfassung von Nutzerdaten; das Content Script wird nur unter den in `content_scripts.matches` gelisteten Domains der sieben unterstützten Websites injiziert und wirksam — andere Websites erhalten weder Injektion noch irgendeine Aktion.

## Statische Selbstprüfung

```bash
python3 scripts/verify_extension.py
```

Abgedeckt: Manifest / MV3 / benötigte Dateien, Domain-Beschränkung und Injektionsreihenfolge der unterstützten Websites (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok) (`shared/hotkey.js` → `shared/indicator.js` → `shared/sites.js` → `content/guard.js` → `content/pip.js` → `content/selector.js` → `content/countdown.js` → `content/content.js` → `content/hotkey.js`), minimale Berechtigungen, keine Drittanbieter-Abhängigkeiten, JS-Syntax aller Dateien (`node --check`), API-Kontextgrenzen (Content Scripts dürfen `tabCapture` / `downloads` / `offscreen` nicht direkt aufrufen), Injektionsgrenzen (Bedienelemente müssen im Popup liegen; `content/guard.js` ist das einzige Modul, das DOM erzeugen darf, und muss ein Loch für das Bild aussparen, dieses Loch leer lassen und pro Sitzung entfernbar sein) sowie Grenzen des Kürzel-Moduls.

## Manuelle Abnahmeliste (Aufgabe 20 in `TODO.md`)

Nach dem Laden und Benutzen wie oben beschrieben jeden Punkt prüfen. **Mehr-Website-Teil**: Führen Sie zusätzlich zu YouTube den vollständigen Ablauf „Start → Stoppen und speichern" auf mindestens zwei weiteren neu unterstützten Websites (z. B. Bilibili, TikTok) aus und bestätigen Sie, dass Popup / Benachrichtigungen den richtigen Websitenamen zeigen, die Ausgabedatei das passende Präfix trägt (z. B. `Bilibili-*.mp4`) und das Bild nur den Playerbereich dieser Website ohne Versatz enthält. „Videoseite" in den folgenden Punkten bezeichnet stets eine Videoseite einer unterstützten Website:

- [ ] 20.1 Das Popup öffnet korrekt: Status / Timer / Schaltflächen wechseln passend zur Phase; während der Aufnahme zeigt das Symbol ein rotes `REC`-Badge.
- [ ] 20.2 **Aufnahme starten** → Erfassung erfolgreich (Status „Aufnahme läuft" + laufender Timer) → **Stoppen und speichern** → eine mp4-Datei wird heruntergeladen (ohne natives MP4 warnt das Popup und es wird eine webm heruntergeladen).
- [ ] 20.3 Ausgabe mit Systemplayer / Chrome öffnen: Bild ist der zugeschnittene Player-Bereich, Ton vorhanden, Wiedergabe OK.
- [ ] 20.4 Auf HiDPI-Displays (DPR ≠ 1, z. B. Retina) kein Versatz.
- [ ] 20.5 Tab-Wechsel während der Aufnahme: Popup warnt vor möglichem Abbruch; Rückkehr setzt fort oder stoppt und exportiert automatisch, ohne Fehler.
- [ ] 20.6 Vollbildwechsel / Browser-Zoom während der Aufnahme: Der Zuschnittsbereich folgt korrekt.
- [ ] 20.7 Fehlerfälle melden korrekt: keine Videoseite (Start-Button deaktiviert), DRM-Video (Hinweis nach ~2,6 s), Erfassung verweigert usw.
- [ ] 20.8 Nach dem Ende (auch bei Fehlern): kein roter Aufnahmepunkt in der Adressleiste, keine zurückbleibenden Erweiterungsknoten, keine Dauerfehler.
- [ ] 20.9 Bei Chrome < 126 oder fehlenden H.264/AAC-Encodern: Popup meldet „kein natives MP4, Ausgabe als WebM", Aufnahme funktioniert trotzdem.
- [ ] 20.10 Die Ausgabe enthält keine Erweiterungs-Bedienelemente (keine Buttons / Dialoge / Toasts).
- [ ] 20.11 Die Ausgabe enthält keine Sperrmaske (keine dunklen Ränder, keine Hinweistexte).
- [ ] 20.12 Während der Aufnahme ist die Seite gesperrt: Buttons / Links nicht klickbar, Mausrad und Kürzel wirkungslos, kein Scrollen; Wiedergabe/Pause, Suchen und Lautstärke funktionieren jedoch.
- [ ] 20.13 Fenstergröße während der Aufnahme ändern: Maske warnt, Popup wird benachrichtigt, und die Maske schneidet das Loch neu, ohne das Bild zu überdecken.
- [ ] 20.14 Nach dem Speichern verschwindet die Maske, die Seite ist wieder bedienbar, keine `yr-guard-`-Knoten übrig.
- [ ] 20.15 Bereich aufnehmen: Auswahl aufziehen → **Auswahl aufnehmen** → die Ausgabe enthält nur den gewählten Bereich und keine Schaltflächen wie Start / Stopp.
- [ ] 20.16 Aufnahme im Vollbild per Tastenkürzel starten: Das immer im Vordergrund liegende Document-PiP-Fenster erscheint und zählt hoch, sein **Stoppen und speichern**-Button funktioniert, und das Fenster erscheint nicht in der Ausgabe.
- [ ] 20.17 Vollbild-Aufnahme eines Quellmaterials mit schwarzen Balken (z. B. 21:9 / vertikal): In den Balken erscheint ein feiner roter Rahmen, und das fertige Bild enthält keinen roten Rahmen; randloses Vollbildmaterial hat automatisch keinen roten Rahmen.
- [ ] 20.18 Während der Aufnahme bleibt eine Systembenachrichtigung bestehen und kann die Aufnahme per Button stoppen; nach dem Speichern erscheint eine einmalige Ergebnisbenachrichtigung; danach verschwinden Benachrichtigung und PiP-Fenster automatisch.
- [ ] 20.19 Alle drei Elemente der **Statusanzeige der Vollbildaufnahme** in den Einstellungen ausschalten: kein PiP / keine Benachrichtigung / kein roter Rahmen, und die übrigen Aufnahmefunktionen sind nicht betroffen.

Wenn alles geprüft ist, die Punkte der Aufgabe 20 in `TODO.md` abhaken.
