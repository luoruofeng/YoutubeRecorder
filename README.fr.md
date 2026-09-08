# YouTube Recorder

<div align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <b>Français</b> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.it.md">Italiano</a>
</div>

Extension Chrome Manifest V3 : sur la page vidéo d'un site pris en charge — **YouTube, Bilibili, Dailymotion, Vimeo, Instagram, Facebook, TikTok** — un **clic manuel** lance l'enregistrement. L'extension capture la surface complète de l'onglet ainsi que l'audio de la page, découpe image par image avec Canvas **la zone d'image réellement affichée du lecteur (ou toute région que vous sélectionnez)** et produit finalement un **fichier vidéo avec audio** téléchargé localement — **MP4 (H.264/AAC)** natif en priorité, avec repli automatique en **WebM** si le navigateur ou le système ne le permet pas.

Le site à enregistrer est reconnu automatiquement : l'extension détermine le site depuis le domaine de la page courante et bascule en conséquence le préfixe du nom de fichier et le libellé du site dans le popup / les notifications (voir « Sites pris en charge » ci-dessous).

## Fonctionnalités

- **Un seul outil pour sept grands sites vidéo** : les pages vidéo natives de YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok suivent toutes le même pipeline (tabCapture → localisation du lecteur → découpage Canvas → MediaRecorder). Le site courant est détecté automatiquement et fait basculer le préfixe de nom de fichier ainsi que les textes ; les différences de mise en page entre anciens et nouveaux lecteurs de chaque site sont consolidées dans `src/shared/sites.js`, maintenues à un seul endroit (voir « Sites pris en charge » ci-dessous).
- **Zéro dépendance tierce** : pas de npm, aucune étape de build, pas de ffmpeg, aucun ré-encodage (le MP4 est enregistré nativement par `MediaRecorder`, jamais converti après coup).
- **Deux modes d'enregistrement**
  - **Lecteur complet** : localisation automatique du *véritable* rectangle affiché du lecteur (calculé à partir de `object-fit` / `object-position`), excluant les bandes noires, les marges du mode cinéma et le chrome du lecteur.
  - **Sélection de zone** : tracez un rectangle n'importe où sur la page et n'enregistrez que cette zone.
- **Image toujours propre** : toutes les commandes se trouvent dans le popup de l'icône d'extension (page d'extension indépendante, qui ne fait pas partie du rendu de l'onglet capturé) ; aucune interface d'extension ne peut apparaître dans la vidéo.
- **Raccourci de page** : la touche unique par défaut `R` démarre l'enregistrement au repos et l'arrête/enregistre pendant la capture. Modifiable librement dans le popup → **Paramètres** (combinaisons `Ctrl` / `Alt` / `Shift` / `Command` prises en charge). Il n'agit que sur les pages vidéo des sites pris en charge, ne vole aucune touche aux autres onglets et n'entre jamais en conflit avec les raccourcis globaux du navigateur.
- **Page verrouillée pendant l'enregistrement** : un masque translucide couvre tout ce qui se trouve *hors* de l'image, avec un « trou » découpé pour celle-ci, bloquant le défilement, les clics et les raccourcis destructifs — tandis que **lecture/pause, navigation, volume, sous-titres et vitesse de lecture restent parfaitement utilisables**.
- **Découpage stable** : sortie fixe à 30 i/s ; la taille du canvas est verrouillée dès la première image ; le rectangle de découpage doit rester stable pendant 3 images consécutives avant le démarrage, afin qu'aucun rectangle transitoire surdimensionné (publicités, passage en mode cinéma) ne finisse dans la vidéo.
- **Audio jamais perdu** : la piste audio capturée est renvoyée via un `AudioContext`, évitant que l'onglet ne soit mis en sourdine et ne produise une vidéo muette.
- **« Enregistrement » visible même en plein écran** : en lecture plein écran, l'image remplit l'écran et l'info du masque n'a nulle part où se placer. L'état est alors affiché par une notification système persistante ainsi qu'une fenêtre d'état Document PiP toujours au premier plan (REC + chronomètre + bouton d'arrêt) ; si l'image a des bandes noires, une fine bordure rouge y est aussi tracée. Tous les indicateurs se situent hors de l'image capturée et **n'entrent jamais dans la vidéo** ; chacun peut être activé/désactivé individuellement dans le popup sous **Paramètres → Indicateurs d'état de l'enregistrement plein écran**.
- **Repli robuste** : détection d'image noire DRM, arrêt et export automatiques lors d'un changement d'onglet ou d'une navigation, auto-récupération si le heartbeat du rectangle s'interrompt, nouvelle tentative automatique en cas d'échec du téléchargement, et issue de secours « Réinitialiser de force et recommencer ».
- **L'enregistrement n'est déclenché que par un clic utilisateur** — aucune capture silencieuse en arrière-plan, jamais.

