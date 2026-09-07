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

Extension Chrome Manifest V3 : sur une page de lecture YouTube, un **clic manuel** lance l'enregistrement. L'extension capture la surface complète de l'onglet ainsi que l'audio de la page, découpe image par image avec Canvas **la zone du lecteur (ou toute région que vous sélectionnez)**, puis produit un **fichier vidéo avec audio** téléchargé localement — **MP4 (H.264/AAC)** natif en priorité, avec repli automatique en **WebM** si le navigateur ou le système ne le permet pas.

## Fonctionnalités

- **Zéro dépendance tierce** : pas de npm, aucune étape de build, pas de ffmpeg, aucun ré-encodage (le MP4 est enregistré nativement par `MediaRecorder`, jamais converti après coup).
- **Deux modes d'enregistrement**
  - **Lecteur complet** : localisation automatique du *véritable* rectangle peint du lecteur (calculé à partir de `object-fit` / `object-position`), excluant les bandes noires, les marges du mode cinéma et le chrome du lecteur.
  - **Sélection de zone** : tracez un rectangle n'importe où sur la page et n'enregistrez que cette zone.
- **Image toujours propre** : toutes les commandes se trouvent dans le popup de l'icône d'extension (page d'extension indépendante, qui ne fait pas partie du rendu de l'onglet capturé) ; aucune interface d'extension ne peut apparaître dans la vidéo.
- **Raccourci de page** : la touche unique par défaut `R` démarre l'enregistrement au repos et l'arrête/enregistre pendant la capture. Modifiable librement dans le popup → **Paramètres** (combinaisons `Ctrl` / `Alt` / `Shift` / `Command` prises en charge). Il n'agit que sur les pages YouTube, ne vole aucune touche aux autres onglets et n'entre jamais en conflit avec les raccourcis globaux du navigateur.
- **Page verrouillée pendant l'enregistrement** : un masque translucide couvre tout ce qui se trouve *hors* de l'image, avec un « trou » découpé pour celle-ci, bloquant le défilement, les clics et les raccourcis destructifs — tandis que **lecture/pause, navigation, volume, sous-titres et vitesse de lecture restent parfaitement utilisables**.
- **Découpage stable** : sortie fixe à 30 i/s ; la taille du canvas est verrouillée dès la première image ; le rectangle de découpage doit rester stable pendant 3 images consécutives avant le démarrage, afin qu'aucun rectangle transitoire surdimensionné (publicités, passage en mode cinéma) ne finisse dans la vidéo.
- **Audio jamais perdu** : la piste audio capturée est renvoyée via un `AudioContext`, évitant que l'onglet ne soit mis en sourdine et ne produise une vidéo muette.
- **Repli robuste** : détection d'image noire DRM, arrêt et export automatiques lors d'un changement d'onglet ou d'une navigation, auto-récupération si le heartbeat du rectangle s'interrompt, nouvelle tentative automatique en cas d'échec du téléchargement, et issue de secours « Réinitialiser de force et recommencer ».
- **L'enregistrement n'est déclenché que par un clic utilisateur** — aucune capture silencieuse en arrière-plan, jamais.

## Structure du projet

```
DESIGN.md                    Document de conception technique (capacités / architecture / protocole de messages / cas limites / flux de données)
TODO.md                      Liste des tâches de développement (à cocher lors de la recette)
src/
├── manifest.json            Manifeste MV3 (tabCapture + downloads + activeTab + offscreen + storage)
├── background.js            Service Worker : cycle de vie de l'offscreen, routage des messages, état global et badge, proxy de téléchargement
├── offscreen.html           Hôte du document offscreen
├── offscreen.js             Cœur de l'enregistrement : getUserMedia(flux de l'onglet) → vidéo cachée → découpage canvas → MediaRecorder → Blob
├── shared/
│   └── hotkey.js            Définition partagée du raccourci « démarrer / arrêter » (paramètres du popup, infobulle, écouteur content)
├── content/
│   ├── guard.js             Masque de verrouillage de page pendant l'enregistrement (trou découpé sur l'image ; existe uniquement pendant une session)
│   ├── selector.js          Superposition de sélection de zone (activée à la demande après un clic sur « Enregistrer une zone »)
│   ├── content.js           Script sans interface : heartbeat du rectangle du lecteur + notifications de masquage/navigation + bascule du masque
│   └── hotkey.js            Écouteur du raccourci « démarrer / arrêter » au niveau de la page
├── popup.html               Popup de l'icône : console d'enregistrement (démarrer / zone / arrêter / état / chronomètre / conseils / paramètres)
├── popup.js
├── popup/
│   └── settings.js          Modale de paramètres (activation du raccourci, capture de touche, avertissements de conflit)
├── assets/                  Ressources statiques
├── icons/                   Icônes 16/32/48/128
└── types/                   Déclarations de types chrome.* (types uniquement)
scripts/verify_extension.py  Script d'auto-vérification statique
```

