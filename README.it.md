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

Estensione Chrome Manifest V3: sulla pagina video di un sito supportato — **YouTube, Bilibili, Dailymotion, Vimeo, Instagram, Facebook, TikTok** — un **clic manuale** avvia la registrazione. Cattura l'intera superficie della scheda corrente insieme all'audio della pagina, ritaglia fotogramma per fotogramma con Canvas **l'area immagine realmente dipinta del player (o qualsiasi regione selezionata trascinando)** e infine esporta un **file video con audio** scaricato localmente — privilegia in modo nativo **MP4 (H.264/AAC)** e ripiega automaticamente su **WebM** quando il browser o il sistema non lo supportano.

Il sito da registrare viene riconosciuto automaticamente: l'estensione determina il sito dal dominio della pagina corrente e di conseguenza cambia il prefisso del nome del file e l'etichetta del sito nel popup / nelle notifiche (vedi "Siti supportati" sotto).

## Caratteristiche

- **Un solo strumento per sette grandi siti video**: le pagine video native di YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok seguono tutte la stessa pipeline (tabCapture → individuazione player → ritaglio Canvas → MediaRecorder). Il sito corrente viene rilevato automaticamente e cambia il prefisso del nome del file e i testi; le differenze di layout tra player vecchi e nuovi di ciascun sito sono consolidate in `src/shared/sites.js`, mantenute in un unico punto (vedi "Siti supportati" sotto).
- **Zero dipendenze di terze parti**: nessun npm, nessun passaggio di build, nessun ffmpeg, nessuna ricodifica (l'MP4 è registrato nativamente da `MediaRecorder`, mai convertito a posteriori).
- **Due modalità di registrazione**
  - **Player intero**: individua automaticamente il rettangolo *effettivamente dipinto* del player (calcolato da `object-fit` / `object-position`), escludendo bande nere, margini della modalità cinema e il chrome del player.
  - **Selezione area**: traccia un rettangolo in un punto qualsiasi della pagina e registra solo quell'area.
- **Immagine sempre pulita**: tutti i controlli si trovano nel popup dell'icona dell'estensione (una pagina di estensione indipendente che non fa parte del rendering della scheda catturata), quindi nessuna interfaccia dell'estensione può comparire nel video.
- **Scorciatoia di pagina**: il tasto singolo predefinito `R` avvia la registrazione quando è inattivo e la arresta/salva durante la registrazione. Modificabile liberamente nel popup → **Impostazioni** (combinazioni con `Ctrl` / `Alt` / `Shift` / `Command`). Agisce solo sulle pagine video dei siti supportati, non sottrae tasti ad altre schede e non entra in conflitto con le scorciatoie globali del browser.
- **Pagina bloccata durante la registrazione**: una maschera traslucida copre tutto ciò che si trova *fuori* dall'immagine, con un «foro» ritagliato per essa, bloccando scorrimento, clic e scorciatoie distruttive, mentre **riproduzione/pausa, avanzamento, volume, sottotitoli e velocità di riproduzione restano pienamente utilizzabili**.
- **Ritaglio stabile**: uscita fissa a 30 fps; la dimensione del canvas viene bloccata al primo fotogramma; il rettangolo di ritaglio deve restare stabile per 3 fotogrammi consecutivi prima dell'avvio, così nessun rettangolo transitorio troppo grande (pubblicità, passaggio alla modalità cinema) finisce nel video.
- **Audio mai perso**: la traccia audio catturata viene riprodotta tramite un `AudioContext`, evitando che la scheda venga silenziata e produca un video muto.
- **"Registrazione" visibile anche a schermo intero**: quando si riproduce a schermo intero l'immagine riempie lo schermo e il suggerimento della maschera non ha dove stare. Lo stato viene allora mostrato da una notifica di sistema persistente più una finestra di stato Document PiP sempre in primo piano (REC + timer + pulsante di stop); se l'immagine ha bande nere, dentro di esse viene disegnato anche un sottile bordo rosso. Tutti gli indicatori stanno fuori dall'immagine catturata e **non entrano mai nel video**; ognuno può essere attivato/disattivato singolarmente nel popup, in **Impostazioni → Indicatori di stato della registrazione a schermo intero**.
- **Ripiegamenti robusti**: rilevamento del fotogramma nero DRM, arresto ed esportazione automatici al cambio di scheda o alla navigazione, autoriparazione quando l'heartbeat del rettangolo si interrompe, ritentativo automatico del download e uscita di emergenza «Ripristina forzatamente e ricomincia».
- **La registrazione viene avviata solo da un clic dell'utente** — mai una cattura silenziosa in background.

## Siti supportati

La pipeline di registrazione (tabCapture → individuazione player → ritaglio Canvas → MediaRecorder) è identica su ogni sito; cambiano solo tre cose: i **domini di iniezione** (`content_scripts.matches` in `manifest.json`), i **selettori DOM** usati per individuare il player e il **nome del sito** usato nel prefisso del file / nei testi. La tabella sotto elenca i siti attualmente supportati e le loro pagine applicabili:

| Sito | Forme di pagina registrabili | Note e limitazioni |
| --- | --- | --- |
| YouTube | Pagine video (`youtube.com/watch…`, Shorts, ecc.) | I contenuti per membri / a pagamento / DRM risultano neri (protezione del browser; vedi limitazioni generali sotto) |
| Bilibili | Pagine video (`bilibili.com/video/BV…`) | Coperti sia il nuovo player bpx sia il vecchio player bilibili; serie e film soggetti a membership / DRM possono risultare neri; **le live non sono supportate** |
| Dailymotion | Pagine video (`dailymotion.com/video/…`) | Quando il `<video>` del player è incapsulato in un iframe / shadow DOM cross-origin (illeggibile dal documento principale), si ripiega automaticamente sull'individuazione del rettangolo del contenitore esterno del player |
| Vimeo | Pagine video (`vimeo.com/…`) | I video privati richiedono login e permesso di visualizzazione |
| Instagram | Post / Reel / Storie (vista modale aperta), video singoli nel feed principale | Parte dei contenuti ha un video riproducibile solo dopo il login |
| Facebook | Watch / Reel / overlay di video singoli / video nella bacheca | Parte dei contenuti richiede il login; con più video a schermo viene individuato automaticamente il «video principale attualmente visibile» |
| TikTok | Pagine di dettaglio video (`tiktok.com/@…/video/…`), overlay video aperti, elementi singoli nel feed Per Te | Con più anteprime a schermo viene individuata automaticamente quella «in riproduzione / con la maggiore area visibile» |

> **Meccanismo di individuazione**: il content script localizza l'area di registrazione tramite il `<video>` *realmente visibile* nella pagina. `src/shared/sites.js` mantiene in modo centralizzato i selettori candidati di contenitore player / video per i layout vecchi e nuovi di ogni sito; quando un contenitore viene trovato, se ne prende il `<video>` interno e da `object-fit` / `object-position` si ricava il rettangolo dell'immagine realmente dipinta (escludendo bande, chrome e margini). Se tutti i candidati falliscono, un ripiegamento generico sceglie il «`<video>` decodificato con la maggiore area visibile» (coprendo ricorsivamente gli shadow DOM aperti). Il player principale deve quindi renderizzare il suo vero `<video>` nel documento principale della pagina (o in uno shadow root aperto leggibile) — **i player incorporati da altre pagine tramite iframe cross-origin non sono supportati**; le superfici disegnate a mano con canvas / WebGL puro (senza `<video>`) non possono essere individuate automaticamente — usa la **selezione area**.

> **Limitazioni generali**:
> - I video protetti da DRM / membership a pagamento (film a pagamento, esclusive in abbonamento, contenuti con licenza esclusiva di ciascuna piattaforma) risultano neri nella cattura — una restrizione di «contenuto protetto» del browser, non un difetto dell'estensione;
> - Per i contenuti che richiedono il login (la maggior parte dei video di Instagram / Facebook / TikTok, alcune serie di Bilibili, ecc.) accedi prima al sito corrispondente nel browser;
> - Se dopo una riprogettazione del sito i selettori si spostano e più `<video>` visibili condividono lo schermo, l'area di registrazione prende per impostazione predefinita quello in decodifica con la maggiore area visibile — tieni il video obiettivo in riproduzione dentro il viewport.

## Struttura del progetto

```
DESIGN.md                    Documento di progettazione tecnica (capacità / architettura / protocollo messaggi / casi limite / flusso dati)
TODO.md                      Elenco attività di sviluppo (spuntare in accettazione)
src/
├── manifest.json            Manifesto MV3 (tabCapture + downloads + activeTab + offscreen + storage + notifications)
├── background.js            Service Worker: ciclo di vita dell'offscreen, routing messaggi, stato globale e badge, notifiche di sistema, proxy di download
├── offscreen.html           Host del documento offscreen
├── offscreen.js             Nucleo della registrazione: getUserMedia(flusso scheda) → video nascosto → ritaglio canvas → MediaRecorder → Blob
├── shared/
│   ├── hotkey.js            Definizione condivisa della scorciatoia «avvia / ferma registrazione» (impostazioni popup, suggerimento, listener content)
│   ├── indicator.js         Lettura/scrittura dei tre interruttori di stato della registrazione a schermo intero (pip / notif / border) (popup / content / guard)
│   ├── countdown.js         Definizione condivisa e lettura/scrittura dei secondi del «conto alla rovescia prima di iniziare» (popup / content / background)
│   └── sites.js             Riconoscimento dei siti supportati (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok)
│                           e selettori candidati dei player per sito (content / popup / countdown)
├── content/
│   ├── guard.js             Maschera di blocco pagina durante la registrazione (foro sul rettangolo dell'immagine) + bordo rosso nelle bande nere a schermo intero
│   ├── pip.js               Finestra di stato Document PiP sempre in primo piano a schermo intero (REC + timer + pulsante di stop)
│   ├── selector.js          Overlay di selezione area (attivato su richiesta dopo il clic su «Registra area»)
│   ├── countdown.js         Overlay di pagina del «conto alla rovescia prima di iniziare» (prima si rimuove l'overlay, poi si avvia la cattura)
│   ├── content.js           Script senza interfaccia: heartbeat del rettangolo del player + notifiche di occultamento/navigazione + attiva/disattiva maschera
│   └── hotkey.js            Listener della scorciatoia «avvia / ferma registrazione» a livello di pagina
├── popup.html               Popup dell'icona: console di registrazione (avvia / area / ferma / stato / timer / suggerimenti / impostazioni)
├── popup.js
├── popup/
│   └── settings.js          Modale impostazioni (scorciatoia, conto alla rovescia prima di iniziare, interruttori di stato della registrazione a schermo intero)
├── assets/                  Risorse statiche
├── icons/                   Icone 16/32/48/128
└── types/                   Dichiarazioni dei tipi dell'API chrome.* (solo tipi)
scripts/verify_extension.py  Script di autoverifica statica
```

## Perché un documento offscreen?

`chrome.tabCapture` non può essere chiamato da un content script, mentre la pipeline `video` / `canvas` / `MediaRecorder` richiede un contesto di finestra con DOM. Un popup si chiude appena perde il focus e un Service Worker non ha alcun DOM: il nucleo della registrazione risiede quindi in un **documento offscreen**.

1. Il **content script** (che non inietta alcuna interfaccia, ma si limita a riportare dati) individua il player nella pagina supportata (riconosciuta da `shared/sites.js`) ogni ~120 ms e invia il rettangolo reale dell'immagine insieme alla base del viewport (dimensione CSS, `devicePixelRatio`, offset del visual viewport).
2. **background** crea il documento offscreen su richiesta e chiama `chrome.tabCapture.getMediaStreamId()` all'interno della catena del gesto utente per ottenere uno `streamId`.
3. Il documento **offscreen** consuma il flusso completo della scheda tramite `getUserMedia({ chromeMediaSourceId: streamId })` (video + audio della pagina).
4. Nell'**offscreen**: un `video` nascosto riproduce il flusso della scheda → un `canvas` nascosto lo ritaglia fotogramma per fotogramma con `drawImage` → la traccia video di `canvas.captureStream(30)` viene unita all'`audioTrack` originale → `MediaRecorder` registra (`video/mp4` prima, poi ripiegamento progressivo su `video/webm`) → i frammenti vengono assemblati in un Blob.
   - La conversione delle coordinate usa un **rapporto misurato** («dimensione del fotogramma catturato ÷ dimensione CSS del viewport», con modello contain e padding centrato) invece di un ingenuo `rect × devicePixelRatio`, eliminando lo spostamento su schermi HiDPI e pagine zoommate.
5. Il documento offscreen **non può** chiamare `chrome.downloads` direttamente: invia `DOWNLOAD_FILE` a **background**, che esegue il download e riporta il risultato tramite `downloads.onChanged`.

Vedi `DESIGN.md` per i dettagli.

## Caricamento (sviluppo)

1. Apri Chrome e vai su `chrome://extensions`.
2. Attiva la **Modalità sviluppatore** in alto a destra.
3. Clicca su **Carica estensione non pacchettizzata** e seleziona la directory `src/` di questo repository (nessun passaggio di build, nulla da compilare).

> Requisiti: Chrome ≥ 116 (`minimum_chrome_version`, necessario per `chrome.offscreen`); l'uscita MP4 nativa richiede Chrome ≥ 126. Si consiglia l'ultima versione stabile.

## Utilizzo

1. Apri una pagina video di un sito supportato (vedi "Siti supportati" sopra — ad es. una pagina di riproduzione di YouTube, una pagina Bilibili `video/BV…`, una pagina di dettaglio di TikTok; alla prima visita aggiorna una volta la pagina così gli script vengono iniettati). Tieni il video in riproduzione normale — i video DRM / a pagamento risultano neri, una restrizione di protezione del browser.
2. Clicca sull'icona dell'estensione → clicca su **Avvia registrazione** nel popup (tieni la scheda visibile e il player completamente dentro il viewport).
   - Se il browser / sistema non può produrre MP4 nativo (Chrome < 126, o encoder H.264/AAC assenti), il popup spiega che questa sessione ripiegherà su WebM.
   - Durante la registrazione, l'icona mostra un badge rosso `REC`. Chiudere il popup non ferma la registrazione: basta ricliccare sull'icona.
3. **Registra area** (opzionale): clicca su **Registra area** → il popup si chiude → traccia un rettangolo sulla pagina → clicca su **Registra selezione** (`Esc` esce dal selettore).
   - Durante la registrazione, il pulsante **Ferma** viene posizionato automaticamente *fuori* dalla selezione così non viene mai ripreso. Se la selezione riempie quasi tutto il viewport e non c'è spazio, i controlli nella pagina vengono nascosti: ferma dal popup o con la scorciatoia.
4. Al termine clicca su **Ferma e salva** → il file viene assemblato e scaricato come `Sito-AAAAMMGG-HHMMSS.mp4` (il prefisso cambia con il sito, ad es. `YouTube-20240908-153000.mp4`, `Bilibili-20240908-153000.mp4`; `.webm` negli ambienti di ripiegamento).
5. **Scorciatoia**: premi il tasto predefinito `R` su una pagina video supportata per iniziare; premilo di nuovo per fermare e salvare.
   - Clicca su **Impostazioni** in alto a destra nel popup per modificarla: clicca sulla casella del tasto e premi la nuova combinazione, `Esc` annulla. Le modifiche valgono subito, nessun ricaricamento necessario.
   - La scorciatoia scatta solo quando una pagina video supportata ha il focus e mai dentro i campi di input come ricerca o commenti. I conflitti con le scorciatoie del browser o del player del sito vengono segnalati nel pannello impostazioni.
6. **Regolazione fine dell'immagine** (sezione comprimibile in fondo al popup): in rare configurazioni (combinazioni di zoom insolite, monitor a DPI misti) può restare un piccolo scostamento fisso — inserisci offset verticali / orizzontali in pixel (positivo = in basso / a destra).
7. **La pagina viene bloccata da una maschera durante la registrazione** (modalità player intero):
   - Tutto ciò che è fuori dall'immagine viene coperto da nero traslucido: pulsanti e link non sono cliccabili, la rotella e lo scorrimento tattile sono bloccati e la posizione di scorrimento è fissata.
   - **Consentito**: riproduzione/pausa, avanzamento, volume, sottotitoli, velocità — tutto ciò che è puro controllo di riproduzione.
   - **Bloccato**: tasti di scorrimento (Spazio, PagSu/PagGiù, Home/Fine, frecce su/giù), schermo intero `f`, modalità cinema `t`, miniplayer `i`, muto `m` e doppio clic sull'immagine — azioni che cambiano il layout o rendono muta la traccia audio.
   - La maschera ha un foro per l'immagine, quindi non copre nulla di ciò che viene registrato e di conseguenza **non appare mai nell'uscita**; sotto l'immagine (sopra se manca spazio) viene mostrato «Registrazione · pagina bloccata».
   - Il ridimensionamento della finestra del browser non può essere impedito da una pagina web: quando viene rilevato un cambio del viewport, la maschera mostra un avviso e il popup consiglia di registrare di nuovo (il ritaglio potrebbe essersi spostato).
8. Dopo l'arresto la maschera viene rimossa automaticamente e la pagina torna normale, senza nodi o listener residui.

### Formati di uscita

| Ambiente | Uscita |
| --- | --- |
| Chrome ≥ 126 con encoder H.264/AAC (es. Chrome recente su Windows / macOS) | **MP4** (H.264 + AAC, `.mp4`) |
| Chrome < 126 | WebM (`.webm`) — il popup spiega il motivo |
| Chrome ≥ 126 ma piattaforma senza encoder (alcune build Linux) | WebM (`.webm`) — il popup spiega il motivo |

> Non viene mai eseguita alcuna ricodifica: quando l'MP4 è disponibile, viene registrato nativamente da `MediaRecorder` (istantaneo, senza perdita); altrimenti l'estensione ripiega su WebM.

### Autorizzazioni

| Autorizzazione | Scopo |
| --- | --- |
| `tabCapture` | Autorizzazione limitata; cattura immagine e audio della scheda corrente dopo un clic utente |
| `downloads` | Salva la registrazione nella cartella download locale |
| `activeTab` | Accesso temporaneo alla scheda corrente concesso al clic sull'icona |
| `offscreen` | Crea il documento offscreen che ospita cattura / ritaglio / registrazione |
| `storage` | `session` conserva lo stato della registrazione e l'intenzione di avvio; `sync` conserva scorciatoia, regolazione fine e interruttori di stato della registrazione a schermo intero |
| `notifications` | Indicatore della registrazione a schermo intero: notifica persistente «Registrazione» (con pulsante di stop) + ricevuta unica di successo / errore del salvataggio (disattivabile nelle impostazioni) |

Nessuna `host_permissions`, nessuna richiesta di rete, nessuna raccolta di dati utente; il content script viene iniettato e agisce solo sotto i domini dei sette siti supportati elencati in `content_scripts.matches` — gli altri siti non ricevono alcuna iniezione né alcuna azione.

## Autoverifica statica

```bash
python3 scripts/verify_extension.py
```

Copre: manifesto / MV3 / file richiesti, restrizione dei domini e ordine di iniezione dei siti supportati (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok) (`shared/hotkey.js` → `shared/indicator.js` → `shared/sites.js` → `content/guard.js` → `content/pip.js` → `content/selector.js` → `content/countdown.js` → `content/content.js` → `content/hotkey.js`), autorizzazioni minime, zero dipendenze di terze parti, sintassi JS di ogni file (`node --check`), confini di contesto API (i content script non devono chiamare `tabCapture` / `downloads` / `offscreen` direttamente), confini di iniezione nella pagina (i controlli devono vivere nel popup; `content/guard.js` è l'unico modulo autorizzato a creare DOM, e deve ritagliare un foro per l'immagine, lasciare il foro vuoto ed essere rimovibile a ogni sessione), e confini del modulo scorciatoie.

## Checklist di accettazione manuale (attività 20 in `TODO.md`)

Dopo il caricamento e l'uso come descritto sopra, verifica ogni punto. **Parte multi-sito**: oltre a YouTube, esegui l'intero flusso «avvia → ferma e salva» su almeno altri due siti appena supportati (es. Bilibili, TikTok) e conferma che il popup / le notifiche mostrino il nome corretto del sito, che il file di uscita abbia il prefisso corrispondente (es. `Bilibili-*.mp4`) e che l'immagine contenga solo l'area del player di quel sito senza spostamenti. Nei punti sotto, "pagina video" indica sempre una pagina video di un sito supportato:

- [ ] 20.1 Il popup si apre correttamente: stato / timer / pulsanti cambiano con la fase; durante la registrazione l'icona mostra un badge rosso `REC`.
- [ ] 20.2 Clic su **Avvia registrazione** → cattura riuscita (stato «Registrazione» + timer attivo) → clic su **Ferma e salva** → viene scaricato un file mp4 (senza MP4 nativo il popup avvisa e viene scaricato un webm).
- [ ] 20.3 Apri l'uscita con un player di sistema / Chrome: l'immagine è l'area ritagliata del player, l'audio è presente e la riproduzione funziona.
- [ ] 20.4 Su schermi HiDPI (DPR ≠ 1, es. Retina) l'immagine non è spostata né disallineata.
- [ ] 20.5 Cambiare scheda durante la registrazione: il popup avvisa che la cattura potrebbe interrompersi; al ritorno la registrazione riprende oppure si ferma ed esporta automaticamente, senza errori.
- [ ] 20.6 Alternare schermo intero / zoom del browser durante la registrazione: l'area di ritaglio segue correttamente.
- [ ] 20.7 I casi di errore vengono segnalati correttamente: pagina non video (pulsante avvia disabilitato), video DRM (avviso dopo ~2,6 s), cattura negata, ecc.
- [ ] 20.8 Dopo la fine (incluse le anomalie): nessun punto rosso di registrazione nella barra degli indirizzi, nessun nodo residuo dell'estensione, nessun errore ripetuto.
- [ ] 20.9 Su Chrome < 126 o piattaforme senza H.264/AAC: il popup dice «MP4 nativo non supportato, verrà prodotto WebM» e la registrazione funziona comunque.
- [ ] 20.10 L'uscita non contiene alcun controllo dell'estensione (niente pulsanti / modali / toast).
- [ ] 20.11 L'uscita non contiene la maschera di blocco (niente bordi scuri, niente testo di avviso).
- [ ] 20.12 Durante la registrazione la pagina è bloccata: pulsanti / link non cliccabili, rotella e scorciatoie senza effetto, nessuno scorrimento; ma riproduzione/pausa, avanzamento e volume funzionano.
- [ ] 20.13 Ridimensionare la finestra durante la registrazione: la maschera avvisa, il popup viene notificato e la maschera ritaglia di nuovo il foro senza coprire l'immagine.
- [ ] 20.14 Dopo ferma e salva la maschera sparisce, la pagina torna interattiva e non restano nodi `yr-guard-`.
- [ ] 20.15 Registra area: traccia una selezione → **Registra selezione** → l'uscita contiene solo l'area scelta e nessun pulsante nella pagina come Avvia / Ferma.
- [ ] 20.16 Avviare la registrazione a schermo intero con la scorciatoia: compare la finestra Document PiP sempre in primo piano che fa il conto alla rovescia, il suo pulsante **Ferma e salva** funziona e la finestra non appare nell'uscita.
- [ ] 20.17 Registrazione a schermo intero di una sorgente con bande nere (es. 21:9 / verticale): appare un sottile bordo rosso dentro le bande e l'immagine finale non lo contiene; le sorgenti a tutto schermo senza bande non hanno automaticamente alcun bordo rosso.
- [ ] 20.18 Durante la registrazione una notifica di sistema resta visibile e può fermarla col suo pulsante; dopo il salvataggio appare una notifica di risultato una tantum; poi notifica e finestra PiP spariscono automaticamente.
- [ ] 20.19 Disattivando tutti e tre gli elementi di **Indicatori di stato della registrazione a schermo intero** nelle Impostazioni: niente PiP / notifica / bordo rosso, e le altre funzioni di registrazione non sono influenzate.

Una volta superata tutta la verifica, spunta gli elementi dell'attività 20 in `TODO.md`.
