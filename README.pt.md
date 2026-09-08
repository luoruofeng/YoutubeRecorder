# YouTube Recorder

<div align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.es.md">Español</a> ·
  <b>Português</b> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.it.md">Italiano</a>
</div>

Extensão Chrome Manifest V3: na página de vídeo de um site compatível — **YouTube, Bilibili, Dailymotion, Vimeo, Instagram, Facebook, TikTok** — um **clique manual** inicia a gravação. Ela captura toda a superfície da aba atual junto com o áudio da página, recorta quadro a quadro com Canvas **a área de imagem realmente exibida do player (ou qualquer região que você selecionar)** e, por fim, exporta um **arquivo de vídeo com áudio** para sua pasta de downloads — com prioridade nativa para **MP4 (H.264/AAC)** e fallback automático para **WebM** quando o navegador ou o sistema não oferece suporte.

O site a ser gravado é reconhecido automaticamente: a extensão determina o site pelo domínio da página atual e alterna de acordo o prefixo do nome do arquivo e o rótulo do site no popup / notificações (consulte "Sites compatíveis" abaixo).

## Recursos

- **Grave um entre sete grandes sites de vídeo**: as páginas de vídeo nativas de YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok seguem todas a mesma cadeia (tabCapture → localizar player → recorte com Canvas → MediaRecorder). O site atual é detectado automaticamente e alterna o prefixo do nome do arquivo e os textos; as diferenças de layout entre os players antigos e novos de cada site estão consolidadas em `src/shared/sites.js`, mantidas em um único lugar (consulte "Sites compatíveis" abaixo).
- **Zero dependências de terceiros**: sem npm, sem etapa de build, sem ffmpeg e sem qualquer recodificação (o MP4 é gravado nativamente pelo `MediaRecorder`, nunca convertido depois).
- **Dois modos de gravação**
  - **Player completo**: localiza automaticamente o retângulo *realmente pintado* do player (calculado a partir de `object-fit` / `object-position`), excluindo barras pretas, margens do modo cinema e o chrome do player.
  - **Seleção de região**: arraste um retângulo em qualquer lugar da página e grave apenas essa área.
- **Imagem sempre limpa**: todos os controles ficam no popup do ícone da extensão (uma página de extensão independente que não faz parte da renderização da aba capturada), portanto nenhuma interface da extensão pode aparecer no vídeo.
- **Atalho de página**: a tecla única padrão `R` inicia a gravação em repouso e a interrompe/salva durante a gravação. Pode ser alterada livremente no popup → **Configurações** (combinações com `Ctrl` / `Alt` / `Shift` / `Command`). Só atua em páginas de vídeo de sites compatíveis, não rouba teclas de outras abas e nunca conflita com atalhos globais do navegador.
- **Página bloqueada durante a gravação**: uma máscara translúcida cobre tudo o que está *fora* da imagem, com um «buraco» recortado para ela, bloqueando rolagem, cliques e atalhos destrutivos — enquanto **reproduzir/pausa, busca, volume, legendas e velocidade continuam totalmente utilizáveis**.
- **Recorte estável**: saída fixa em 30 fps; o tamanho do canvas é travado no primeiro quadro; o retângulo de recorte precisa ficar estável por 3 quadros consecutivos antes de iniciar, para que nenhum retângulo transitório grande demais (anúncios, troca para o modo cinema) acabe no vídeo final.
- **Áudio nunca perdido**: a faixa de áudio capturada é reproduzida por um `AudioContext`, evitando que a aba seja silenciada e gere um vídeo sem som.
- **"Gravando" visível até em tela cheia**: ao reproduzir em tela cheia, a imagem preenche a tela e o aviso da máscara não tem onde ficar. O estado é então mostrado por uma notificação persistente do sistema e por uma janela de status Document PiP sempre no primeiro plano (REC + cronômetro + botão de parar); se a imagem tiver barras pretas, uma fina borda vermelha também é desenhada dentro delas. Todos os indicadores ficam fora da imagem capturada e **nunca entram no vídeo**; cada um pode ser ligado/desligado separadamente no popup, em **Configurações → Indicadores de status da gravação em tela cheia**.
- **Fallbacks robustos**: detecção de quadro preto por DRM, parada e exportação automáticas ao trocar de aba ou navegar, autorrecuperação quando o heartbeat do retângulo falha, nova tentativa automática de download e a saída de emergência «Redefinir à força e recomeçar».
- **A gravação só é iniciada por um clique do usuário** — nunca há captura silenciosa em segundo plano.

