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

Extensão Chrome Manifest V3: em uma página de reprodução do YouTube, um **clique manual** inicia a gravação. Ela captura toda a superfície da aba junto com o áudio da página, recorta quadro a quadro com Canvas **a área do player (ou qualquer região que você selecionar)** e, por fim, exporta um **arquivo de vídeo com áudio** para sua pasta de downloads — com prioridade nativa para **MP4 (H.264/AAC)** e fallback automático para **WebM** quando o navegador ou o sistema não oferece suporte.

## Recursos

- **Zero dependências de terceiros**: sem npm, sem etapa de build, sem ffmpeg e sem qualquer recodificação (o MP4 é gravado nativamente pelo `MediaRecorder`, nunca convertido depois).
- **Dois modos de gravação**
  - **Player completo**: localiza automaticamente o retângulo *realmente pintado* do player (calculado a partir de `object-fit` / `object-position`), excluindo barras pretas, margens do modo cinema e o chrome do player.
  - **Seleção de região**: arraste um retângulo em qualquer lugar da página e grave apenas essa área.
- **Imagem sempre limpa**: todos os controles ficam no popup do ícone da extensão (uma página de extensão independente que não faz parte da renderização da aba capturada), portanto nenhuma interface da extensão pode aparecer no vídeo.
- **Atalho de página**: a tecla única padrão `R` inicia a gravação em repouso e a interrompe/salva durante a gravação. Pode ser alterada livremente no popup → **Configurações** (combinações com `Ctrl` / `Alt` / `Shift` / `Command`). Só atua em páginas do YouTube, não rouba teclas de outras abas e nunca conflita com atalhos globais do navegador.
- **Página bloqueada durante a gravação**: uma máscara translúcida cobre tudo o que está *fora* da imagem, com um «buraco» recortado para ela, bloqueando rolagem, cliques e atalhos destrutivos — enquanto **reproduzir/pausa, busca, volume, legendas e velocidade continuam totalmente utilizáveis**.
- **Recorte estável**: saída fixa em 30 fps; o tamanho do canvas é travado no primeiro quadro; o retângulo de recorte precisa ficar estável por 3 quadros consecutivos antes de iniciar, para que nenhum retângulo transitório grande demais (anúncios, troca para o modo cinema) acabe no vídeo final.
- **Áudio nunca perdido**: a faixa de áudio capturada é reproduzida por um `AudioContext`, evitando que a aba seja silenciada e gere um vídeo sem som.
- **Fallbacks robustos**: detecção de quadro preto por DRM, parada e exportação automáticas ao trocar de aba ou navegar, autorrecuperação quando o heartbeat do retângulo falha, nova tentativa automática de download e a saída de emergência «Redefinir à força e recomeçar».
- **A gravação só é iniciada por um clique do usuário** — nunca há captura silenciosa em segundo plano.

## Estrutura do projeto

```
DESIGN.md                    Documento de design técnico (capacidades / arquitetura / protocolo de mensagens / casos limite / fluxo de dados)
TODO.md                      Lista de tarefas de desenvolvimento (marcar na aceitação)
src/
├── manifest.json            Manifesto MV3 (tabCapture + downloads + activeTab + offscreen + storage)
├── background.js            Service Worker: ciclo de vida do offscreen, roteamento de mensagens, estado global e badge, proxy de download
├── offscreen.html           Host do documento offscreen
├── offscreen.js             Núcleo da gravação: getUserMedia(stream da aba) → video oculto → recorte em canvas → MediaRecorder → Blob
├── shared/
│   └── hotkey.js            Definição compartilhada do atalho «iniciar / parar gravação» (configurações do popup, dica e listener de conteúdo)
├── content/
│   ├── guard.js             Máscara de bloqueio da página durante a gravação (buraco ajustado à imagem; existe apenas durante uma sessão)
│   ├── selector.js          Sobreposição de seleção de região (ativada sob demanda após clicar em «Gravar região»)
│   ├── content.js           Script sem interface: heartbeat do retângulo do player + avisos de ocultação/navegação + ligar/desligar máscara
│   └── hotkey.js            Listener do atalho «iniciar / parar gravação» em nível de página
├── popup.html               Popup do ícone: console de gravação (iniciar / região / parar / status / cronômetro / dicas / configurações)
├── popup.js
├── popup/
│   └── settings.js          Modal de configurações (ativar atalho, captura de tecla, avisos de conflito)
├── assets/                  Recursos estáticos
├── icons/                   Ícones 16/32/48/128
└── types/                   Declarações de tipos da API chrome.* (somente tipos)
scripts/verify_extension.py  Script de autoverificação estática
```

## Por que um documento offscreen?

`chrome.tabCapture` não pode ser chamado a partir de um content script, enquanto o pipeline `video` / `canvas` / `MediaRecorder` exige um contexto de janela com DOM. Um popup fecha assim que perde o foco e um Service Worker não tem DOM algum; por isso o núcleo da gravação fica em um **documento offscreen**:

