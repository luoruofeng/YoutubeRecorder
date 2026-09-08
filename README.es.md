# YouTube Recorder

<div align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <b>Español</b> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.it.md">Italiano</a>
</div>

Extensión de Chrome Manifest V3: en la página de vídeo de un sitio compatible — **YouTube, Bilibili, Dailymotion, Vimeo, Instagram, Facebook, TikTok** — un **clic manual** inicia la grabación. Captura la superficie completa de la pestaña actual junto con el audio de la página, recorta fotograma a fotograma con Canvas **el área de imagen realmente pintada del reproductor (o cualquier región que selecciones)** y finalmente exporta un **archivo de vídeo con audio** a tu carpeta de descargas: da prioridad nativa a **MP4 (H.264/AAC)** y recurre automáticamente a **WebM** si el navegador o el sistema no pueden generarlo.

El sitio a grabar se reconoce automáticamente: la extensión detecta el sitio por el dominio de la página actual y cambia en consecuencia el prefijo del nombre de archivo y el texto del sitio en el popup / notificaciones (ver «Sitios compatibles» más abajo).

## Características

- **Graba uno entre siete grandes sitios de vídeo**: las páginas de vídeo nativas de YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok comparten la misma cadena (tabCapture → localizar reproductor → recorte con Canvas → MediaRecorder). El sitio actual se detecta automáticamente y cambia el prefijo del nombre de archivo y los textos; las diferencias entre los reproductores antiguos y nuevos de cada sitio están consolidadas en `src/shared/sites.js`, con un único punto de mantenimiento (ver «Sitios compatibles» más abajo).
- **Cero dependencias de terceros**: sin npm, sin paso de compilación, sin ffmpeg y sin recodificación alguna (el MP4 lo graba `MediaRecorder` de forma nativa; nunca se convierte después).
- **Dos modos de grabación**
  - **Reproductor completo**: localiza automáticamente el rectángulo *realmente pintado* del reproductor (calculado a partir de `object-fit` / `object-position`), excluyendo barras negras, márgenes del modo cine y el chrome del reproductor.
  - **Selección de región**: arrastra un rectángulo en cualquier parte de la página y graba solo esa zona.
- **Imagen siempre limpia**: todos los controles están en el popup del icono de la extensión (una página de extensión independiente que no forma parte del renderizado de la pestaña capturada), por lo que ninguna interfaz de la extensión puede aparecer en el vídeo.
- **Atajo de página**: la tecla única por defecto `R` inicia la grabación en reposo y la detiene/guarda durante la grabación. Cambiable libremente en el popup → **Ajustes** (se admiten combinaciones con `Ctrl` / `Alt` / `Shift` / `Command`). Solo actúa en páginas de vídeo de sitios compatibles, no roba teclas de otras pestañas ni entra en conflicto con los atajos globales del navegador.
- **Página bloqueada durante la grabación**: una máscara translúcida cubre todo lo que está *fuera* de la imagen, con un «agujero» recortado para ella, bloqueando el desplazamiento, los clics y los atajos destructivos, mientras que **reproducir/pausa, avance, volumen, subtítulos y velocidad siguen siendo totalmente utilizables**.
- **Recorte estable**: salida fija a 30 fps; el tamaño del canvas se fija en el primer fotograma; el rectángulo de recorte debe mantenerse estable 3 fotogramas consecutivos antes de empezar, de modo que ningún rectángulo transitorio sobredimensionado (anuncios, cambios al modo cine) acabe en el vídeo final.
- **El audio nunca se pierde**: la pista de audio capturada se reproduce mediante un `AudioContext`, evitando que la pestaña quede silenciada y produzca un vídeo sin sonido.
- **«Grabando» visible incluso en pantalla completa**: al reproducir a pantalla completa la imagen llena la pantalla y el aviso de la máscara no tiene dónde ponerse. El estado se muestra entonces con una notificación del sistema persistente más una ventana de estado Document PiP siempre en primer plano (REC + cronómetro + botón de detener); si la imagen tiene barras negras, además se dibuja un fino borde rojo dentro de ellas. Todos los indicadores quedan fuera de la imagen capturada y **nunca entran en el vídeo**; cada uno puede activarse/desactivarse por separado en el popup bajo **Ajustes → Indicadores de estado de la grabación a pantalla completa**.
- **Respaldo ante fallos completo**: detección de fotograma negro por DRM, parada y exportación automáticas al cambiar de pestaña o navegar, autorrecuperación si el heartbeat del rectángulo se interrumpe, reintento automático de descarga y salida de emergencia «Restablecer y reiniciar».
- **La grabación solo se inicia con un clic del usuario**: nunca hay captura silenciosa en segundo plano.

