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

Extensión de Chrome Manifest V3: en una página de reproducción de YouTube, un **clic manual** inicia la grabación. Captura la superficie completa de la pestaña junto con el audio de la página, recorta fotograma a fotograma con Canvas **el área del reproductor (o cualquier región que selecciones)** y finalmente exporta un **archivo de vídeo con audio** a tu carpeta de descargas: da prioridad nativa a **MP4 (H.264/AAC)** y recurre automáticamente a **WebM** si el navegador o el sistema no pueden generarlo.

## Características

- **Cero dependencias de terceros**: sin npm, sin paso de compilación, sin ffmpeg y sin recodificación alguna (el MP4 lo graba `MediaRecorder` de forma nativa; nunca se convierte después).
- **Dos modos de grabación**
  - **Reproductor completo**: localiza automáticamente el rectángulo *realmente pintado* del reproductor (calculado a partir de `object-fit` / `object-position`), excluyendo barras negras, márgenes del modo cine y el chrome del reproductor.
  - **Selección de región**: arrastra un rectángulo en cualquier parte de la página y graba solo esa zona.
- **Imagen siempre limpia**: todos los controles están en el popup del icono de la extensión (una página de extensión independiente que no forma parte del renderizado de la pestaña capturada), por lo que ninguna interfaz de la extensión puede aparecer en el vídeo.
- **Atajo de página**: la tecla única por defecto `R` inicia la grabación en reposo y la detiene/guarda durante la grabación. Cambiable libremente en el popup → **Ajustes** (se admiten combinaciones con `Ctrl` / `Alt` / `Shift` / `Command`). Solo actúa en páginas de YouTube, no roba teclas de otras pestañas ni entra en conflicto con los atajos globales del navegador.
- **Página bloqueada durante la grabación**: una máscara translúcida cubre todo lo que está *fuera* de la imagen, con un «agujero» recortado para ella, bloqueando el desplazamiento, los clics y los atajos destructivos, mientras que **reproducir/pausa, avance, volumen, subtítulos y velocidad siguen siendo totalmente utilizables**.
- **Recorte estable**: salida fija a 30 fps; el tamaño del canvas se fija en el primer fotograma; el rectángulo de recorte debe mantenerse estable 3 fotogramas consecutivos antes de empezar, de modo que ningún rectángulo transitorio sobredimensionado (anuncios, cambios al modo cine) acabe en el vídeo final.
- **El audio nunca se pierde**: la pista de audio capturada se reproduce mediante un `AudioContext`, evitando que la pestaña quede silenciada y produzca un vídeo sin sonido.
- **Respaldo ante fallos completo**: detección de fotograma negro por DRM, parada y exportación automáticas al cambiar de pestaña o navegar, autorrecuperación si el heartbeat del rectángulo se interrumpe, reintento automático de descarga y salida de emergencia «Restablecer y reiniciar».
- **La grabación solo se inicia con un clic del usuario**: nunca hay captura silenciosa en segundo plano.

## Estructura del proyecto

```
DESIGN.md                    Documento de diseño técnico (capacidades / arquitectura / protocolo de mensajes / casos límite / flujo de datos)
TODO.md                      Lista de tareas de desarrollo (marcar durante la aceptación)
src/
├── manifest.json            Manifiesto MV3 (tabCapture + downloads + activeTab + offscreen + storage)
├── background.js            Service Worker: ciclo de vida del offscreen, enrutado de mensajes, estado global y badge, proxy de descarga
├── offscreen.html           Host del documento offscreen
├── offscreen.js             Núcleo de grabación: getUserMedia(stream de la pestaña) → video oculto → recorte en canvas → MediaRecorder → Blob
├── shared/
│   └── hotkey.js            Definición compartida del atajo «iniciar / detener grabación» (ajustes del popup, aviso y listener de contenido)
├── content/
│   ├── guard.js             Máscara de bloqueo de página durante la grabación (agujero ajustado a la imagen; solo existe durante una sesión)
│   ├── selector.js          Superposición de selección de región (se activa al hacer clic en «Grabar región»)
│   ├── content.js           Script sin interfaz: heartbeat del rectángulo del reproductor + avisos de ocultado/navegación + activar/desactivar máscara
│   └── hotkey.js            Listener del atajo «iniciar / detener grabación» a nivel de página
├── popup.html               Popup del icono: consola de grabación (iniciar / región / detener / estado / cronómetro / avisos / ajustes)
├── popup.js
├── popup/
│   └── settings.js          Modal de ajustes (activar atajo, captura de tecla, avisos de conflicto)
├── assets/                  Recursos estáticos
├── icons/                   Iconos 16/32/48/128
└── types/                   Declaraciones de tipos de la API chrome.* (solo tipos)
scripts/verify_extension.py  Script de autocomprobación estática
```

## ¿Por qué un documento offscreen?

`chrome.tabCapture` no puede invocarse desde un content script, mientras que la canalización `video` / `canvas` / `MediaRecorder` necesita un contexto de ventana con DOM. Un popup se cierra en cuanto pierde el foco y un Service Worker no tiene DOM, así que el núcleo de grabación vive en un **documento offscreen**:

1. El **content script** (no inyecta interfaz; solo informa datos) localiza el reproductor cada ~120 ms y envía el rectángulo real de la imagen junto con la base del viewport (tamaño CSS, `devicePixelRatio`, desplazamiento del visual viewport).
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