1. O **content script** (não injeta interface; apenas reporta dados) localiza o player a cada ~120 ms e envia o retângulo real da imagem junto com a base do viewport (tamanho CSS, `devicePixelRatio`, deslocamento do visual viewport).
2. O **background** cria o documento offscreen sob demanda e chama `chrome.tabCapture.getMediaStreamId()` dentro da cadeia do gesto do usuário para obter um `streamId`.
3. O documento **offscreen** consome o stream completo da aba via `getUserMedia({ chromeMediaSourceId: streamId })` (vídeo + áudio da página).
4. Dentro do **offscreen**: um `video` oculto reproduz o stream da aba → um `canvas` oculto recorta quadro a quadro com `drawImage` → a faixa de vídeo de `canvas.captureStream(30)` é unida ao `audioTrack` original → `MediaRecorder` grava (`video/mp4` primeiro, com fallback progressivo para `video/webm`) → os fragmentos são montados em um Blob.
   - A conversão de coordenadas usa uma **proporção medida** («tamanho do quadro capturado ÷ tamanho CSS do viewport», com modelo contain e preenchimento centralizado) em vez de um simples `rect × devicePixelRatio`, o que elimina deslocamentos em telas HiDPI e com zoom.
5. O documento offscreen **não pode** chamar `chrome.downloads` diretamente: ele envia `DOWNLOAD_FILE` ao **background**, que executa o download e informa o resultado via `downloads.onChanged`.

Veja `DESIGN.md` para mais detalhes.

## Carregar (desenvolvimento)