## Sites compatíveis

A cadeia de gravação (tabCapture → localizar player → recorte com Canvas → MediaRecorder) é idêntica em todos os sites; apenas três coisas mudam: os **domínios de injeção** (`content_scripts.matches` no `manifest.json`), os **seletores DOM** usados para localizar o player e o **nome do site** usado no prefixo do arquivo / textos. A tabela abaixo lista os sites atualmente compatíveis e suas páginas aplicáveis:

| Site | Formas de página graváveis | Observações e limitações |
| --- | --- | --- |
| YouTube | Páginas de vídeo (`youtube.com/watch…`, Shorts etc.) | Conteúdo de membros / pago / DRM sai preto (proteção do navegador; veja limitações gerais abaixo) |
| Bilibili | Páginas de vídeo (`bilibili.com/video/BV…`) | Tanto o player bpx novo quanto o bilibili antigo são cobertos; séries e filmes com assinatura / DRM podem sair pretos; **lives não são suportados** |
| Dailymotion | Páginas de vídeo (`dailymotion.com/video/…`) | Quando o `<video>` do player está encapsulado em um iframe / shadow DOM de outra origem (ilegível pelo documento principal), faz fallback automático para localizar o retângulo do contêiner externo do player |
| Vimeo | Páginas de vídeo (`vimeo.com/…`) | Vídeos privados exigem login e permissão de visualização |
| Instagram | Posts / Reels / Stories (visualização modal aberta), vídeos individuais do feed inicial | Parte do conteúdo só tem vídeo reproduzível após o login |
| Facebook | Watch / Reels / overlays de vídeo único / vídeos do feed | Parte do conteúdo exige login; com vários vídeos em tela, o «vídeo principal atualmente visível» é atingido automaticamente |
| TikTok | Páginas de detalhe do vídeo (`tiktok.com/@…/video/…`), overlays de vídeo abertos, itens individuais do feed Para Você | Com várias prévias em tela, a «que está tocando / de maior área visível» é atingida automaticamente |

> **Mecanismo de localização**: o content script localiza a região de gravação pelo `<video>` *realmente visível* na página. O `src/shared/sites.js` mantém de forma central os seletores candidatos de contêiner do player / video para os layouts antigos e novos de cada site; ao acertar um contêiner, seu `<video>` interno é usado e o retângulo de imagem realmente exibido é derivado de `object-fit` / `object-position` (removendo barras, chrome e margens). Se todos os candidatos falharem, um fallback genérico escolhe o «`<video>` decodificado de maior área visível» (cobrindo recursivamente shadow DOM abertos). Portanto, o player principal precisa renderizar seu `<video>` real no documento principal da página (ou em um shadow root aberto legível) — **players incorporados de outras páginas por iframes de outra origem não são suportados**; superfícies desenhadas à mão com canvas / WebGL puro (sem `<video>`) não podem ser localizadas automaticamente — use a **seleção de região**.

> **Limitações gerais**:
> - Vídeos protegidos por DRM / assinatura paga (filmes pagos, exclusivos de assinatura, conteúdo com licença exclusiva de cada plataforma) saem pretos na captura — uma restrição de «conteúdo protegido» do navegador, não um defeito da extensão;
> - Para conteúdo que exige login (a maioria dos vídeos de Instagram / Facebook / TikTok, algumas séries da Bilibili etc.), faça login primeiro no site correspondente no navegador;
> - Se os seletores se deslocarem após uma reformulação do site e houver vários `<video>` visíveis em tela, a região de gravação pega por padrão o que está decodificando e tem a maior área visível — mantenha o vídeo alvo tocando dentro do viewport.