1. Abre cualquier **página de reproducción de YouTube** (vídeos públicos; los vídeos con DRM o para miembros se graban en negro — una restricción de protección del navegador).
2. Haz clic en el icono de la extensión → haz clic en **Iniciar grabación** en el popup (mantén la pestaña visible y el reproductor completamente dentro del viewport).
   - Si el navegador o el sistema no pueden generar MP4 nativo (Chrome < 126 o sin codificadores H.264/AAC), el popup indica que esta sesión usará WebM.
   - Durante la grabación, el icono muestra un badge rojo `REC`. Cerrar el popup no detiene la grabación: basta con volver a hacer clic en el icono.
3. **Grabar región** (opcional): haz clic en **Grabar región** → el popup se cierra → arrastra un rectángulo en la página → haz clic en **Grabar selección** (`Esc` sale del selector).
   - Durante la grabación, el botón **Detener** se coloca automáticamente *fuera* de la selección para que nunca aparezca en el vídeo. Si la selección ocupa casi todo el viewport y no hay sitio, los controles en página se ocultan: detén desde el popup o con el atajo.
4. Al terminar, haz clic en **Detener y guardar** → el archivo se ensambla y descarga como `YouTube-AAAAMMDD-HHMMSS.mp4` (`.webm` en entornos de retroceso).
5. **Atajo**: pulsa la tecla por defecto `R` en una página de YouTube para iniciar; vuelve a pulsarla para detener y guardar.
   - Haz clic en **Ajustes** en la esquina superior derecha del popup para cambiarlo: haz clic en el cuadro de tecla y pulsa la nueva combinación; `Esc` cancela. Los cambios se aplican al instante, sin recargar la página.
   - El atajo solo se dispara cuando una página de YouTube tiene el foco y nunca dentro de campos de entrada como el buscador o los comentarios. Los conflictos con atajos del navegador o del reproductor se avisan en el panel de ajustes.
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
| `storage` | `session` guarda el estado de grabación y la intención de inicio; `sync` guarda el atajo y el ajuste de imagen |

Sin `host_permissions`, sin peticiones de red y sin recogida de datos del usuario.

## Autocomprobación estática

```bash
python3 scripts/verify_extension.py
```

Cubre: manifiesto / MV3 / archivos obligatorios, patrones limitados a YouTube y orden de inyección, permisos mínimos, cero dependencias de terceros, sintaxis JS de todos los archivos (`node --check`), límites de contexto de API (los content scripts no deben llamar directamente a `tabCapture` / `downloads` / `offscreen`), límites de inyección en página (los controles deben estar en el popup; `content/guard.js` es el único módulo autorizado a crear DOM y debe recortar un agujero para la imagen, dejarlo vacío y poder eliminarse en cada sesión) y límites del módulo de atajos.

## Lista de aceptación manual (tarea 20 de `TODO.md`)

Tras cargar y usar la extensión como se describe arriba, comprueba cada punto:

- [ ] 20.1 El popup abre correctamente: estado / cronómetro / botones cambian según la fase; el icono muestra un badge rojo `REC` durante la grabación.
- [ ] 20.2 Clic en **Iniciar grabación** → captura correcta (estado «Grabando» + cronómetro en marcha) → clic en **Detener y guardar** → se descarga un mp4 (sin MP4 nativo, el popup avisa y se descarga un webm).
- [ ] 20.3 Abre la salida con un reproductor del sistema o Chrome: la imagen es el área recortada del reproductor, hay audio y se reproduce bien.
- [ ] 20.4 En pantallas HiDPI (DPR ≠ 1, p. ej. Retina) la imagen no se desplaza ni se desalinea.
- [ ] 20.5 Cambiar de pestaña durante la grabación: el popup avisa de que la captura puede interrumpirse; al volver continúa o se detiene y exporta automáticamente, sin errores.
- [ ] 20.6 Alternar pantalla completa o zoom del navegador durante la grabación: el área de recorte sigue correctamente.
- [ ] 20.7 Los casos de error se informan bien: página que no es de reproducción (botón de inicio desactivado), vídeo DRM (aviso tras ~2,6 s), captura denegada, etc.
- [ ] 20.8 Tras finalizar (incluidos los errores): sin punto rojo de grabación en la barra de direcciones, sin nodos residuales de la extensión, sin errores repetidos.
- [ ] 20.9 Con Chrome < 126 o plataforma sin H.264/AAC: el popup indica «MP4 nativo no compatible, se generará WebM» y la grabación sigue funcionando.
- [ ] 20.10 La salida no contiene controles de la extensión (ni botones, ni modales, ni toasts).
- [ ] 20.11 La salida no contiene la máscara de bloqueo (ni bordes oscuros ni textos de aviso).
- [ ] 20.12 Durante la grabación la página queda bloqueada: botones y enlaces no son clicables, la rueda y los atajos no hacen nada y la página no se desplaza; pero reproducir/pausa, avance y volumen funcionan.
- [ ] 20.13 Redimensionar la ventana durante la grabación: la máscara avisa, el popup recibe el aviso y la máscara vuelve a recortar el agujero sin cubrir la imagen.
- [ ] 20.14 Tras detener y guardar, la máscara desaparece, la página vuelve a ser interactiva y no quedan nodos `yr-guard-`.
- [ ] 20.15 Grabar región: arrastra una selección → **Grabar selección** → la salida solo contiene el área elegida y ningún botón en página como Iniciar / Detener.

Cuando todo pase, marca los puntos de la tarea 20 en `TODO.md`.
