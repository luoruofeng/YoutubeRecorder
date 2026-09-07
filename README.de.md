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

Chrome-Manifest-V3-Erweiterung: Auf einer YouTube-Wiedergabeseite wird die Aufnahme per **manuellem Klick** gestartet. Sie erfasst die vollständige Oberfläche des Tabs samt Seitenton, schneidet im Browser mit Canvas Bild für Bild **den Player-Bereich (oder einen frei aufgezogenen Bereich)** aus und speichert schließlich eine **Videodatei mit Ton** lokal — bevorzugt nativ **MP4 (H.264/AAC)**, mit automatischem Rückfall auf **WebM**, wenn Browser oder System es nicht unterstützen.

## Funktionen

- **Keine Drittanbieter-Abhängigkeiten**: kein npm, kein Build-Schritt, kein ffmpeg, keinerlei Umkodierung (MP4 wird nativ von `MediaRecorder` aufgenommen, nie nachträglich konvertiert).
- **Zwei Aufnahmemodi**
  - **Ganzer Player**: Ermittelt automatisch das *tatsächlich gezeichnete* Rechteck des Players (berechnet aus `object-fit` / `object-position`) und schließt schwarze Balken, Randbereiche des Kinomodus und das Player-Chrome aus.
  - **Bereich auswählen**: Ein Rechteck beliebig auf der Seite aufziehen und nur diesen Bereich aufnehmen.