## Sites pris en charge

Le pipeline d'enregistrement (tabCapture → localisation du lecteur → découpage Canvas → MediaRecorder) est identique sur tous les sites ; seuls trois éléments diffèrent : les **domaines d'injection** (`content_scripts.matches` dans `manifest.json`), les **sélecteurs DOM** servant à localiser le lecteur, et le **nom du site** utilisé dans le préfixe de fichier / les textes. Le tableau ci-dessous liste les sites actuellement pris en charge et leurs pages applicables :

| Site | Formes de pages enregistrables | Remarques et limites |
| --- | --- | --- |
| YouTube | Pages vidéo (`youtube.com/watch…`, Shorts, etc.) | Les contenus membres / payants / DRM rendent une image noire (protection du navigateur ; voir limites générales ci-dessous) |
| Bilibili | Pages vidéo (`bilibili.com/video/BV…`) | Les lecteurs bpx (nouveau) et bilibili (ancien) sont couverts ; les animes/films sous membre / DRM peuvent donner une image noire ; **les lives ne sont pas pris en charge** |
| Dailymotion | Pages vidéo (`dailymotion.com/video/…`) | Lorsque le `<video>` du lecteur est encapsulé dans un iframe / shadow DOM cross-origin (illisible depuis le document principal), repli automatique sur la localisation du rectangle du conteneur externe du lecteur |
| Vimeo | Pages vidéo (`vimeo.com/…`) | Les vidéos privées nécessitent d'être connecté et d'avoir le droit de visionnage |
| Instagram | Posts / Reels / Stories (vue modale ouverte), vidéos individuelles du fil d'accueil | Une partie du contenu n'a de vidéo lisible qu'après connexion |
| Facebook | Watch / Reels / overlays de vidéo unique / vidéos du fil d'actualité | Une partie du contenu nécessite la connexion ; en cas de plusieurs vidéos à l'écran, la « vidéo principale actuellement visible » est ciblée automatiquement |
| TikTok | Pages de détail vidéo (`tiktok.com/@…/video/…`), overlays de vidéo ouverts, éléments individuels du fil « Pour toi » | En cas de plusieurs aperçus à l'écran, celui « en cours de lecture / de plus grande surface visible » est ciblé automatiquement |

> **Mécanisme de localisation** : le content script localise la zone d'enregistrement via le `<video>` *réellement visible* sur la page. `src/shared/sites.js` centralise les sélecteurs candidats de conteneur de lecteur / video pour les anciennes et nouvelles mises en page de chaque site ; une fois un conteneur trouvé, son `<video>` interne est récupéré et le véritable rectangle d'image affiché est dérivé de `object-fit` / `object-position` (en retirant bandes noires, chrome et marges). Si tous les candidats échouent, un repli générique choisit le « `<video>` décodé de plus grande surface visible » (couvrant récursivement les shadow DOM ouverts). Le lecteur principal doit donc rendre son vrai `<video>` dans le document principal de la page (ou un shadow root ouvert lisible) — **les lecteurs intégrés depuis d'autres pages via des iframes cross-origin ne sont pas pris en charge** ; les surfaces auto-dessinées pures canvas / WebGL, non-`<video>`, ne peuvent pas être localisées automatiquement — utilisez la **sélection de zone**.