1. Abra o Chrome e acesse `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** no canto superior direito.
3. Clique em **Carregar sem compactação** e selecione o diretório `src/` deste repositório (sem etapa de build, nada a compilar).

> Requisitos: Chrome ≥ 116 (`minimum_chrome_version`, necessário para `chrome.offscreen`); a saída MP4 nativa exige Chrome ≥ 126. Recomenda-se a última versão estável.

## Como usar

1. Abra qualquer **página de reprodução do YouTube** (vídeos públicos; vídeos com DRM ou exclusivos para membros são gravados em preto — uma restrição de proteção do navegador).
2. Clique no ícone da extensão → clique em **Iniciar gravação** no popup (mantenha a aba visível e o player totalmente dentro do viewport).
   - Se o navegador/sistema não consegue gerar MP4 nativo (Chrome < 126 ou sem codificadores H.264/AAC), o popup informa que esta sessão usará WebM.
   - Durante a gravação, o ícone exibe um badge vermelho `REC`. Fechar o popup não interrompe a gravação: basta clicar no ícone novamente.
3. **Gravar região** (opcional): clique em **Gravar região** → o popup fecha → arraste um retângulo na página → clique em **Gravar seleção** (`Esc` sai do seletor).
   - Durante a gravação, o botão **Parar** é posicionado automaticamente *fora* da seleção para nunca aparecer no vídeo. Se a seleção ocupar quase todo o viewport e não houver espaço, os controles na página são ocultados: pare pelo popup ou pelo atalho.
4. Ao terminar, clique em **Parar e salvar** → o arquivo é montado e baixado como `YouTube-AAAAMMDD-HHMMSS.mp4` (`.webm` em ambientes de fallback).
5. **Atalho**: pressione a tecla padrão `R` em uma página do YouTube para iniciar; pressione novamente para parar e salvar.
   - Clique em **Configurações** no canto superior direito do popup para alterá-lo: clique na caixa de tecla e pressione a nova combinação; `Esc` cancela. As alterações valem na hora, sem recarregar a página.
   - O atalho só dispara quando uma página do YouTube está em foco e nunca dentro de campos de entrada como busca ou comentários. Conflitos com atalhos do navegador ou do player são avisados no painel de configurações.
6. **Ajuste fino da imagem** (seção dobrável no fim do popup): em configurações incomuns (zoom atípico, monitores com DPI misto) pode restar um pequeno deslocamento fixo — informe valores em pixels verticais / horizontais (positivo = para baixo / direita).
7. **A página fica bloqueada por uma máscara durante a gravação** (modo player completo):
   - Tudo fora da imagem é coberto por preto translúcido: botões e links não são clicáveis, roda do mouse e rolagem por toque são bloqueados e a posição de rolagem fica fixa.
   - **Permitido**: reproduzir/pausa, busca, volume, legendas e velocidade: tudo o que é puro controle de reprodução.
   - **Bloqueado**: teclas de rolagem (Espaço, Page Up/Down, Home/End, setas Cima/Baixo), tela cheia `f`, modo cinema `t`, miniplayer `i`, mudo `m` e duplo clique na imagem: ações que mudam o layout ou silenciam a faixa de áudio.
   - A máscara tem um buraco para a imagem, portanto não cobre nada do que está sendo gravado e **nunca aparece na saída**; abaixo da imagem (acima, se faltar espaço) é exibido «Gravando · página bloqueada».
   - O redimensionamento da janela do navegador não pode ser impedido por uma página web: ao detectar mudança no viewport, a máscara mostra um aviso e o popup sugere gravar novamente (o recorte pode ter se deslocado).
8. Após parar, a máscara é removida automaticamente e a página volta ao normal, sem nós ou listeners residuais.

### Formatos de saída

| Ambiente | Saída |
| --- | --- |
| Chrome ≥ 126 com codificadores H.264/AAC (ex.: Chrome recente no Windows / macOS) | **MP4** (H.264 + AAC, `.mp4`) |
| Chrome < 126 | WebM (`.webm`) — o popup explica o motivo |
| Chrome ≥ 126, mas plataforma sem codificadores (alguns builds de Linux) | WebM (`.webm`) — o popup explica o motivo |

> Nenhuma recodificação é feita: quando o MP4 está disponível, ele é gravado nativamente pelo `MediaRecorder` (sem espera e sem perda de qualidade); caso contrário, cai-se para WebM.

### Permissões

| Permissão | Uso |
| --- | --- |
| `tabCapture` | Permissão restrita; captura imagem e áudio da aba atual após um clique do usuário |
| `downloads` | Salva a gravação na pasta de downloads local |
| `activeTab` | Acesso temporário à aba atual concedido ao clicar no ícone |
| `offscreen` | Cria o documento offscreen que hospeda captura / recorte / gravação |
| `storage` | `session` guarda o estado da gravação e a intenção de início; `sync` guarda o atalho e o ajuste de imagem |

Sem `host_permissions`, sem requisições de rede e sem coleta de dados do usuário.

## Autoverificação estática

```bash
python3 scripts/verify_extension.py
```

Cobre: manifesto / MV3 / arquivos obrigatórios, padrões restritos ao YouTube e ordem de injeção, permissões mínimas, zero dependências de terceiros, sintaxe JS de todos os arquivos (`node --check`), limites de contexto de API (content scripts não devem chamar `tabCapture` / `downloads` / `offscreen` diretamente), limites de injeção na página (os controles devem ficar no popup; `content/guard.js` é o único módulo autorizado a criar DOM e precisa recortar um buraco para a imagem, deixá-lo vazio e poder ser removido a cada sessão) e limites do módulo de atalho.

## Lista de aceitação manual (tarefa 20 do `TODO.md`)

Após carregar e usar a extensão conforme descrito acima, verifique cada item:

- [ ] 20.1 O popup abre corretamente: status / cronômetro / botões mudam conforme a fase; o ícone exibe um badge vermelho `REC` durante a gravação.
- [ ] 20.2 Clique em **Iniciar gravação** → captura bem-sucedida (status «Gravando» + cronômetro ativo) → clique em **Parar e salvar** → um mp4 é baixado (sem MP4 nativo, o popup avisa e um webm é baixado).
- [ ] 20.3 Abra a saída com um player do sistema ou com o Chrome: a imagem é a área recortada do player, há áudio e a reprodução funciona.
- [ ] 20.4 Em telas HiDPI (DPR ≠ 1, por exemplo Retina) a imagem não se desloca nem desalinha.
- [ ] 20.5 Trocar de aba durante a gravação: o popup avisa que a captura pode ser interrompida; ao voltar, continua ou para e exporta automaticamente, sem erros.
- [ ] 20.6 Alternar tela cheia ou zoom do navegador durante a gravação: a área de recorte acompanha corretamente.
- [ ] 20.7 Os casos de erro são informados corretamente: página que não é de reprodução (botão iniciar desativado), vídeo DRM (aviso após ~2,6 s), captura negada etc.
- [ ] 20.8 Após o término (incluindo erros): nenhum ponto vermelho de gravação na barra de endereço, nenhum nó residual da extensão, nenhum erro repetido.
- [ ] 20.9 No Chrome < 126 ou em plataforma sem H.264/AAC: o popup informa «MP4 nativo não suportado, será gerado WebM» e a gravação continua funcionando.
- [ ] 20.10 A saída não contém controles da extensão (sem botões, modais ou toasts).
- [ ] 20.11 A saída não contém a máscara de bloqueio (sem bordas escuras ou textos de aviso).
- [ ] 20.12 Durante a gravação a página fica bloqueada: botões e links não são clicáveis, roda do mouse e atalhos não funcionam e a página não rola; mas reproduzir/pausa, busca e volume funcionam.
- [ ] 20.13 Redimensionar a janela durante a gravação: a máscara avisa, o popup é notificado e a máscara recorta o buraco novamente sem cobrir a imagem.
- [ ] 20.14 Após parar e salvar, a máscara desaparece, a página volta a ser interativa e não restam nós `yr-guard-`.
- [ ] 20.15 Gravar região: arraste uma seleção → **Gravar seleção** → a saída contém apenas a área escolhida e nenhum botão na página como Iniciar / Parar.

Quando tudo passar, marque os itens da tarefa 20 no `TODO.md`.
