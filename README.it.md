# YouTube Recorder

<div align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.ko.md">한국어</a> ·
  <b>Italiano</b>
</div>

Estensione Chrome Manifest V3: su una pagina di riproduzione di YouTube, un **clic manuale** avvia la registrazione. Cattura l'intera superficie della scheda insieme all'audio della pagina, ritaglia fotogramma per fotogramma con Canvas **l'area del player (o qualsiasi regione selezionata trascinando)** e infine esporta un **file video con audio** nella cartella dei download — privilegia in modo nativo **MP4 (H.264/AAC)** e ripiega automaticamente su **WebM** quando il browser o il sistema non la supportano.

## Caratteristiche

- **Zero dipendenze di terze parti**: nessun npm, nessun passaggio di build, nessun ffmpeg, nessuna ricodifica (l'MP4 è registrato nativamente da `MediaRecorder`, mai convertito a posteriori).
- **Due modalità di registrazione**
  - **Player intero**: individua automaticamente il rettangolo *effettivamente disegnato* del player (calcolato da `object-fit` / `object-position`), escludendo bande nere, margini della modalità cinema e il chrome del player.
  - **Selezione area**: traccia un rettangolo in un punto qualsiasi della pagina e registra solo quell'area.
- **Immagine sempre pulita**: tutti i controlli si trovano nel popup dell'icona dell'estensione (una pagina di estensione indipendente che non fa parte del rendering della scheda catturata), quindi nessuna interfaccia dell'estensione può comparire nel video.
- **Scorciatoia di pagina**: il tasto singolo predefinito `R` avvia la registrazione quando è inattivo e la arresta/salva durante la registrazione. Modificabile liberamente nel popup → **Impostazioni** (combinazioni con `Ctrl` / `Alt` / `Shift` / `Command`). Agisce solo sulle pagine di YouTube, non sottrae tasti ad altre schede e non entra in conflitto con le scorciatoie globali del browser.
- **Pagina bloccata durante la registrazione**: una maschera traslucida copre tutto ciò che si trova *fuori* dall'immagine, con un «foro» ritagliato per essa, bloccando scorrimento, clic e scorciatoie distruttive, mentre **riproduzione/pausa, avanzamento, volume, sottotitoli e velocità di riproduzione restano pienamente utilizzabili**.
- **Ritaglio stabile**: uscita fissa a 30 fps; la dimensione del canvas viene bloccata al primo fotogramma; il rettangolo di ritaglio deve restare stabile per 3 fotogrammi consecutivi prima dell'avvio, così nessun rettangolo transitorio troppo grande (pubblicità, passaggio alla modalità cinema) finisce nel video.
- **Audio mai perso**: la traccia audio catturata viene riprodotta tramite un `AudioContext`, evitando che la scheda venga silenziata e produca un video muto.
- **Ripiegamenti robusti**: rilevamento del fotogramma nero DRM, arresto ed esportazione automatici al cambio di scheda o alla navigazione, autoriparazione quando l'heartbeat del rettangolo si interrompe, ritentativo automatico del download e uscita di emergenza «Ripristina forzatamente e ricomincia».
- **La registrazione viene avviata solo da un clic dell'utente** — mai una cattura silenziosa in background.

## Struttura del progetto

```
DESIGN.md                    Documento di design tecnico (capacità / architettura / protocollo messaggi / casi limite / flusso dati)
TODO.md                      Elenco delle attività di sviluppo (da spuntare in fase di collaudo)
src/
├── manifest.json            Manifesto MV3 (tabCapture + downloads + activeTab + offscreen + storage)
├── background.js            Service Worker: ciclo di vita dell'offscreen, instradamento messaggi, stato globale e badge, proxy di download
├── offscreen.html           Host del documento offscreen
├── offscreen.js             Cuore della registrazione: getUserMedia(stream della scheda) → video nascosto → ritaglio canvas → MediaRecorder → Blob
├── shared/
│   └── hotkey.js            Definizione condivisa della scorciatoia «avvia / arresta registrazione» (impostazioni popup, suggerimento, listener content)
├── content/
│   ├── guard.js             Maschera di blocco della pagina durante la registrazione (foro ritagliato sull'immagine; esiste solo durante una sessione)
│   ├── selector.js          Overlay di selezione area (attivato su richiesta dopo il clic su «Registra area»)
│   ├── content.js           Script senza interfaccia: heartbeat del rettangolo del player + notifiche di occultamento/navigazione + attivazione maschera
│   └── hotkey.js            Listener della scorciatoia «avvia / arresta registrazione» a livello di pagina
├── popup.html               Popup dell'icona: console di registrazione (avvia / area / arresta / stato / timer / suggerimenti / impostazioni)
├── popup.js
├── popup/
│   └── settings.js          Modale delle impostazioni (attivazione scorciatoia, cattura del tasto, avvisi di conflitto)
├── assets/                  Risorse statiche
├── icons/                   Icone 16/32/48/128
└── types/                   Dichiarazioni di tipi delle API chrome.* (solo tipi)
scripts/verify_extension.py  Script di autoverifica statica
```

## Perché serve un documento offscreen?

`chrome.tabCapture` non può essere richiamato da un content script, mentre la pipeline `video` / `canvas` / `MediaRecorder` richiede un contesto di finestra con DOM. Un popup si chiude non appena perde il fuoco e un Service Worker non ha DOM: per questo il cuore della registrazione risiede in un **documento offscreen**.

1. Il **content script** (non inietta alcuna interfaccia, si limita a segnalare dati) individua il player ogni ~120 ms e comunica il rettangolo reale dell'immagine insieme alla base del viewport (dimensione CSS, `devicePixelRatio`, offset del visual viewport).
2. **background** crea il documento offscreen su richiesta e chiama `chrome.tabCapture.getMediaStreamId()` all'interno della catena del gesto utente per ottenere uno `streamId`.
3. Il documento **offscreen** consuma l'intero stream della scheda tramite `getUserMedia({ chromeMediaSourceId: streamId })` (video + audio della pagina).
4. All'interno dell'**offscreen**: un `video` nascosto riproduce lo stream della scheda → un `canvas` nascosto ritaglia fotogramma per fotogramma con `drawImage` → la traccia video di `canvas.captureStream(30)` viene unita all'`audioTrack` originale → `MediaRecorder` registra (`video/mp4` per primo, con ripiego progressivo su `video/webm`) → i frammenti vengono assemblati in un Blob.
   - La conversione delle coordinate usa un **rapporto misurato** («dimensione del fotogramma catturato ÷ dimensione CSS del viewport», modello contain con padding centrato) invece di un ingenuo `rect × devicePixelRatio`, eliminando così gli spostamenti su schermi HiDPI e con zoom.
5. Il documento offscreen **non può** chiamare direttamente `chrome.downloads`: invia `DOWNLOAD_FILE` a **background**, che esegue il download e comunica il risultato tramite `downloads.onChanged`.

Per i dettagli vedi `DESIGN.md`.

## Caricamento (sviluppo)

1. Apri Chrome e vai su `chrome://extensions`.
2. Attiva la **Modalità sviluppatore** in alto a destra.
3. Clicca su **Carica estensione non pacchettizzata** e seleziona la cartella `src/` di questo repository (nessun passaggio di build, nulla da compilare).

> Requisiti: Chrome ≥ 116 (`minimum_chrome_version`, necessario per `chrome.offscreen`); l'uscita MP4 nativa richiede Chrome ≥ 126. Si consiglia l'ultima versione stabile.

## Utilizzo

1. Apri una qualsiasi **pagina di riproduzione di YouTube** (video pubblici; i video DRM o riservati ai membri vengono registrati come fotogramma nero — limitazione di protezione del browser).
2. Clicca sull'icona dell'estensione → clicca su **Avvia registrazione** nel popup (mantieni la scheda visibile e il player interamente nel viewport).
   - Se il browser o il sistema non possono produrre MP4 nativo (Chrome < 126 o assenza di codificatori H.264/AAC), il popup indica che la sessione userà WebM.
   - Durante la registrazione l'icona mostra un badge rosso `REC`. Chiudere il popup non interrompe la registrazione: basta cliccare di nuovo sull'icona.
3. **Registra area** (opzionale): clicca su **Registra area** → il popup si chiude → traccia un rettangolo sulla pagina → clicca su **Registra selezione** (`Esc` esce dal selettore).
   - Durante la registrazione il pulsante **Arresta** viene posizionato automaticamente *fuori* dalla selezione, così non finisce mai nel video. Se la selezione occupa quasi tutto il viewport e non c'è spazio, i controlli nella pagina vengono nascosti: arresta dal popup o con la scorciatoia.
4. Al termine clicca su **Arresta e salva** → il file viene assemblato e scaricato come `YouTube-AAAAMMGG-HHMMSS.mp4` (`.webm` negli ambienti con ripiego).
5. **Scorciatoia**: premi il tasto predefinito `R` su una pagina di YouTube per avviare; premilo di nuovo per arrestare e salvare.
   - Clicca su **Impostazioni** in alto a destra nel popup per modificarla: clicca sulla casella del tasto e premi la nuova combinazione, `Esc` annulla. Le modifiche sono immediate, senza ricaricare la pagina.
   - La scorciatoia scatta solo quando una pagina di YouTube ha il fuoco e mai nei campi di input come la ricerca o i commenti. Gli eventuali conflitti con le scorciatoie del browser o del player sono segnalati nel pannello delle impostazioni.
6. **Regolazione fine dell'immagine** (sezione comprimibile in fondo al popup): in configurazioni particolari (combinazioni di zoom anomale, monitor con DPI misti) può restare un piccolo scostamento fisso — inserisci valori in pixel verticali / orizzontali (positivo = giù / destra).
7. **La pagina viene bloccata da una maschera durante la registrazione** (modalità player intero):
   - Tutto ciò che è fuori dall'immagine è coperto da nero traslucido: pulsanti e link non sono cliccabili, la rotella e lo scorrimento touch sono bloccati e la posizione di scorrimento è fissata.
   - **Consentito**: riproduzione/pausa, avanzamento, volume, sottotitoli e velocità di riproduzione — tutto ciò che è puro controllo di riproduzione.
   - **Bloccato**: tasti di scorrimento (Spazio, Pag Su/Giù, Home/Fine, frecce Su/Giù), schermo intero `f`, modalità cinema `t`, mini player `i`, muto `m` e doppio clic sull'immagine — azioni che modificano il layout o azzerano la traccia audio.
   - La maschera ha un foro per l'immagine, quindi non copre nulla di ciò che viene registrato e **non compare mai nell'output**; sotto l'immagine (sopra, se lo spazio manca) viene mostrata la scritta «Registrazione in corso · pagina bloccata».
   - Il ridimensionamento della finestra del browser non può essere impedito da una pagina web: quando viene rilevata una variazione del viewport, la maschera mostra un avviso e il popup consiglia di registrare di nuovo (il ritaglio potrebbe essersi spostato).
8. Dopo l'arresto la maschera viene rimossa automaticamente e la pagina torna normale, senza nodi o listener residui.

### Formati di output

| Ambiente | Output |
| --- | --- |
| Chrome ≥ 126 con codificatori H.264/AAC (es. Chrome recente su Windows / macOS) | **MP4** (H.264 + AAC, `.mp4`) |
| Chrome < 126 | WebM (`.webm`) — il popup spiega il motivo |
| Chrome ≥ 126 ma piattaforma priva di codificatori (alcune build Linux) | WebM (`.webm`) — il popup spiega il motivo |

> Non viene eseguita alcuna ricodifica: quando l'MP4 è disponibile viene registrato nativamente da `MediaRecorder` (senza attese e senza perdita di qualità); altrimenti si ripiega su WebM.

### Permessi

| Permesso | Uso |
| --- | --- |
| `tabCapture` | Permesso limitato; cattura immagine e audio della scheda corrente dopo un clic dell'utente |
| `downloads` | Salva la registrazione nella cartella dei download locale |
| `activeTab` | Accesso temporaneo alla scheda corrente concesso al clic sull'icona |
| `offscreen` | Crea il documento offscreen che ospita cattura / ritaglio / registrazione |
| `storage` | `session` conserva lo stato della registrazione e l'intento di avvio; `sync` conserva la scorciatoia e la regolazione dell'immagine |

Nessuna `host_permissions`, nessuna richiesta di rete, nessuna raccolta di dati dell'utente.

## Autoverifica statica

```bash
python3 scripts/verify_extension.py
```

Copre: manifesto / MV3 / file obbligatori, pattern limitati a YouTube e ordine di iniezione, permessi minimi, assenza di dipendenze di terze parti, sintassi JS di tutti i file (`node --check`), confini di contesto delle API (i content script non devono chiamare direttamente `tabCapture` / `downloads` / `offscreen`), confini di iniezione nella pagina (i controlli devono stare nel popup; `content/guard.js` è l'unico modulo autorizzato a creare DOM e deve ritagliare un foro per l'immagine, lasciarlo vuoto e poter essere rimosso a ogni sessione) e confini del modulo delle scorciatoie.

## Lista di collaudo manuale (attività 20 in `TODO.md`)

Dopo aver caricato e usato l'estensione come descritto sopra, verifica ogni punto:

- [ ] 20.1 Il popup si apre correttamente: stato / timer / pulsanti cambiano con la fase; l'icona mostra un badge rosso `REC` durante la registrazione.
- [ ] 20.2 Clic su **Avvia registrazione** → cattura riuscita (stato «Registrazione in corso» + timer attivo) → clic su **Arresta e salva** → viene scaricato un mp4 (senza MP4 nativo il popup avvisa e viene scaricato un webm).
- [ ] 20.3 Apri l'output con un player di sistema o con Chrome: l'immagine è l'area del player ritagliata, l'audio è presente e la riproduzione funziona.
- [ ] 20.4 Su schermi HiDPI (DPR ≠ 1, es. Retina) l'immagine non risulta spostata o disallineata.
- [ ] 20.5 Cambiare scheda durante la registrazione: il popup avvisa che la cattura potrebbe interrompersi; al ritorno la registrazione continua oppure si arresta ed esporta automaticamente, senza errori.
- [ ] 20.6 Passaggio a schermo intero o zoom del browser durante la registrazione: l'area di ritaglio segue correttamente.
- [ ] 20.7 I casi di errore sono segnalati correttamente: pagina non di riproduzione (pulsante di avvio disabilitato), video DRM (avviso dopo ~2,6 s), cattura negata, ecc.
- [ ] 20.8 Dopo la fine (compresi gli errori): nessun punto rosso di registrazione nella barra degli indirizzi, nessun nodo dell'estensione residuo, nessun errore ripetuto.
- [ ] 20.9 Con Chrome < 126 o piattaforma priva di H.264/AAC: il popup indica «MP4 nativo non supportato, verrà prodotto WebM» e la registrazione funziona comunque.
- [ ] 20.10 L'output non contiene controlli dell'estensione (né pulsanti, né modali, né toast).
- [ ] 20.11 L'output non contiene la maschera di blocco (né bordi scuri, né testi informativi).
- [ ] 20.12 Durante la registrazione la pagina è bloccata: pulsanti e link non sono cliccabili, rotella e scorciatoie non hanno effetto e la pagina non scorre; ma riproduzione/pausa, avanzamento e volume funzionano.
- [ ] 20.13 Ridimensionare la finestra durante la registrazione: la maschera avvisa, il popup riceve la notifica e la maschera ritaglia di nuovo il foro senza coprire l'immagine.
- [ ] 20.14 Dopo l'arresto e il salvataggio la maschera scompare, la pagina torna interattiva e non restano nodi `yr-guard-`.
- [ ] 20.15 Registra area: traccia una selezione → **Registra selezione** → l'output contiene solo l'area scelta e nessun pulsante nella pagina come Avvia / Arresta.

Quando tutto è verificato, spunta le voci dell'attività 20 in `TODO.md`.