## Estrutura do projeto

```
DESIGN.md                    Documento de design técnico (capacidades / arquitetura / protocolo de mensagens / casos limites / fluxo de dados)
TODO.md                      Lista de tarefas de desenvolvimento (marcar na aceitação)
src/
├── manifest.json            Manifesto MV3 (tabCapture + downloads + activeTab + offscreen + storage + notifications)
├── background.js            Service Worker: ciclo de vida do offscreen, roteamento de mensagens, estado global e badge, notificações do sistema, proxy de download
├── offscreen.html           Host do documento offscreen
├── offscreen.js             Núcleo de gravação: getUserMedia(stream da aba) → video oculto → recorte no canvas → MediaRecorder → Blob
├── shared/
│   ├── hotkey.js            Definição compartilhada do atalho «iniciar / parar gravação» (configurações do popup, aviso e listener de conteúdo)
│   ├── indicator.js         Leitura/escrita dos três interruptores de status da gravação em tela cheia (pip / notif / border) (popup / content / guard)
│   ├── countdown.js         Definição compartilhada e leitura/escrita dos segundos da «contagem regressiva antes de iniciar» (popup / content / background)
│   └── sites.js             Reconhecimento de sites compatíveis (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok)
│                           e seletores candidatos de player por site (content / popup / countdown)
├── content/
│   ├── guard.js             Máscara de bloqueio de página durante a gravação (buraco no retângulo da imagem) + borda vermelha nas barras pretas em tela cheia
│   ├── pip.js               Janela de status Document PiP sempre no primeiro plano em tela cheia (REC + cronômetro + botão de parar)
│   ├── selector.js          Sobreposição de seleção de região (ativada sob demanda após clicar em «Gravar região»)
│   ├── countdown.js         Sobreposição de página da «contagem regressiva antes de iniciar» (primeiro remove a sobreposição, depois inicia a captura)
│   ├── content.js           Script sem interface: heartbeat do retângulo do player + avisos de ocultação/navegação + ligar/desligar máscara
│   └── hotkey.js            Listener do atalho «iniciar / parar gravação» no nível da página
├── popup.html               Popup do ícone: console de gravação (iniciar / região / parar / status / cronômetro / avisos / configurações)
├── popup.js
├── popup/
│   └── settings.js          Modal de configurações (atalho, contagem regressiva antes de iniciar, interruptores de status da gravação em tela cheia)
├── assets/                  Recursos estáticos
├── icons/                   Ícones 16/32/48/128
└── types/                   Declarações de tipos da API chrome.* (somente tipos)
scripts/verify_extension.py  Script de autoverificação estática
```

## Por que um documento offscreen?

`chrome.tabCapture` não pode ser chamado a partir de um content script, enquanto a pipeline `video` / `canvas` / `MediaRecorder` exige um contexto de janela com DOM. Um popup fecha assim que perde o foco e um Service Worker não tem DOM algum, então o núcleo da gravação fica em um **documento offscreen**:

1. O **content script** (não injeta interface; apenas informa dados) localiza o player na página compatível (reconhecida por `shared/sites.js`) a cada ~120 ms e envia o retângulo real da imagem junto com a base do viewport (tamanho CSS, `devicePixelRatio`, deslocamento do visual viewport).
2. O **background** cria o documento offscreen sob demanda e chama `chrome.tabCapture.getMediaStreamId()` dentro da cadeia do gesto do usuário para obter um `streamId`.
3. O documento **offscreen** consome o stream completo da aba com `getUserMedia({ chromeMediaSourceId: streamId })` (vídeo + áudio da página).
4. Dentro do **offscreen**: um `video` oculto reproduz o stream da aba → um `canvas` oculto recorta quadro a quadro com `drawImage` → a trilha de vídeo de `canvas.captureStream(30)` é mesclada com o `audioTrack` original → o `MediaRecorder` grava (`video/mp4` primeiro, com retrocesso progressivo para `video/webm`) → os fragmentos são montados em um Blob.
   - A conversão de coordenadas usa uma **proporção medida** («tamanho do quadro capturado ÷ tamanho CSS do viewport», com modelo contain e preenchimento centralizado) em vez de um simples `rect × devicePixelRatio`, o que elimina o deslocamento em telas HiDPI e com zoom.