## Sitios compatibles

La cadena de grabación (tabCapture → localizar reproductor → recorte con Canvas → MediaRecorder) es idéntica en todos los sitios; solo cambian tres cosas: los **dominios de inyección** (`content_scripts.matches` en `manifest.json`), los **selectores DOM** usados para localizar el reproductor y el **nombre del sitio** empleado en el prefijo del archivo / textos. La siguiente tabla muestra los sitios compatibles actualmente y sus páginas aplicables:

| Sitio | Formas de página grabables | Notas y limitaciones |
| --- | --- | --- |
| YouTube | Páginas de vídeo (`youtube.com/watch…`, Shorts, etc.) | El contenido de miembros / de pago / DRM sale en negro (protección del navegador; ver limitaciones generales abajo) |
| Bilibili | Páginas de vídeo (`bilibili.com/video/BV…`) | Cubre tanto el reproductor bpx nuevo como el bilibili antiguo; series y películas con membresía / DRM pueden salir en negro; **los directos no se admiten** |
| Dailymotion | Páginas de vídeo (`dailymotion.com/video/…`) | Cuando el `<video>` del reproductor está envuelto en un iframe / shadow DOM de otro origen (no legible desde el documento principal), se recurre automáticamente a localizar el rectángulo del contenedor exterior del reproductor |
| Vimeo | Páginas de vídeo (`vimeo.com/…`) | Los vídeos privados requieren iniciar sesión y tener permiso de visualización |
| Instagram | Posts / Reels / Historias (vista modal abierta), vídeos individuales del feed de inicio | Parte del contenido solo tiene vídeo reproducible tras iniciar sesión |
| Facebook | Watch / Reels / superposiciones de vídeo único / vídeos del muro | Parte del contenido requiere iniciar sesión; con varios vídeos en pantalla se acierta automáticamente el «vídeo principal actualmente visible» |
| TikTok | Páginas de detalle de vídeo (`tiktok.com/@…/video/…`), superposiciones de vídeo abiertas, elementos individuales del feed «Para ti» | Con varias vistas previas en pantalla se acierta automáticamente la «que se está reproduciendo / con mayor área visible» |

> **Mecanismo de localización**: el content script localiza la zona de grabación mediante el `<video>` *realmente visible* en la página. `src/shared/sites.js` mantiene de forma central los selectores candidatos de contenedor de reproductor / video para las versiones antiguas y nuevas de cada sitio; al acertar un contenedor se toma su `<video>` interno y se deduce el rectángulo de imagen realmente pintado a partir de `object-fit` / `object-position` (eliminando barras, chrome y márgenes). Si fallan todos los candidatos, se usa como respaldo genérico el «`<video>` decodificado de mayor área visible» (cubriendo recursivamente shadow DOM abiertos). Por tanto, el reproductor principal debe renderizar su `<video>` real en el documento principal de la página (o en un shadow root abierto legible) — **los reproductores incrustados desde otras páginas mediante iframes de otro origen no se admiten**; las superficies dibujadas a mano con canvas / WebGL puro (sin `<video>`) no pueden localizarse automáticamente — usa la **selección de región**.