- **Garantiert sauberes Bild**: Alle Bedienelemente liegen im Popup des Erweiterungssymbols (eine eigenständige Erweiterungsseite, die nicht zum Rendervorgang des erfassten Tabs gehört) — keine Erweiterungs-UI kann im Video auftauchen.
- **Seiten-Tastenkürzel**: Standardmäßig startet die einzelne Taste `R` die Aufnahme im Leerlauf und stoppt/speichert sie während der Aufnahme. Frei änderbar im Popup unter **Einstellungen** (Kombinationen mit `Ctrl` / `Alt` / `Shift` / `Command`). Es wirkt nur auf YouTube-Seiten, entwendet keine Tasten anderer Tabs und kollidiert nie mit globalen Browser-Shortcuts.
- **Seite während der Aufnahme gesperrt**: Eine halbtransparente Maske deckt alles *außerhalb* des Bildes ab (mit ausgespartem „Loch" für das Bild) und blockiert Scrollen, Klicks und destruktive Tastenkürzel — während **Wiedergabe/Pause, Suchen, Lautstärke, Untertitel und Wiedergabegeschwindigkeit voll nutzbar bleiben**.
- **Stabiler Zuschnitt**: Feste 30 fps; die Canvas-Größe wird mit dem ersten Bild fixiert; das Zuschnitt-Rechteck muss 3 Bilder in Folge stabil bleiben, bevor die Aufnahme startet, damit keine kurzzeitig zu großen Rechtecke (Werbung, Wechsel in den Kinomodus) im fertigen Video landen.
- **Kein Tonverlust**: Die erfasste Tonspur wird über einen `AudioContext` wiedergegeben, damit der Tab nicht stummgeschaltet wird und kein tonloses Video entsteht.
- **Umfassende Ausfallsicherung**: DRM-Schwarzbild-Erkennung, automatisches Stoppen und Exportieren beim Tab-Wechsel oder Navigieren, Selbstheilung bei stockendem Rechteck-Heartbeat, automatischer Download-Wiederholversuch sowie „Zurücksetzen und neu starten" für hängende Sitzungen.
- **Aufnahme ausschließlich durch einen Nutzerklick ausgelöst** — niemals stille Aufzeichnung im Hintergrund.

## Projektstruktur

```
DESIGN.md                    Technisches Designdokument (Fähigkeiten / Architektur / Nachrichtenprotokoll / Grenzfälle / Datenfluss)
TODO.md                      Aufgabenliste (bei Abnahme abhaken)
src/
├── manifest.json            MV3-Manifest (tabCapture + downloads + activeTab + offscreen + storage)
├── background.js            Service Worker: Offscreen-Lebenszyklus, Nachrichten-Routing, globaler Status und Badge, Download-Proxy
├── offscreen.html           Host des Offscreen-Dokuments
├── offscreen.js             Aufnahmekern: getUserMedia(Tab-Stream) → verstecktes video → Canvas-Zuschnitt → MediaRecorder → Blob
├── shared/
│   └── hotkey.js            Gemeinsame Definition des Kürzels „Aufnahme starten / stoppen" (Popup-Einstellungen, Hinweis, Content-Listener)
├── content/
│   ├── guard.js             Seitensperr-Maske während der Aufnahme (Loch passend zum Bild; existiert nur während einer Sitzung)
│   ├── selector.js          Auswahl-Overlay für den Bereich (nach Klick auf „Bereich aufnehmen" aktiviert)
│   ├── content.js           Skript ohne Oberfläche: Player-Rechteck-Heartbeat + Meldungen bei Ausblenden/Navigation + Maske ein/aus
│   └── hotkey.js            Listener für das seitenweite Kürzel „Aufnahme starten / stoppen"
├── popup.html               Popup des Erweiterungssymbols: Aufnahmekonsole (Start / Bereich / Stopp / Status / Timer / Hinweise / Einstellungen)
├── popup.js
├── popup/
│   └── settings.js          Einstellungsdialog (Kürzel aktivieren, Taste erfassen, Konflikthinweise)
├── assets/                  Statische Ressourcen
├── icons/                   16/32/48/128 Icons
└── types/                   chrome.*-API-Typdeklarationen (nur Typen)
scripts/verify_extension.py  Statisches Selbstprüfskript
```

## Warum ein Offscreen-Dokument?

`chrome.tabCapture` kann nicht aus einem Content Script aufgerufen werden, während die Pipeline aus `video` / `canvas` / `MediaRecorder` einen Fensterkontext mit DOM benötigt. Ein Popup schließt sich, sobald es den Fokus verliert, und ein Service Worker hat gar kein DOM — daher liegt der Aufnahmekern in einem **Offscreen-Dokument**:

1. Das **Content Script** (es injiziert selbst keine UI, sondern meldet nur Daten) lokalisiert den Player etwa alle 120 ms und meldet das tatsächliche Bildrechteck sowie die Viewport-Basis (CSS-Größe, `devicePixelRatio`, Visual-Viewport-Versatz).
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

1. Eine beliebige **YouTube-Wiedergabeseite** öffnen (öffentliche Videos; DRM- oder Mitglieder-Videos werden schwarz aufgezeichnet — eine Schutzbeschränkung des Browsers).
2. Auf das Erweiterungssymbol klicken → im Popup **Aufnahme starten** klicken (Tab sichtbar halten, Player vollständig im Viewport).
   - Wenn Browser/System kein natives MP4 erzeugen kann (Chrome < 126 oder fehlende H.264/AAC-Encoder), erklärt das Popup den Rückfall auf WebM.
   - Während der Aufnahme zeigt das Symbol ein rotes `REC`-Badge. Das Schließen des Popups beendet die Aufnahme nicht — einfach erneut auf das Symbol klicken.
3. **Bereich aufnehmen** (optional): **Bereich aufnehmen** klicken → das Popup schließt sich → ein Rechteck auf der Seite aufziehen → **Auswahl aufnehmen** klicken (`Esc` verlässt die Auswahl).
   - Während der Aufnahme wird die Schaltfläche **Stopp** automatisch *außerhalb* der Auswahl platziert, damit sie nie ins Video gerät. Füllt die Auswahl fast den gesamten Viewport und ist kein Platz mehr, werden die Bedienelemente auf der Seite ausgeblendet — dann über das Popup oder das Tastenkürzel stoppen.
4. Zum Beenden **Stoppen und speichern** klicken → die Datei wird zusammengesetzt und als `YouTube-JJJJMMTT-HHMMSS.mp4` (bei Rückfall `.webm`) heruntergeladen.
5. **Tastenkürzel**: Auf einer YouTube-Seite die Standardtaste `R` drücken, um zu starten; erneut drücken, um zu stoppen und zu speichern.
   - Über **Einstellungen** oben rechts im Popup änderbar: Auf das Tastenfeld klicken und die neue Kombination drücken, `Esc` bricht ab. Änderungen wirken sofort, kein Neuladen nötig.
   - Das Kürzel greift nur, wenn eine YouTube-Seite den Fokus hat, und nie in Eingabefeldern wie Suche oder Kommentaren. Konflikte mit Browser- oder YouTube-Player-Kürzeln werden im Einstellungsbereich gemeldet.
6. **Bildfeinabstimmung** (einklappbarer Bereich unten im Popup): In seltenen Umgebungen (ungewöhnliche Zoom-Kombinationen, gemischte DPI-Monitore) kann ein fester Versatz bleiben — hier vertikale / horizontale Pixelwerte eintragen (positiv = nach unten / rechts).
7. **Die Seite wird während der Aufnahme durch eine Maske gesperrt** (Modus „Ganzer Player"):
   - Außerhalb des Bildes liegt halbtransparendes Schwarz: Buttons und Links sind nicht anklickbar, Mausrad- und Touch-Scrollen werden blockiert, die Scrollposition ist fixiert.
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
| `storage` | `session` hält Aufnahmestatus und Startabsicht; `sync` hält Tastenkürzel und Bildfeinabstimmung |

Keine `host_permissions`, keine Netzwerkzugriffe, keine Erfassung von Nutzerdaten.

## Statische Selbstprüfung

```bash
python3 scripts/verify_extension.py
```

Abgedeckt: Manifest / MV3 / benötigte Dateien, YouTube-only-Matchmuster und Injektionsreihenfolge, minimale Berechtigungen, keine Drittanbieter-Abhängigkeiten, JS-Syntax aller Dateien (`node --check`), API-Kontextgrenzen (Content Scripts dürfen `tabCapture` / `downloads` / `offscreen` nicht direkt aufrufen), Injektionsgrenzen (Bedienelemente müssen im Popup liegen; `content/guard.js` ist das einzige Modul, das DOM erzeugen darf, und muss ein Loch für das Bild aussparen, dieses Loch leer lassen und pro Sitzung entfernbar sein) sowie Grenzen des Kürzel-Moduls.

## Manuelle Abnahmeliste (Aufgabe 20 in `TODO.md`)

Nach dem Laden und Benutzen wie oben beschrieben jeden Punkt prüfen:

- [ ] 20.1 Das Popup öffnet korrekt: Status / Timer / Schaltflächen wechseln passend zur Phase; während der Aufnahme zeigt das Symbol ein rotes `REC`-Badge.
- [ ] 20.2 **Aufnahme starten** → Erfassung erfolgreich (Status „Aufnahme läuft" + laufender Timer) → **Stoppen und speichern** → eine mp4-Datei wird heruntergeladen (ohne natives MP4 warnt das Popup und es wird eine webm heruntergeladen).
- [ ] 20.3 Ausgabe mit Systemplayer / Chrome öffnen: Bild ist der zugeschnittene Player-Bereich, Ton vorhanden, Wiedergabe OK.
- [ ] 20.4 Auf HiDPI-Displays (DPR ≠ 1, z. B. Retina) kein Versatz.
- [ ] 20.5 Tab-Wechsel während der Aufnahme: Popup warnt vor möglichem Abbruch; Rückkehr setzt fort oder stoppt und exportiert automatisch, ohne Fehler.
- [ ] 20.6 Vollbildwechsel / Browser-Zoom während der Aufnahme: Der Zuschnittsbereich folgt korrekt.
- [ ] 20.7 Fehlerfälle melden korrekt: keine Wiedergabeseite (Start-Button deaktiviert), DRM-Video (Hinweis nach ~2,6 s), Erfassung verweigert usw.
- [ ] 20.8 Nach dem Ende (auch bei Fehlern): kein roter Aufnahmepunkt in der Adressleiste, keine zurückbleibenden Erweiterungsknoten, keine Dauerfehler.
- [ ] 20.9 Bei Chrome < 126 oder fehlenden H.264/AAC-Encodern: Popup meldet „kein natives MP4, Ausgabe als WebM", Aufnahme funktioniert trotzdem.
- [ ] 20.10 Die Ausgabe enthält keine Erweiterungs-Bedienelemente (keine Buttons / Dialoge / Toasts).
- [ ] 20.11 Die Ausgabe enthält keine Sperrmaske (keine dunklen Ränder, keine Hinweistexte).
- [ ] 20.12 Während der Aufnahme ist die Seite gesperrt: Buttons / Links nicht klickbar, Mausrad und Kürzel wirkungslos, kein Scrollen; Wiedergabe/Pause, Suchen und Lautstärke funktionieren jedoch.
- [ ] 20.13 Fenstergröße während der Aufnahme ändern: Maske warnt, Popup wird benachrichtigt, und die Maske schneidet das Loch neu, ohne das Bild zu überdecken.
- [ ] 20.14 Nach dem Speichern verschwindet die Maske, die Seite ist wieder bedienbar, keine `yr-guard-`-Knoten übrig.
- [ ] 20.15 Bereich aufnehmen: Auswahl aufziehen → **Auswahl aufnehmen** → die Ausgabe enthält nur den gewählten Bereich und keine Schaltflächen wie Start / Stopp.

Wenn alles geprüft ist, die Punkte der Aufgabe 20 in `TODO.md` abhaken.