5. O documento offscreen **não pode** chamar `chrome.downloads` diretamente: envia `DOWNLOAD_FILE` para o **background**, que executa o download e informa o resultado via `downloads.onChanged`.

Consulte `DESIGN.md` para mais detalhes.

## Carregar a extensão (desenvolvimento)

1. Abra o Chrome e vá para `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** no canto superior direito.
3. Clique em **Carregar sem compactação** e selecione o diretório `src/` deste repositório (sem etapa de build, nada para compilar).

> Requisitos: Chrome ≥ 116 (`minimum_chrome_version`, necessário para `chrome.offscreen`); a saída MP4 nativa requer Chrome ≥ 126. Recomenda-se a versão estável mais recente.

## Uso

1. Abra uma página de vídeo de qualquer site compatível (consulte "Sites compatíveis" acima — por exemplo, uma página de reprodução do YouTube, uma página da Bilibili `video/BV…`, uma página de detalhes do TikTok; atualize uma vez na primeira visita para que os scripts sejam injetados). Mantenha o vídeo reproduzindo normalmente — vídeos DRM / pagos saem pretos, uma restrição de proteção do navegador.
2. Clique no ícone da extensão → clique em **Iniciar gravação** no popup (mantenha a aba visível e o player totalmente dentro do viewport).
   - Se o navegador ou o sistema não conseguir gerar MP4 nativo (Chrome < 126 ou sem codificadores H.264/AAC), o popup informa que esta sessão usará WebM.
   - Durante a gravação, o ícone mostra um badge vermelho `REC`. Fechar o popup não interrompe a gravação: basta clicar novamente no ícone.
3. **Gravar região** (opcional): clique em **Gravar região** → o popup fecha → arraste um retângulo na página → clique em **Gravar seleção** (`Esc` sai do seletor).
   - Durante a gravação, o botão **Parar** é colocado automaticamente *fora* da seleção para nunca ser capturado. Se a seleção preencher quase todo o viewport e não sobrar espaço, os controles na página ficam ocultos: pare pelo popup ou pelo atalho.
4. Ao terminar, clique em **Parar e salvar** → o arquivo é montado e baixado como `Site-AAAAMMDD-HHMMSS.mp4` (o prefixo alterna conforme o site, por exemplo `YouTube-20240908-153000.mp4`, `Bilibili-20240908-153000.mp4`; `.webm` em ambientes de retrocesso).
5. **Atalho**: pressione a tecla padrão `R` em uma página de vídeo compatível para iniciar; pressione novamente para parar e salvar.
   - Clique em **Configurações** no canto superior direito do popup para alterá-lo: clique na caixa da tecla e pressione a nova combinação; `Esc` cancela. As alterações valem imediatamente, sem recarregar a página.
   - O atalho só dispara quando uma página de vídeo compatível está com foco e nunca dentro de campos de entrada como a busca ou os comentários. Conflitos com atalhos do navegador ou do player do site são avisados no painel de configurações.
6. **Ajuste fino da imagem** (seção recolhível na parte inferior do popup): em configurações raras (combinações incomuns de zoom, monitores com DPI misto), pode sobrar um pequeno deslocamento fixo: insira valores de pixel verticais / horizontais (positivo = para baixo / direita).
7. **A página fica bloqueada por uma máscara durante a gravação** (modo player completo):
   - Tudo o que está fora da imagem é coberto por preto translúcido: botões e links não são clicáveis, a roda e o toque são bloqueados e a posição de rolagem fica fixa.
   - **Permitido**: reproduzir/pausa, avanço, volume, legendas e velocidade: tudo o que for controle puro de reprodução.
   - **Bloqueado**: teclas de rolagem (Espaço, Page Up/Down, Home/End, setas para cima/baixo), tela cheia `f`, modo cinema `t`, miniplayer `i`, mudo `m` e clique duplo na imagem: ações que mudam o layout ou silenciam a faixa de áudio.
   - A máscara tem um buraco para a imagem, então não cobre nada do que é gravado e **nunca aparece na saída**; sob a imagem (acima se faltar espaço) é exibido «Gravando · página bloqueada».
   - O redimensionamento da janela do navegador não pode ser impedido por uma página web: ao detectar uma mudança no viewport, a máscara mostra um aviso e o popup sugere regravar (o recorte pode ter se deslocado).
8. Após parar, a máscara é removida automaticamente e a página volta ao normal, sem nós nem listeners residuais.

### Formatos de saída

| Ambiente | Saída |
| --- | --- |
| Chrome ≥ 126 com codificadores H.264/AAC (ex.: Chrome recente no Windows / macOS) | **MP4** (H.264 + AAC, `.mp4`) |
| Chrome < 126 | WebM (`.webm`) — o popup explica o motivo |
| Chrome ≥ 126 mas plataforma sem codificadores (algumas builds Linux) | WebM (`.webm`) — o popup explica o motivo |

> Nenhuma recodificação é feita: quando o MP4 está disponível, ele é gravado nativamente pelo `MediaRecorder` (instantâneo, sem perda); caso contrário, a extensão recorre ao WebM.

### Permissões

| Permissão | Uso |
| --- | --- |
| `tabCapture` | Permissão restrita; captura a imagem e o áudio da aba atual após um clique do usuário |
| `downloads` | Salva a gravação na pasta de downloads local |
| `activeTab` | Acesso temporário à aba atual concedido ao clicar no ícone |
| `offscreen` | Cria o documento offscreen que hospeda captura / recorte / gravação |
| `storage` | `session` guarda o estado da gravação e a intenção de início; `sync` guarda o atalho, o ajuste de imagem e os interruptores de status da gravação em tela cheia |
| `notifications` | Indicador da gravação em tela cheia: notificação persistente «Gravando» (com botão para parar) + aviso único de sucesso / falha ao salvar (desativável nas configurações) |

Sem `host_permissions`, sem requisições de rede e sem coleta de dados do usuário; o content script só é injetado e age sob os domínios dos sete sites compatíveis listados em `content_scripts.matches` — outros sites não recebem injeção nem qualquer ação.

## Autoverificação estática

```bash
python3 scripts/verify_extension.py
```

Cobre: manifesto / MV3 / arquivos obrigatórios, restrição de domínio e ordem de injeção dos sites compatíveis (YouTube / Bilibili / Dailymotion / Vimeo / Instagram / Facebook / TikTok) (`shared/hotkey.js` → `shared/indicator.js` → `shared/sites.js` → `content/guard.js` → `content/pip.js` → `content/selector.js` → `content/countdown.js` → `content/content.js` → `content/hotkey.js`), permissões mínimas, zero dependências de terceiros, sintaxe JS de todos os arquivos (`node --check`), limites de contexto de API (content scripts não devem chamar `tabCapture` / `downloads` / `offscreen` diretamente), limites de injeção na página (os controles devem ficar no popup; `content/guard.js` é o único módulo autorizado a criar DOM e deve recortar um buraco para a imagem, deixá-lo vazio e poder ser removido a cada sessão) e limites do módulo de atalhos.

## Lista de aceitação manual (tarefa 20 do `TODO.md`)

Após carregar e usar a extensão como descrito acima, verifique cada item. **Parte de vários sites**: além do YouTube, execute o fluxo completo «iniciar → parar e salvar» em pelo menos mais dois sites recém-suportados (ex.: Bilibili, TikTok) e confirme que o popup / as notificações mostram o nome correto do site, que o arquivo de saída tem o prefixo correspondente (ex.: `Bilibili-*.mp4`) e que a imagem contém apenas a área do player daquele site, sem deslocamento. Nos itens abaixo, «página de vídeo» sempre significa uma página de vídeo de um site compatível:

- [ ] 20.1 O popup abre corretamente: status / cronômetro / botões mudam conforme a fase; o ícone mostra um badge vermelho `REC` durante a gravação.
- [ ] 20.2 Clique em **Iniciar gravação** → captura correta (status «Gravando» + cronômetro em andamento) → clique em **Parar e salvar** → um mp4 é baixado (sem MP4 nativo, o popup avisa e um webm é baixado).
- [ ] 20.3 Abra a saída com um player do sistema / Chrome: a imagem é a área recortada do player, há áudio e a reprodução funciona.
- [ ] 20.4 Em telas HiDPI (DPR ≠ 1, ex.: Retina), a imagem não se desloca nem fica desalinhada.
- [ ] 20.5 Trocar de aba durante a gravação: o popup avisa que a captura pode ser interrompida; ao voltar, continua ou para e exporta automaticamente, sem erros.
- [ ] 20.6 Alternar tela cheia ou zoom do navegador durante a gravação: a área de recorte acompanha corretamente.
- [ ] 20.7 Os casos de erro são informados corretamente: página que não é de vídeo (botão de iniciar desativado), vídeo DRM (aviso após ~2,6 s), captura negada etc.
- [ ] 20.8 Após terminar (inclusive com erros): sem ponto vermelho de gravação na barra de endereço, sem nós residuais da extensão, sem erros repetidos.
- [ ] 20.9 Com Chrome < 126 ou plataforma sem H.264/AAC: o popup informa «MP4 nativo não compatível, será gerado WebM» e a gravação continua funcionando.
- [ ] 20.10 A saída não contém controles da extensão (nem botões, nem modais, nem toasts).
- [ ] 20.11 A saída não contém a máscara de bloqueio (nem bordas escuras, nem textos de aviso).
- [ ] 20.12 Durante a gravação, a página fica bloqueada: botões / links não são clicáveis, a roda e os atalhos não fazem nada e a página não rola; mas reproduzir/pausa, avanço e volume funcionam.
- [ ] 20.13 Redimensionar a janela durante a gravação: a máscara avisa, o popup é notificado e a máscara recorta o buraco novamente sem cobrir a imagem.
- [ ] 20.14 Após parar e salvar, a máscara desaparece, a página volta a ser interativa e não sobram nós `yr-guard-`.
- [ ] 20.15 Gravar região: arraste uma seleção → **Gravar seleção** → a saída contém apenas a área escolhida e nenhum botão na página como Iniciar / Parar.
- [ ] 20.16 Iniciar a gravação em tela cheia pelo atalho: a janela Document PiP sempre no primeiro plano aparece e cronometra, seu botão **Parar e salvar** funciona e o conteúdo da janela não aparece na saída.
- [ ] 20.17 Gravar em tela cheia uma fonte com barras pretas (ex.: 21:9 / vertical): uma fina borda vermelha aparece dentro das barras e a imagem final não a contém; fontes sem barras não têm automaticamente nenhuma borda vermelha.
- [ ] 20.18 Durante a gravação, uma notificação do sistema permanece e pode pará-la pelo botão; após salvar, aparece uma notificação de resultado única; depois, a notificação e a janela PiP somem.
- [ ] 20.19 Ao desativar os três itens de **Indicadores de status da gravação em tela cheia** nas Configurações: sem PiP / notificação / borda vermelha, e o restante dos recursos de gravação não é afetado.

Quando tudo passar, marque os itens da tarefa 20 no `TODO.md`.