> **Limitaciones generales**:
> - Los vídeos protegidos por DRM / membresía de pago (películas de pago, exclusivas de suscripción, contenido con licencia exclusiva de cada plataforma) salen en negro en la captura — una restricción de «contenido protegido» del navegador, no un defecto de la extensión;
> - Para el contenido que requiere iniciar sesión (la mayoría de los vídeos de Instagram / Facebook / TikTok, algunas series de Bilibili, etc.), inicia sesión antes en el sitio correspondiente desde el navegador;
> - Si los selectores se desvían tras un rediseño y hay varios `<video>` visibles en pantalla, la zona de grabación toma por defecto el que se está decodificando con mayor área visible — mantén el vídeo objetivo reproduciéndose dentro del viewport.

## Estructura del proyecto

```
DESIGN.md                    Documento de diseño técnico (capacidades / arquitectura / protocolo de mensajes / casos límite / flujo de datos)
TODO.md                      Lista de tareas de desarrollo (marcar durante la aceptación)
src/
├── manifest.json            Manifiesto MV3 (tabCapture + downloads + activeTab + offscreen + storage + notifications)
├── background.js            Service Worker: ciclo de vida del offscreen, enrutado de mensajes, estado global y badge, notificaciones del sistema, proxy de descarga
├── offscreen.html           Host del documento offscreen
├── offscreen.js             Núcleo de grabación: getUserMedia(stream de la pestaña) → video oculto → recorte en canvas → MediaRecorder → Blob
├── shared/
│   ├── hotkey.js            Definición compartida del atajo «iniciar / detener grabación» (ajustes del popup, aviso y listener de contenido)
│   ├── indicator.js         Lectura/escritura de los tres interruptores de estado de la grabación a pantalla completa (pip / notif / border) (popup / content / guard)
│   ├── countdown.js         Definición compartida y lectura/escritura de los segundos de la «cuenta atrás antes de empezar» (popup / content / background)
│   └── sites.js             Reconocimiento de sitios compatibles (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok)
│                           y selectores candidatos de reproductor por sitio (content / popup / countdown)
├── content/
│   ├── guard.js             Máscara de bloqueo de página durante la grabación (agujero ajustado a la imagen) + borde rojo en barras negras a pantalla completa
│   ├── pip.js               Ventana de estado Document PiP siempre en primer plano a pantalla completa (REC + cronómetro + botón de detener)
│   ├── selector.js          Superposición de selección de región (se activa al hacer clic en «Grabar región»)
│   ├── countdown.js         Superposición de página de la «cuenta atrás antes de empezar» (primero se retira la superposición, luego se inicia la captura)
│   ├── content.js           Script sin interfaz: heartbeat del rectángulo del reproductor + avisos de ocultado/navegación + activar/desactivar máscara
│   └── hotkey.js            Listener del atajo «iniciar / detener grabación» a nivel de página
├── popup.html               Popup del icono: consola de grabación (iniciar / región / detener / estado / cronómetro / avisos / ajustes)
├── popup.js
├── popup/
│   └── settings.js          Modal de ajustes (atajo, cuenta atrás antes de empezar, interruptores de estado de la grabación a pantalla completa)
├── assets/                  Recursos estáticos
├── icons/                   Iconos 16/32/48/128
└── types/                   Declaraciones de tipos de la API chrome.* (solo tipos)
scripts/verify_extension.py  Script de autocomprobación estática
```

## ¿Por qué un documento offscreen?

`chrome.tabCapture` no puede invocarse desde un content script, mientras que la canalización `video` / `canvas` / `MediaRecorder` necesita un contexto de ventana con DOM. Un popup se cierra en cuanto pierde el foco y un Service Worker no tiene DOM, así que el núcleo de grabación vive en un **documento offscreen**:

1. El **content script** (no inyecta interfaz; solo informa datos) localiza el reproductor en la página compatible (reconocida por `shared/sites.js`) cada ~120 ms y envía el rectángulo real de la imagen junto con la base del viewport (tamaño CSS, `devicePixelRatio`, desplazamiento del visual viewport).
2. **background** crea el documento offscreen según necesidad y llama a `chrome.tabCapture.getMediaStreamId()` dentro de la cadena del gesto del usuario para obtener un `streamId`.
3. El documento **offscreen** consume el stream completo de la pestaña con `getUserMedia({ chromeMediaSourceId: streamId })` (vídeo + audio de la página).
4. Dentro del **offscreen**: un `video` oculto reproduce el stream de la pestaña → un `canvas` oculto recorta fotograma a fotograma con `drawImage` → la pista de vídeo de `canvas.captureStream(30)` se fusiona con el `audioTrack` original → `MediaRecorder` graba (`video/mp4` primero, con retroceso progresivo a `video/webm`) → los fragmentos se ensamblan en un Blob.
   - La conversión de coordenadas usa una **proporción medida** («tamaño del fotograma capturado ÷ tamaño CSS del viewport», con modelo contain y relleno centrado) en lugar de un simple `rect × devicePixelRatio`, lo que elimina el desplazamiento en pantallas HiDPI y con zoom.
5. El documento offscreen **no puede** llamar directamente a `chrome.downloads`: envía `DOWNLOAD_FILE` a **background**, que realiza la descarga e informa del resultado mediante `downloads.onChanged`.

Consulta `DESIGN.md` para más detalles.

## Cargar la extensión (desarrollo)

1. Abre Chrome y ve a `chrome://extensions`.
2. Activa el **Modo de desarrollador** arriba a la derecha.
3. Haz clic en **Cargar extensión sin empaquetar** y selecciona el directorio `src/` de este repositorio (sin paso de compilación, nada que compilar).

> Requisitos: Chrome ≥ 116 (`minimum_chrome_version`, necesario para `chrome.offscreen`); la salida MP4 nativa requiere Chrome ≥ 126. Se recomienda la última versión estable.

## Uso

1. Abre una página de vídeo de cualquier sitio compatible (ver «Sitios compatibles» arriba — p. ej. una página de reproducción de YouTube, una página de Bilibili `video/BV…`, una página de detalle de TikTok; actualiza una vez en la primera visita para que se inyecten los scripts). Mantén el vídeo reproduciéndose con normalidad: los vídeos DRM / de pago salen en negro, restricción de protección del navegador.
2. Haz clic en el icono de la extensión → haz clic en **Iniciar grabación** en el popup (mantén la pestaña visible y el reproductor completamente dentro del viewport).
   - Si el navegador o el sistema no pueden generar MP4 nativo (Chrome < 126 o sin codificadores H.264/AAC), el popup indica que esta sesión usará WebM.
   - Durante la grabación, el icono muestra un badge rojo `REC`. Cerrar el popup no detiene la grabación: basta con volver a hacer clic en el icono.
3. **Grabar región** (opcional): haz clic en **Grabar región** → el popup se cierra → arrastra un rectángulo en la página → haz clic en **Grabar selección** (`Esc` sale del selector).
   - Durante la grabación, el botón **Detener** se coloca automáticamente *fuera* de la selección para que nunca aparezca en el vídeo. Si la selección ocupa casi todo el viewport y no hay sitio, los controles en página se ocultan: detén desde el popup o con el atajo.
4. Al terminar, haz clic en **Detener y guardar** → el archivo se ensambla y descarga como `Sitio-AAAAMMDD-HHMMSS.mp4` (el prefijo cambia según el sitio, p. ej. `YouTube-20240908-153000.mp4`, `Bilibili-20240908-153000.mp4`; `.webm` en entornos de retroceso).
5. **Atajo**: pulsa la tecla por defecto `R` en una página de vídeo compatible para iniciar; vuelve a pulsarla para detener y guardar.
   - Haz clic en **Ajustes** en la esquina superior derecha del popup para cambiarlo: haz clic en el cuadro de tecla y pulsa la nueva combinación; `Esc` cancela. Los cambios se aplican al instante, sin recargar la página.
   - El atajo solo se dispara cuando una página de vídeo compatible tiene el foco y nunca dentro de campos de entrada como el buscador o los comentarios. Los conflictos con atajos del navegador o del reproductor del sitio se avisan en el panel de ajustes.