> **Limites générales** :
> - Les vidéos protégées par DRM / payantes (films payants, exclusivités d'abonnement, contenus sous licence exclusive de chaque plateforme) rendent une image noire dans la capture — une restriction « contenu protégé » du navigateur, pas un défaut de l'extension ;
> - Pour le contenu nécessitant une connexion (la plupart des vidéos d'Instagram / Facebook / TikTok, certains animes Bilibili, etc.), connectez-vous d'abord au site correspondant dans le navigateur ;
> - Si les sélecteurs dérivent après une refonte et que plusieurs `<video>` visibles partagent l'écran, la zone d'enregistrement prend par défaut celle qui est décodée et a la plus grande surface visible — gardez la vidéo cible en lecture dans le viewport.

## Structure du projet

```
DESIGN.md                    Document de conception technique (capacités / architecture / protocole de messages / cas limites / flux de données)
TODO.md                      Liste des tâches de développement (à cocher lors de la recette)
src/
├── manifest.json            Manifeste MV3 (tabCapture + downloads + activeTab + offscreen + storage + notifications)
├── background.js            Service Worker : cycle de vie de l'offscreen, routage des messages, état global et badge, notifications système, proxy de téléchargement
├── offscreen.html           Hôte du document offscreen
├── offscreen.js             Cœur de l'enregistrement : getUserMedia(flux de l'onglet) → vidéo cachée → découpage canvas → MediaRecorder → Blob
├── shared/
│   ├── hotkey.js            Définition partagée du raccourci « démarrer / arrêter » (paramètres du popup, info, écouteur content)
│   ├── indicator.js         Lecture/écriture des trois interrupteurs d'état de l'enregistrement plein écran (pip / notif / border) (popup / content / guard)
│   ├── countdown.js         Définition partagée et lecture/écriture des secondes du « compte à rebours avant démarrage » (popup / content / background)
│   └── sites.js             Reconnaissance des sites pris en charge (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok)
│                           et sélecteurs candidats de lecteur par site (content / popup / countdown)
├── content/
│   ├── guard.js             Masque de verrouillage de page pendant l'enregistrement (trou découpé sur l'image) + bordure rouge des bandes noires en plein écran
│   ├── pip.js               Fenêtre d'état Document PiP toujours au premier plan en plein écran (REC + chronomètre + bouton d'arrêt)
│   ├── selector.js          Superposition de sélection de zone (activée à la demande après un clic sur « Enregistrer une zone »)
│   ├── countdown.js         Superposition de page du « compte à rebours avant démarrage » (on retire d'abord la superposition, puis on lance la capture)
│   ├── content.js           Script sans interface : heartbeat du rectangle du lecteur + notifications de masquage/navigation + bascule du masque
│   └── hotkey.js            Écouteur du raccourci « démarrer / arrêter » au niveau de la page
├── popup.html               Popup de l'icône : console d'enregistrement (démarrer / zone / arrêter / état / chronomètre / conseils / paramètres)
├── popup.js
├── popup/
│   └── settings.js          Modale de paramètres (raccourci, compte à rebours avant démarrage, interrupteurs d'état de l'enregistrement plein écran)
├── assets/                  Ressources statiques
├── icons/                   Icônes 16/32/48/128
└── types/                   Déclarations de types chrome.* (types uniquement)
scripts/verify_extension.py  Script d'auto-vérification statique
```

## Pourquoi un document offscreen ?

`chrome.tabCapture` ne peut pas être appelé depuis un content script, alors que le pipeline `video` / `canvas` / `MediaRecorder` exige un contexte de fenêtre avec DOM. Un popup se ferme dès qu'il perd le focus et un Service Worker n'a aucun DOM : le cœur de l'enregistrement réside donc dans un **document offscreen**.

1. Le **content script** (qui n'injecte aucune interface et ne fait que remonter des données) localise le lecteur sur la page prise en charge (reconnue par `shared/sites.js`) toutes les ~120 ms et transmet le véritable rectangle de l'image ainsi que la base du viewport (taille CSS, `devicePixelRatio`, décalage du visual viewport).
2. **background** crée le document offscreen à la demande et appelle `chrome.tabCapture.getMediaStreamId()` dans la chaîne du geste utilisateur pour obtenir un `streamId`.
3. Le document **offscreen** consomme le flux complet de l'onglet via `getUserMedia({ chromeMediaSourceId: streamId })` (vidéo + audio de la page).
4. Dans l'**offscreen** : une `video` cachée lit le flux de l'onglet → un `canvas` caché le découpe image par image avec `drawImage` → la piste vidéo de `canvas.captureStream(30)` est fusionnée avec l'`audioTrack` d'origine → `MediaRecorder` enregistre (`video/mp4` d'abord, repli progressif vers `video/webm`) → les fragments sont assemblés en Blob.
   - La conversion de coordonnées utilise un **ratio mesuré** (« taille de l'image capturée ÷ taille CSS du viewport », avec un modèle contain et un padding centré) plutôt qu'un naïf `rect × devicePixelRatio`, ce qui supprime tout décalage sur écran HiDPI ou page zoomée.
5. Le document offscreen **ne peut pas** appeler `chrome.downloads` directement : il envoie `DOWNLOAD_FILE` à **background**, qui effectue le téléchargement et remonte le résultat via `downloads.onChanged`.

Voir `DESIGN.md` pour plus de détails.

## Chargement (développement)

1. Ouvrez Chrome et allez sur `chrome://extensions`.
2. Activez le **Mode développeur** en haut à droite.
3. Cliquez sur **Charger l'extension non empaquetée** et sélectionnez le dossier `src/` de ce dépôt (aucune étape de build, rien à compiler).

> Prérequis : Chrome ≥ 116 (`minimum_chrome_version`, nécessaire pour `chrome.offscreen`) ; la sortie MP4 native requiert Chrome ≥ 126. La dernière version stable est recommandée.

## Utilisation

1. Ouvrez une page vidéo d'un site pris en charge (voir « Sites pris en charge » ci-dessus — par ex. une page de lecture YouTube, une page Bilibili `video/BV…`, une page de détail TikTok ; rafraîchissez une fois lors de la première visite pour que les scripts soient injectés). Gardez la vidéo lisible normalement — les vidéos DRM / payantes rendent une image noire, restriction de protection du navigateur.
2. Cliquez sur l'icône de l'extension → cliquez sur **Démarrer l'enregistrement** dans le popup (gardez l'onglet visible et le lecteur entièrement dans le viewport).
   - Si le navigateur / système ne peut pas produire de MP4 natif (Chrome < 126, ou encodeurs H.264/AAC absents), le popup indique que la session sera repliée en WebM.
   - Pendant l'enregistrement, l'icône affiche un badge rouge `REC`. Fermer le popup n'arrête pas l'enregistrement : il suffit de recliquer sur l'icône.
3. **Enregistrement de zone** (optionnel) : cliquez sur **Enregistrer une zone** → le popup se ferme → tracez un rectangle sur la page → cliquez sur **Enregistrer la sélection** (`Échap` quitte le sélecteur).
   - Pendant l'enregistrement, le bouton **Arrêter** est automatiquement placé *hors* de la sélection pour ne jamais être filmé. Si la sélection remplit presque le viewport et qu'aucune place ne reste, les contrôles à l'écran sont masqués : arrêtez depuis le popup ou avec le raccourci.
4. Cliquez sur **Arrêter et enregistrer** → le fichier est assemblé et téléchargé sous `Site-AAAAMMJJ-HHMMSS.mp4` (le préfixe bascule avec le site, par ex. `YouTube-20240908-153000.mp4`, `Bilibili-20240908-153000.mp4` ; `.webm` en environnement de repli).
5. **Raccourci** : appuyez sur la touche par défaut `R` sur une page vidéo prise en charge pour démarrer ; réappuyez pour arrêter et enregistrer.
   - Cliquez sur **Paramètres** en haut à droite du popup pour le modifier : cliquez sur la case de touche puis appuyez sur la nouvelle combinaison, `Échap` annule. Les changements sont immédiats, aucun rechargement nécessaire.
   - Le raccourci ne se déclenche que lorsqu'une page vidéo prise en charge a le focus et jamais dans les champs de saisie (recherche, commentaires). Les conflits avec le navigateur ou le lecteur du site sont signalés dans le panneau de paramètres.
6. **Calibration du cadrage** (section repliable en bas du popup) : sur de rares configurations (combinaisons de zoom inhabituelles, écrans à DPI mixtes), un léger décalage peut subsister — saisissez des décalages verticaux / horizontaux en pixels (positif = bas / droite).
7. **La page est verrouillée par un masque pendant l'enregistrement** (mode lecteur complet) :
   - Tout ce qui est hors de l'image est couvert de noir translucide : boutons et liens non cliquables, molette et défilement tactile bloqués, position de défilement figée.
   - **Autorisé** : lecture/pause, navigation, volume, sous-titres, vitesse de lecture — tout ce qui est du pur contrôle de lecture.
   - **Bloqué** : touches de défilement (Espace, Page Haut/Bas, Début/Fin, flèches Haut/Bas), plein écran `f`, mode cinéma `t`, mini-lecteur `i`, sourdine `m` et double-clic sur l'image — ces actions modifient la mise en page ou rendent la piste audio muette.
   - Le masque découpe un trou pour l'image : il ne couvre rien de ce qui est enregistré et n'apparaît donc **jamais dans la sortie** ; une mention « Enregistrement · page verrouillée » s'affiche sous l'image (au-dessus si la place manque).
   - Le redimensionnement de la fenêtre ne peut pas être empêché par une page web : dès qu'un changement de viewport est détecté, le masque affiche un avertissement et le popup conseille de réenregistrer (le cadrage peut avoir dérivé).
8. Après l'arrêt, le masque est supprimé automatiquement et la page revient à la normale, sans nœud ni écouteur résiduel.

### Formats de sortie

| Environnement | Sortie |
| --- | --- |
| Chrome ≥ 126 avec encodeurs H.264/AAC (Chrome récent sur Windows / macOS) | **MP4** (H.264 + AAC, `.mp4`) |
| Chrome < 126 | WebM (`.webm`) — le popup explique pourquoi |
| Chrome ≥ 126 mais plateforme sans encodeurs (certaines builds Linux) | WebM (`.webm`) — le popup explique pourquoi |

> Aucun ré-encodage n'est effectué : lorsque le MP4 est disponible, il est enregistré nativement par `MediaRecorder` (instantané, sans perte) ; sinon l'extension se replie sur WebM.

### Permissions

| Permission | Usage |
| --- | --- |
| `tabCapture` | Permission restreinte ; capture l'image et l'audio de l'onglet courant après un clic utilisateur |
| `downloads` | Enregistre la vidéo dans le dossier de téléchargement local |
| `activeTab` | Accès temporaire à l'onglet courant accordé au clic sur l'icône |
| `offscreen` | Crée le document offscreen hébergeant capture / découpage / enregistrement |
| `storage` | `session` conserve l'état d'enregistrement et l'intention de démarrage ; `sync` conserve le raccourci, la calibration et les interrupteurs d'état de l'enregistrement plein écran |
| `notifications` | Indicateur d'enregistrement plein écran : notification « Enregistrement » persistante (avec bouton d'arrêt) + accusé de réception unique de réussite/échec de la sauvegarde (désactivable dans les paramètres) |

Aucune `host_permissions`, aucune requête réseau, aucune collecte de données utilisateur ; le content script n'est injecté et n'agit que sous les domaines des sept sites pris en charge listés dans `content_scripts.matches` — les autres sites ne reçoivent aucune injection ni aucune action.

## Auto-vérification statique

```bash
python3 scripts/verify_extension.py
```

Couvre : manifeste / MV3 / fichiers requis, restriction de domaine et ordre d'injection des sites pris en charge (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok) (`shared/hotkey.js` → `shared/indicator.js` → `shared/sites.js` → `content/guard.js` → `content/pip.js` → `content/selector.js` → `content/countdown.js` → `content/content.js` → `content/hotkey.js`), permissions minimales, zéro dépendance tierce, syntaxe JS de chaque fichier (`node --check`), frontières de contexte d'API (les content scripts ne doivent pas appeler `tabCapture` / `downloads` / `offscreen` directement), frontières d'injection page (les contrôles doivent vivre dans le popup ; `content/guard.js` est le seul module autorisé à créer du DOM, et il doit découper un trou pour l'image, laisser ce trou vide et être supprimable à chaque session), et frontières du module de raccourci.

## Liste de recette manuelle (tâche 20 de `TODO.md`)

Après avoir chargé et utilisé l'extension comme décrit ci-dessus, vérifiez chaque point. **Partie multi-sites** : en plus de YouTube, effectuez l'intégralité du flux « démarrer → arrêter et enregistrer » sur au moins deux autres sites nouvellement pris en charge (par ex. Bilibili, TikTok) ; confirmez que le popup / les notifications affichent le bon nom de site, que le fichier de sortie porte le préfixe correspondant (par ex. `Bilibili-*.mp4`) et que l'image ne contient que la zone du lecteur de ce site, sans décalage. Dans les points ci-dessous, « page vidéo » désigne toujours une page vidéo d'un site pris en charge :

- [ ] 20.1 Le popup s'ouvre correctement : état / chronomètre / boutons évoluent avec la phase ; l'icône affiche un badge rouge `REC` pendant l'enregistrement.
- [ ] 20.2 Clic sur **Démarrer l'enregistrement** → capture réussie (état « Enregistrement » + chronomètre actif) → clic sur **Arrêter et enregistrer** → un fichier mp4 est téléchargé (sans MP4 natif, le popup avertit et un webm est téléchargé).
- [ ] 20.3 Ouvrez la sortie avec un lecteur système / Chrome : l'image est bien la zone du lecteur découpée, l'audio est présent, la lecture fonctionne.
- [ ] 20.4 Sur écran HiDPI (DPR ≠ 1, ex. Retina), l'image n'est ni décalée ni désalignée.
- [ ] 20.5 Changer d'onglet pendant l'enregistrement : le popup avertit que la capture peut s'interrompre ; le retour reprend ou arrête/exporte automatiquement, sans erreur.
- [ ] 20.6 Basculer en plein écran / zoomer pendant l'enregistrement : la zone de découpage suit correctement.
- [ ] 20.7 Les cas d'erreur sont correctement signalés : page non vidéo (bouton démarrer désactivé), vidéo DRM (avertissement après ~2,6 s), capture refusée, etc.
- [ ] 20.8 Après la fin (y compris en erreur) : aucun point rouge d'enregistrement dans la barre d'adresse, aucun nœud d'extension résiduel, aucune erreur répétée.
- [ ] 20.9 Sur Chrome < 126 ou plateforme sans H.264/AAC : le popup indique « MP4 natif non pris en charge, sortie WebM » et l'enregistrement fonctionne quand même.
- [ ] 20.10 La sortie ne contient aucun contrôle d'extension (ni bouton, ni modale, ni toast).
- [ ] 20.11 La sortie ne contient aucun masque de verrouillage (ni bord sombre, ni texte d'info).
- [ ] 20.12 Pendant l'enregistrement la page est verrouillée : boutons / liens non cliquables, molette et raccourcis sans effet, pas de défilement ; mais lecture/pause, navigation et volume fonctionnent.
- [ ] 20.13 Redimensionner la fenêtre pendant l'enregistrement : le masque avertit, le popup est notifié, et le masque redécoupe son trou sans couvrir l'image.
- [ ] 20.14 Après l'arrêt, le masque disparaît, la page redevient interactive et aucun nœud `yr-guard-` ne subsiste.
- [ ] 20.15 Enregistrement de zone : tracer une sélection → **Enregistrer la sélection** → la sortie ne contient que la zone choisie et aucun bouton à l'écran de type Démarrer / Arrêter.
- [ ] 20.16 Démarrer l'enregistrement en plein écran via le raccourci : la fenêtre Document PiP au premier plan apparaît et chronomètre, son bouton **Arrêter et enregistrer** fonctionne, et le contenu de la fenêtre n'apparaît pas dans la sortie.
- [ ] 20.17 Enregistrement plein écran d'une source à bandes noires (ex. 21:9 / verticale) : une fine bordure rouge apparaît dans les bandes et l'image finale n'en contient pas ; les sources pleine image sans bandes n'ont automatiquement pas de bordure rouge.
- [ ] 20.18 Une notification système reste affichée pendant l'enregistrement et peut l'arrêter via son bouton ; une notification de résultat unique apparaît après la sauvegarde ; la notification et la fenêtre PiP disparaissent toutes deux ensuite.
- [ ] 20.19 Désactivation des trois éléments des **Indicateurs d'état de l'enregistrement plein écran** dans les paramètres : ni PiP / notification / bordure rouge, et le reste des fonctionnalités d'enregistrement n'est pas affecté.

Une fois tout validé, cochez les éléments de la tâche 20 dans `TODO.md`.