## Pourquoi un document offscreen ?

`chrome.tabCapture` ne peut pas être appelé depuis un content script, alors que le pipeline `video` / `canvas` / `MediaRecorder` exige un contexte de fenêtre avec DOM. Un popup se ferme dès qu'il perd le focus et un Service Worker n'a aucun DOM : le cœur de l'enregistrement réside donc dans un **document offscreen**.

1. Le **content script** (qui n'injecte aucune interface et ne fait que remonter des données) localise le lecteur toutes les ~120 ms et transmet le véritable rectangle de l'image ainsi que la base du viewport (taille CSS, `devicePixelRatio`, décalage du visual viewport).
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

1. Ouvrez n'importe quelle **page de lecture YouTube** (vidéos publiques ; les vidéos DRM ou réservées aux membres produisent une image noire — restriction de protection du navigateur).
2. Cliquez sur l'icône de l'extension → cliquez sur **Démarrer l'enregistrement** dans le popup (gardez l'onglet visible et le lecteur entièrement dans le viewport).
   - Si le navigateur / système ne peut pas produire de MP4 natif (Chrome < 126, ou encodeurs H.264/AAC absents), le popup indique que la session sera repliée en WebM.
   - Pendant l'enregistrement, l'icône affiche un badge rouge `REC`. Fermer le popup n'arrête pas l'enregistrement : il suffit de recliquer sur l'icône.
3. **Enregistrement de zone** (optionnel) : cliquez sur **Enregistrer une zone** → le popup se ferme → tracez un rectangle sur la page → cliquez sur **Enregistrer la sélection** (`Échap` quitte le sélecteur).
   - Pendant l'enregistrement, le bouton **Arrêter** est automatiquement placé *hors* de la sélection pour ne jamais être filmé. Si la sélection remplit presque le viewport et qu'aucune place ne reste, les contrôles à l'écran sont masqués : arrêtez depuis le popup ou avec le raccourci.
4. Cliquez sur **Arrêter et enregistrer** → le fichier est assemblé et téléchargé sous `YouTube-AAAAMMJJ-HHMMSS.mp4` (`.webm` en environnement de repli).
5. **Raccourci** : appuyez sur la touche par défaut `R` sur une page YouTube pour démarrer ; réappuyez pour arrêter et enregistrer.
   - Cliquez sur **Paramètres** en haut à droite du popup pour le modifier : cliquez sur la case de touche puis appuyez sur la nouvelle combinaison, `Échap` annule. Les changements sont immédiats, aucun rechargement nécessaire.
   - Le raccourci ne se déclenche que lorsqu'une page YouTube a le focus et jamais dans les champs de saisie (recherche, commentaires). Les conflits avec le navigateur ou le lecteur YouTube sont signalés dans le panneau de paramètres.
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
| `storage` | `session` conserve l'état d'enregistrement et l'intention de démarrage ; `sync` conserve le raccourci et la calibration |

Aucune `host_permissions`, aucune requête réseau, aucune collecte de données utilisateur.

## Auto-vérification statique

```bash
python3 scripts/verify_extension.py
```

Couvre : manifeste / MV3 / fichiers requis, motifs limités à YouTube et ordre d'injection, permissions minimales, zéro dépendance tierce, syntaxe JS de chaque fichier (`node --check`), frontières de contexte d'API (les content scripts ne doivent pas appeler `tabCapture` / `downloads` / `offscreen` directement), frontières d'injection page (les contrôles doivent vivre dans le popup ; `content/guard.js` est le seul module autorisé à créer du DOM, et il doit découper un trou pour l'image, laisser ce trou vide et être supprimable à chaque session), et frontières du module de raccourci.

## Liste de recette manuelle (tâche 20 de `TODO.md`)

Après avoir chargé et utilisé l'extension comme décrit ci-dessus, vérifiez chaque point :

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

Une fois tout validé, cochez les éléments de la tâche 20 dans `TODO.md`.