6. **Ajuste fino de la imagen** (sección plegable al final del popup): en configuraciones poco habituales (zoom inusual, monitores con DPI mixto) puede quedar un pequeño desplazamiento fijo: introduce valores de píxeles verticales / horizontales (positivo = abajo / derecha).
7. **La página queda bloqueada por una máscara durante la grabación** (modo reproductor completo):
   - Todo lo que está fuera de la imagen se cubre con negro translúcido: botones y enlaces no son clicables, se bloquean la rueda y el desplazamiento táctil y la posición de scroll queda fijada.
   - **Permitido**: reproducir/pausa, avance, volumen, subtítulos y velocidad: todo lo que sea control puro de reproducción.
   - **Bloqueado**: teclas de desplazamiento (Espacio, Av/Re Pág, Inicio/Fin, flechas Arriba/Abajo), pantalla completa `f`, modo cine `t`, minirreproductor `i`, silencio `m` y doble clic en la imagen: acciones que cambian el diseño o silencian la pista de audio.
   - La máscara tiene un agujero para la imagen, por lo que no cubre nada de lo que se graba y **nunca aparece en la salida**; bajo la imagen (encima si falta espacio) se muestra «Grabando · página bloqueada».
   - El redimensionado de la ventana del navegador no lo puede impedir una página web: al detectar un cambio del viewport, la máscara muestra un aviso y el popup sugiere volver a grabar (el recorte puede haberse desplazado).
8. Tras detener, la máscara se elimina automáticamente y la página vuelve a la normalidad, sin nodos ni listeners residuales.

### Formatos de salida

| Entorno | Salida |
| --- | --- |
| Chrome ≥ 126 con codificadores H.264/AAC (p. ej. Chrome reciente en Windows / macOS) | **MP4** (H.264 + AAC, `.mp4`) |
| Chrome < 126 | WebM (`.webm`): el popup explica el motivo |
| Chrome ≥ 126 pero plataforma sin codificadores (algunas compilaciones de Linux) | WebM (`.webm`): el popup explica el motivo |

> No se realiza ninguna recodificación: cuando el MP4 está disponible, `MediaRecorder` lo graba de forma nativa (sin espera y sin pérdida de calidad); en caso contrario se retrocede a WebM.

### Permisos

| Permiso | Uso |
| --- | --- |
| `tabCapture` | Permiso restringido; captura la imagen y el audio de la pestaña actual tras un clic del usuario |
| `downloads` | Guarda la grabación en la carpeta de descargas local |
| `activeTab` | Acceso temporal a la pestaña actual concedido al hacer clic en el icono |
| `offscreen` | Crea el documento offscreen que aloja captura / recorte / grabación |
| `storage` | `session` guarda el estado de grabación y la intención de inicio; `sync` guarda el atajo, el ajuste de imagen y los interruptores de estado de la grabación a pantalla completa |
| `notifications` | Indicador de la grabación a pantalla completa: notificación persistente «Grabando» (con botón para detener) + aviso único de éxito / error al guardar (desactivable en los ajustes) |

Sin `host_permissions`, sin peticiones de red y sin recogida de datos del usuario; el content script solo se inyecta y actúa bajo los dominios de los siete sitios compatibles listados en `content_scripts.matches` — el resto de sitios no recibe ninguna inyección ni acción.

## Autocomprobación estática

```bash
python3 scripts/verify_extension.py
```

Cubre: manifiesto / MV3 / archivos obligatorios, restricción de dominio y orden de inyección de los sitios compatibles (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok) (`shared/hotkey.js` → `shared/indicator.js` → `shared/sites.js` → `content/guard.js` → `content/pip.js` → `content/selector.js` → `content/countdown.js` → `content/content.js` → `content/hotkey.js`), permisos mínimos, cero dependencias de terceros, sintaxis JS de todos los archivos (`node --check`), límites de contexto de API (los content scripts no deben llamar directamente a `tabCapture` / `downloads` / `offscreen`), límites de inyección en página (los controles deben estar en el popup; `content/guard.js` es el único módulo autorizado a crear DOM y debe recortar un agujero para la imagen, dejarlo vacío y poder eliminarse en cada sesión) y límites del módulo de atajos.

## Lista de aceptación manual (tarea 20 de `TODO.md`)

Tras cargar y usar la extensión como se describe arriba, comprueba cada punto. **Parte de varios sitios**: además de YouTube, ejecuta el flujo completo «iniciar → detener y guardar» en al menos otros dos sitios recién incorporados (p. ej. Bilibili, TikTok) y confirma que el popup / las notificaciones muestran el nombre correcto del sitio, que el archivo de salida lleva el prefijo correspondiente (p. ej. `Bilibili-*.mp4`) y que la imagen contiene solo el área del reproductor de ese sitio sin desviarse. En los puntos siguientes, «página de vídeo» designa siempre una página de vídeo de un sitio compatible:

- [ ] 20.1 El popup abre correctamente: estado / cronómetro / botones cambian según la fase; el icono muestra un badge rojo `REC` durante la grabación.
- [ ] 20.2 Clic en **Iniciar grabación** → captura correcta (estado «Grabando» + cronómetro en marcha) → clic en **Detener y guardar** → se descarga un mp4 (sin MP4 nativo, el popup avisa y se descarga un webm).
- [ ] 20.3 Abre la salida con un reproductor del sistema o Chrome: la imagen es el área recortada del reproductor, hay audio y se reproduce bien.
- [ ] 20.4 En pantallas HiDPI (DPR ≠ 1, p. ej. Retina) la imagen no se desplaza ni se desalinea.
- [ ] 20.5 Cambiar de pestaña durante la grabación: el popup avisa de que la captura puede interrumpirse; al volver continúa o se detiene y exporta automáticamente, sin errores.
- [ ] 20.6 Alternar pantalla completa o zoom del navegador durante la grabación: el área de recorte sigue correctamente.
- [ ] 20.7 Los casos de error se informan bien: página que no es de vídeo (botón de inicio desactivado), vídeo DRM (aviso tras ~2,6 s), captura denegada, etc.
- [ ] 20.8 Tras finalizar (incluidos los errores): sin punto rojo de grabación en la barra de direcciones, sin nodos residuales de la extensión, sin errores repetidos.
- [ ] 20.9 Con Chrome < 126 o plataforma sin H.264/AAC: el popup indica «MP4 nativo no compatible, se generará WebM» y la grabación sigue funcionando.
- [ ] 20.10 La salida no contiene controles de la extensión (ni botones, ni modales, ni toasts).
- [ ] 20.11 La salida no contiene la máscara de bloqueo (ni bordes oscuros ni textos de aviso).
- [ ] 20.12 Durante la grabación la página queda bloqueada: botones y enlaces no son clicables, la rueda y los atajos no hacen nada y la página no se desplaza; pero reproducir/pausa, avance y volumen funcionan.
- [ ] 20.13 Redimensionar la ventana durante la grabación: la máscara avisa, el popup recibe el aviso y la máscara vuelve a recortar el agujero sin cubrir la imagen.
- [ ] 20.14 Tras detener y guardar, la máscara desaparece, la página vuelve a ser interactiva y no quedan nodos `yr-guard-`.
- [ ] 20.15 Grabar región: arrastra una selección → **Grabar selección** → la salida solo contiene el área elegida y ningún botón en página como Iniciar / Detener.
- [ ] 20.16 Iniciar la grabación a pantalla completa con el atajo: aparece la ventana Document PiP siempre en primer plano y va cronometrando; su botón **Detener y guardar** funciona y la ventana no aparece en la salida.
- [ ] 20.17 Grabar a pantalla completa una fuente con barras negras (p. ej. 21:9 / vertical): aparece un fino borde rojo dentro de las barras y la imagen final no lo contiene; las fuentes sin barras no tienen automáticamente ningún borde rojo.
- [ ] 20.18 Durante la grabación queda una notificación del sistema que puede detenerla con su botón; tras guardar aparece una notificación de resultado única; después desaparecen tanto la notificación como la ventana PiP.
- [ ] 20.19 Al desactivar los tres elementos de **Indicadores de estado de la grabación a pantalla completa** en Ajustes: sin PiP / notificación / borde rojo, y el resto de funciones de grabación no se ve afectado.

Cuando todo pase, marca los puntos de la tarea 20 en `TODO.md`.
