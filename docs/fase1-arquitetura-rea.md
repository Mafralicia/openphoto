# OpenPhoto: Fase 1, análise REA e arquitetura

> Este é um documento de arquitetura e não contém código de aplicação. O DDL SQL faz parte da especificação.
> Valores marcados como **(NV)** (não verificado) são estimativas ou vêm de uma fonte só. Eles precisam ser medidos no spike do M1 antes de virar compromisso.
> Processo: 4 pesquisas em paralelo (Apple Photos, Google Photos, stack/I-O, banco/geo), depois um rascunho e uma revisão adversarial. Este texto já incorpora as correções da revisão.

---

## 0. Resumo executivo

- **Stack:** Tauri 2 com núcleo em Rust (crate `core`, que não depende da UI), WebView2 no Windows, Solid na UI, MapLibre GL JS v5 para o mapa 2D e o globo, e PMTiles/Protomaps para mapas offline.
- **Cold start:** o grid é desenhado só com a **contagem** que sai da enumeração do diretório. As células recebem primeiro a **thumbnail que já vem embutida** no EXIF/RAW, lida dos primeiros 64 KB do arquivo. A thumbnail definitiva de 384 px é gerada depois, em segundo plano.
- **Warm start:** uma query só de índice traz `id, w, h, orientação, gen`. As thumbnails saem em lote de um banco de blobs SQLite, o `thumbs.db`.
- **Filtros:** varredura colunar em memória, com os arrays ordenados por data. Assim nenhuma combinação de filtros precisa de índice composto. Bitmaps roaring entram só se o benchmark mostrar que fazem falta.
- **Mapa:** o bbox é filtrado por varredura linear nas colunas lat/lon em memória. Os clusters saem de um hash por célula Web-Mercator, feito no Rust sobre o conjunto **já filtrado**, e o mapa recebe menos de 2 mil features.
- **Escrita nos originais:** nenhuma, o app só lê. O catálogo é um cache reconstruível até existir o primeiro dado criado pelo usuário, como rating manual ou álbuns.

---

## 1. Decomposição dos sistemas de referência

### 1.1 Apple Photos

| Aspecto | Como funciona |
|---|---|
| **Ingestão** | Importa ou referencia o original, grava os metadados em três tabelas 1:1 e só depois gera a pirâmide de thumbnails. A análise pesada (cenas, rostos, OCR) roda em daemons (`photoanalysisd`/`mediaanalysisd`) com a máquina ociosa ou na tomada, e cada modelo tem uma coluna de versão por asset. As três tabelas: `ZASSET` é a quente e estreita (datas, dimensões, flags, lat/lon, `ZTHUMBNAILINDEX`). `ZEXTENDEDATTRIBUTES` guarda o EXIF. `ZADDITIONALASSETATTRIBUTES` é a fria (nome original, fuso, geocodificação reversa). |
| **Pirâmide** | Arquivos `.ithmb` sem cabeçalho, com **slots de tamanho fixo**: `offset = ZTHUMBNAILINDEX × slot`. O payload é BC7 (nativo da GPU, já orientado) com um trailer de 28 B. Os slots são quadrados com padding: slot = lado² + 28 B. Exemplos: 64 → 4.124 B, 120 → 14.428 B **(NV, fonte única, macOS 26)**. A query do grid já devolve o endereço da thumbnail, então não há `open`/`stat` por célula. Assets sem thumbnail ficam com `ZTHUMBNAILINDEX = -1` e entram numa fila que é um **índice parcial** (`WHERE ZTHUMBNAILINDEX = -1`). |
| **Cold start** | **Não existe cold start de pasta**: tudo é pré-computado na importação. Na UI, o PhotoKit faz entrega *oportunista*: primeiro uma imagem degradada no mesmo frame, depois a de alta qualidade. O preheat cobre ±0,5 viewport, com histerese de 1/3 e diff de retângulos. O grid é quadrado (smart crop), então o layout só precisa da contagem. |
| **Índices** | Um índice de cobertura por tela da UI (ex.: `Z_Asset_forAllPhotos(ZDATECREATED, …flags)`). O grid vira um scan só de índice. |
| **Geo** | Uma R-tree no Core Data (`Z_RT_Asset_boundedByRect`), geocodificação reversa em cache por asset e centróide pré-computado por "momento". Anos/Meses/Dias saem de uma hierarquia **materializada**, com contagens e capa prontas. Se o Places usa `MKClusterAnnotation` ou um clusterer próprio é (NV). |

### 1.2 Google Photos

| Aspecto | Como funciona |
|---|---|
| **Ingestão** | No Android quem mantém o índice é o sistema (MediaStore). O app só consulta, e o sync incremental usa um **contador de geração** (`GENERATION_MODIFIED > último_visto`), não o mtime. O Google nunca encara uma pasta que não esteja indexada. **No desktop esse "MediaStore" é o que nós vamos construir.** |
| **Grid web** | Hierarquia **seção (mês) → segmento (dia) → tile**, em `position:absolute`. Primeiro chega só a lista de seções com contagens (~120 entradas para 10 anos). A altura é estimada com proporção 3:2, então a scrollbar já tem o tamanho certo antes dos dados. Quando a altura real chega, as seções seguintes andam e o scrollTop é corrigido pelo delta. O layout justificado (estilo Knuth-Plass) roda só nas seções visíveis, e o DOM mantém ~50 fotos **(NV, fonte secundária)**. |
| **Cold start** | Placeholder minúsculo, sem blur e com `image-rendering: pixelated`. Prefetch direcional e fade de ~100 ms. No viewer, a thumbnail já carregada é ampliada imediatamente e a imagem cheia entra por cross-fade. |
| **Scrubber** | Busca binária sobre as somas de prefixo das alturas das seções. Não toca nos itens, então 1M custa o mesmo que 1k. |
| **Thumbnails** | Derivadas sob demanda, com chave (id, tamanho, crop): `=w256-h256-c`. |
| **Geo/busca** | Heatmap e uma bottom sheet com as fotos da área visível. A busca é ML no servidor, e **quase não há filtros por EXIF** (câmera, lente, ISO). Essa é a nossa brecha de diferenciação. |

### 1.3 O que copiamos e o que descartamos

| Copiamos | Descartamos (motivo) |
|---|---|
| Entrega oportunista: o tier disponível aparece no mesmo frame e o melhor substitui depois (Apple) | Pré-computar tudo na importação como **única** estratégia, porque não atende pasta cold |
| Grid quadrado em pasta cold, em que o layout só precisa da contagem (Apple) | Layout justificado em pasta cold, porque exige dimensões que ainda não temos |
| Preheat de ±0,5 viewport com histerese e diff de faixas (Apple) | BC7 / `.ithmb` como formato principal, porque o `<img>` do webview não usa BC7. Volta a ser opção se o grid migrar para WebGL |
| Esqueleto feito só de contagens, com correção por delta e scrubber por somas de prefixo (Google) | Daemons e XPC separados. Um processo Rust com um único escritor basta |
| Separar tabela quente / EXIF / fria, e um índice de cobertura por tela (Apple) | Hierarquia materializada (`ZPHOTOSHIGHLIGHT`/`day_summary`), porque ignora os filtros ativos. Calculamos em memória |
| Índice parcial como fila de trabalho (`WHERE meta_state < 2`) (Apple) | Índices compostos por combinação de filtro. A varredura colunar em memória os torna desnecessários |
| Contador de geração para sync incremental e para versionar URLs (MediaStore) | CDN, URLs assinadas, ML no servidor e fusão com Location History |
| Placeholder pixelado e minúsculo (ThumbHash de ~25 B) (Google) | Índice mantido pelo SO, que no desktop não existe |
| Análise pesada versionada por modelo, rodando só ociosa ou na tomada (Apple), na Fase 2 | — |

**O que muda em relação às referências:** as duas resolvem o cold start não tendo cold start. A nossa resposta é usar o que o arquivo já traz pronto, que é a thumbnail embutida no EXIF/RAW. Ela é o "tier degradado" da entrega oportunista e custa um read de 64 KB.

---

## 2. Arquitetura local

### 2.1 Stack e justificativa

| Camada | Escolha | Por que vence o gargalo |
|---|---|---|
| Shell/UI | **Tauri 2** (fixar a última 2.x no início do M1) + **Solid** | O WebView2 decodifica imagem fora da main thread do JS. O instalador é pequeno. O núcleo Rust fica isolado da UI. |
| Enumeração | `GetFileInformationByHandleEx(FileIdExtdDirectoryInfo)` com buffer de 256 KB–1 MB, num handle aberto com `FILE_LIST_DIRECTORY \| FILE_FLAG_BACKUP_SEMANTICS` (crate `windows`) | Uma chamada devolve FileId de 128 bits, tamanho, datas, atributos e o `ReparsePointTag`. **Nenhum stat por arquivo**: ~700k entradas/s contra ~16k/s com stat (cache quente, NV). No SMB, se essa classe for rejeitada, cai para `FileIdBothDirectoryInfo`. Não usamos `std::fs::read_dir`, porque ele não traz o FileId. |
| I/O de arquivo | Pool de threads **bloqueantes** por classe de volume. Profundidade de fila: SSD 32, HDD 4 (NCQ), rede 4. O tokio fica só na orquestração e no IPC | Não há I/O assíncrono de arquivo portável, e `tokio::fs` é `spawn_blocking` de qualquer jeito. |
| EXIF/RAW | `nom-exif` 3.x (JPEG, HEIC, CR3, RAF, MP4/MOV) mais um parser próprio de IFD TIFF / caixas ISOBMFF para localizar o preview embutido. O EXIF é parseado **na própria thread de I/O** | 10–50 µs por arquivo, então mandar para outro pool custaria mais do que o parse. Lemos 64 KB do cabeçalho e, se preciso, um range-read do JPEG embutido. O RAW nunca é lido inteiro. |
| Decode/resize | `turbojpeg` (libjpeg-turbo 3, escala DCT de 1/2 a 1/8) + `fast_image_resize` (AVX2/NEON), num **pool rayon dedicado** limitado a N/2 threads | Um decode a 1/8 de 24 MP leva ~20–30 ms (NV). O pool separado impede que o P0 fique na fila atrás desse trabalho. |
| Banco | `rusqlite` (bundled, com FTS5 e RTREE) em WAL. Uma thread escritora por arquivo de banco e conexões de leitura por thread (`query_only`) | Leitores nunca bloqueiam o escritor. |
| Filtros | Struct-of-arrays em memória, ordenado por data | Uma passada sobre ~30 MB com 1M de assets entrega os ids filtrados e todas as facetas. |
| Mapa | **MapLibre GL JS v5** (projeção globo) + **PMTiles/Protomaps** locais | É 100% offline e usa o mesmo motor para 2D e globo. |
| Transporte de thumbnails | Esquema customizado assíncrono (`register_asynchronous_uri_scheme_protocol`). **No Windows a URL é `http://thumb.localhost/<id>-<gen>`** (no macOS/Linux, `thumb://`) | Sem base64 e sem RGBA trafegando pelo IPC. O JPEG vai cru e o Chromium faz o decode. |

**Alternativas avaliadas:**
- **Electron + napi-rs.** Teria o mesmo Chromium em todos os sistemas, mas o instalador passa de 100 MB. Fica como **plano B**, caso o WebKitGTK (Linux) ou o WKWebView (limite de 60 Hz no rAF em telas ProMotion, NV) não passem no gate.
- **egui/iced + wgpu nativo.** Não tem IPC e aceita BC7 direto na GPU. Por outro lado, não existe nada maduro equivalente ao MapLibre com globo, e texto, IME e acessibilidade são mais fracos. Como o núcleo é uma crate separada, essa porta continua aberta.
- **Qt 6 / WinUI / SwiftUI.** O Qt é o mais lento de desenvolver. WinUI e SwiftUI exigiriam duas bases de código.

**Gate de decisão (semana 1 do M1).** Rodamos um spike de fling por 50k tiles a 120 Hz no WebView2 e comparamos duas formas de entregar as imagens:
- **(a)** um `<img>` por tile, servido pelo esquema customizado;
- **(b)** um endpoint em lote: um worker busca 32–64 JPEGs por resposta, chama `createImageBitmap` e desenha num `<canvas>`.

O critério é perder no máximo 1% dos frames e não ter nenhuma long task acima de 16 ms. Se as duas reprovarem, o grid passa a ser um canvas WebGL2 com atlas. O framework só muda se isso também falhar.

### 2.2 Orçamento de latência (< 100 ms)

**Definição de "first render" (cold).** É o tempo entre o clique e o frame em que duas coisas valem:
- **(a)** o grid está pintado, com um tile por entrada enumerada até aquele momento, e a scrollbar reflete essa contagem (ela pode crescer até a enumeração terminar);
- **(b)** pelo menos 90% dos tiles visíveis mostram alguma imagem, de qualquer tier. A thumbnail embutida de ~160 px conta como tier degradado.

**Protocolo de medição:**
- limpar a standby list (`RAMMap -Et`) antes de cada execução;
- **Defender ligado**;
- medir em 1080p (~60 tiles) e em 4K DPR 1,5 (~150–300 tiles);
- reportar p50 e p95 por classe de mídia.

**Fora do escopo:** o requisito vale para abrir uma pasta com o app já aberto. O tempo de abrir o processo até a primeira pintura do WebView2 é outro orçamento, estimado em 300–800 ms (NV).

**Cold: pasta nunca vista, 30k JPEG/RAW, NVMe**

| # | Etapa | ms | Nota |
|---|---|---|---|
| 1 | Clique → `invoke` → Rust | 1–2 | (NV) |
| 2 | Abrir o handle do diretório e fazer a 1ª chamada de enumeração (~2–8k entradas) | 2–10 | Frio. Filtramos por extensão e agrupamos pilhas (RAW+JPG) pelo nome-base |
| 3 | Restante da enumeração, **concorrente** com a etapa 5 | 20–80 | Um handle é sequencial e não dá para paralelizar. Deadline de 40 ms (regra abaixo) |
| 4 | Ordenação natural dos nomes, se a enumeração terminar antes do deadline | 2–5 | |
| 5 | Mensagem no Channel `{count_so_far}` → pintura do esqueleto | 8–16 | Só a contagem. Os nomes e os ids vão depois, em chunks binários |
| 6 | Leitura de 64 KB dos ~60 arquivos visíveis, 32 em voo, do centro do viewport para fora | 5–20 | **+ custo do Defender por primeira abertura (NV, de 0,1 a 5 ms por arquivo)** |
| 7 | Parse do IFD na thread de I/O | 1–3 | |
| 8 | Range-read extra para RAW cujo preview fica fora dos 64 KB | 0–10 | |
| 9 | Envio dos bytes: JPEG passa direto; strip RGB é codificado em JPEG (sub-ms) | 5–15 | **Custo por requisição do esquema no WebView2 (NV)** |
| 10 | Decode no Chromium + composição | 8–16 | |
| | **Esqueleto** | **~15–50** | |
| | **Imagens do viewport** | **~60–120 (p95)** | Os 100 ms se sustentam **somente** se os dois itens em negrito forem pequenos |

**Regra de ordenação em pasta cold:**
- A pasta é sempre exibida em ordem natural do nome, sem diferenciar maiúsculas.
- Se a enumeração terminar em até 40 ms, ordenamos e pintamos uma vez só.
- Se não terminar, pintamos o primeiro lote na ordem em que o sistema de arquivos devolveu e seguimos em streaming. No NTFS essa ordem já é por nome, o que bate com nomes de câmera com zeros à esquerda. No exFAT/FAT ela segue a criação, o que é aproximadamente a ordem dos cliques.
- Quando a enumeração termina, reordenamos **só se o usuário ainda não rolou**.
- A ordem por data fica na Timeline, não na visão de pasta.

**Warm: pasta já indexada**

| # | Etapa | ms |
|---|---|---|
| 1 | `invoke` | 1–2 |
| 2 | Scan só de índice em `ix_assets_folder_name` (30k × id, w, h, orient, kind, gen, stack) | 5–10 (NV) |
| 3 | Transferência binária de ~360 KB | 2–7 |
| 4 | Layout | 1–3 |
| 5 | `SELECT … FROM t2 WHERE asset_id IN (~200)` no `thumbs.db` | 2–6 (NV) |
| 6 | Transporte + decode de 384 px em paralelo + pintura | 15–30 |
| | **Total** | **~30–60** |

**Limites honestos por tipo de mídia** (todos NV, a confirmar no spike):

| Mídia | Esqueleto | Imagens do viewport |
|---|---|---|
| SSD/NVMe, arquivos com thumbnail embutida | ≤ 50 ms | 60–120 ms (SATA: +30–50%) |
| SSD, arquivos **sem** thumbnail embutida (PNG, exports, prints de tela, WhatsApp) | ≤ 50 ms | 150–400 ms. O tile fica neutro e recebe um decode a 1/8 em P0, do centro para fora |
| HDD local | 20–100 ms (sem contar um spin-up de 3–10 s) | 0,5–1,5 s |
| SMB 1 GbE, NAS com SSD ou cache quente | 10–60 ms | 100–300 ms |
| SMB com HDD frio ou Wi-Fi | 50–500 ms | 0,5–3 s. A promessa vira "nunca trava, carrega progressivamente" |
| OneDrive/Dropbox/iCloud desidratado | ≤ 50 ms (o placeholder é uma entrada local do NTFS) | Imediato se já estiver no thumbcache do Windows. Caso contrário nunca, sem rede e sem ação explícita |

### 2.3 Modelagem do banco

Os arquivos ficam em `%LOCALAPPDATA%\OpenPhoto\`, **nunca dentro do OneDrive**:
- `library.db`: o catálogo;
- `thumbs.db`: um cache de blobs. Apagar esse arquivo equivale a limpar o cache.

```sql
-- ===== library.db =====
-- Uma vez:
PRAGMA page_size = 4096;              -- testar 8192 no M1
PRAGMA journal_mode = WAL;
PRAGMA user_version = 1;              -- divergente antes da 1.0 → apagar e reconstruir
-- Toda conexão:
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -65536;           -- 64 MiB
PRAGMA temp_store = MEMORY;
PRAGMA journal_size_limit = 67108864;
PRAGMA optimize = 0x10002;            -- na abertura de conexões de vida longa
-- Leitores: PRAGMA query_only = 1. Nunca segurar transação de leitura entre frames (o WAL cresce sem limite).
-- Sem mmap_size: no Windows, um erro de I/O sob mmap vira access violation.

CREATE TABLE volumes (
  id     INTEGER PRIMARY KEY,
  key    TEXT NOT NULL UNIQUE,         -- '\\?\Volume{GUID}\' local | '\\server\share' SMB | UUID no macOS/Linux
  serial INTEGER,                      -- FILE_ID_INFO.VolumeSerialNumber, só informativo
  fs     TEXT NOT NULL,                -- NTFS/ReFS/exFAT/FAT32/SMB… file_id só é confiável em NTFS/ReFS/APFS/ext4/btrfs
  kind   INTEGER NOT NULL,             -- 0 ssd | 1 hdd | 2 rede/removível/virtual
  mount  TEXT NOT NULL                 -- letra/ponto visto por último (pode mudar)
);

CREATE TABLE folders (
  id           INTEGER PRIMARY KEY,
  volume_id    INTEGER NOT NULL REFERENCES volumes(id),
  parent_id    INTEGER REFERENCES folders(id),
  path_key     TEXT NOT NULL UNIQUE,   -- NFC, '/', casefold no Windows, terminando em '/'
  display_path TEXT NOT NULL,
  name         TEXT NOT NULL,
  depth        INTEGER NOT NULL,
  is_root      INTEGER NOT NULL DEFAULT 0,  -- raiz da biblioteca: só aqui há indexação em background
  dir_mtime_ns INTEGER,
  scan_state   INTEGER NOT NULL DEFAULT 0,  -- 0 nunca | 1 enumerado | 2 exif | 3 thumbs
  asset_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_folders_parent ON folders(parent_id, name);
-- Subárvore: path_key >= '/a/b/' AND path_key < '/a/b0'   ('0' é o caractere seguinte a '/')

CREATE TABLE cameras (id INTEGER PRIMARY KEY, make TEXT NOT NULL, model TEXT NOT NULL,
                      display_name TEXT, UNIQUE(make, model));
CREATE TABLE lenses  (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT);
CREATE TABLE formats (id INTEGER PRIMARY KEY, ext TEXT NOT NULL UNIQUE,
                      kind INTEGER NOT NULL, webview_native INTEGER NOT NULL);

CREATE TABLE assets (                  -- ~250 B por linha → ~250 MB por 1M
  id            INTEGER PRIMARY KEY,   -- rowid denso, vira u32 nos arrays em memória
  folder_id     INTEGER NOT NULL REFERENCES folders(id),
  file_name     TEXT NOT NULL,
  name_key      TEXT NOT NULL,         -- casefold + sem diacríticos + dígitos com padding de 10 (IMG_2 < IMG_10; ç ≈ c)
  file_id       BLOB,                  -- FILE_ID_128 / inode
  size          INTEGER NOT NULL,
  mtime_ns      INTEGER NOT NULL,
  gen           INTEGER NOT NULL DEFAULT 0,  -- ++ ao mudar size/mtime; entra na URL da thumbnail
  quick_hash    BLOB,                  -- xxh3-128(size ‖ 64 KB iniciais ‖ 64 KB finais)
  full_hash     BLOB,                  -- só em colisão de size+quick_hash; nunca em placeholder de nuvem
  kind          INTEGER NOT NULL,      -- 0 foto | 1 raw | 2 vídeo | 3 live/motion
  format_id     INTEGER NOT NULL REFERENCES formats(id),
  stack_id      INTEGER,               -- id do representante (RAW+JPG, Live Photo); NULL = sozinho
  attrs         INTEGER NOT NULL DEFAULT 0,  -- bits: 1 placeholder de nuvem | 2 volume offline | 4 oculto | 8 ausente
  missing_since INTEGER,               -- purga após 30 dias
  meta_state    INTEGER NOT NULL DEFAULT 0,  -- 0 stub | 1 exif | 2 thumb L2 pronto | 3 erro (chave: size+mtime)
  width INTEGER, height INTEGER,       -- já orientados (trocados para orientações 5–8)
  orientation   INTEGER,
  taken_local_ms INTEGER,              -- relógio da câmera tratado como UTC (chave de ordenação)
  tz_offset_min INTEGER,               -- OffsetTimeOriginal; NULL = desconhecido
  date_source   INTEGER,               -- 0 exif | 1 quicktime | 2 nome do arquivo | 3 mtime
  camera_id     INTEGER REFERENCES cameras(id),
  lens_id       INTEGER REFERENCES lenses(id),
  iso INTEGER, fnum_x100 INTEGER, exposure_us INTEGER, focal_x10 INTEGER, focal35 INTEGER,
  duration_ms   INTEGER,
  lat REAL, lon REAL,
  place_id      INTEGER,               -- M4
  rating        INTEGER,               -- lido do XMP (sidecar ou embutido)
  thumbhash     BLOB,                  -- ~25 B
  embed_off INTEGER, embed_len INTEGER, embed_w INTEGER, embed_h INTEGER, -- maior JPEG embutido no original
  embed_codec   INTEGER                -- 0 jpeg | 1 strip RGB
);

-- Abrir pasta = scan só de índice (o rowid já entra no índice; não repetir id)
CREATE INDEX ix_assets_folder_name ON assets(folder_id, name_key,
  width, height, orientation, kind, gen, stack_id);
CREATE UNIQUE INDEX ux_assets_folder_file ON assets(folder_id, file_name);         -- diff de rescan
CREATE INDEX ix_assets_quickhash ON assets(quick_hash) WHERE quick_hash IS NOT NULL; -- move entre volumes
CREATE INDEX ix_assets_fileid    ON assets(file_id)    WHERE file_id IS NOT NULL;    -- rename no volume
CREATE INDEX ix_assets_pending   ON assets(folder_id, meta_state) WHERE meta_state < 2; -- fila de trabalho

-- Geo persistente (requisito R-Tree; atende consultas SQL do tipo "perto de X"). Graus × 1e7.
CREATE VIRTUAL TABLE asset_geo USING rtree_i32(id, min_lat, max_lat, min_lon, max_lon);

-- M3: busca textual (nome + pasta + local + palavras-chave XMP)
CREATE VIRTUAL TABLE asset_fts USING fts5(text, content='', contentless_delete=1,
  tokenize='trigram remove_diacritics 1');   -- SQLite ≥ 3.45 (NV); < 3 caracteres → LIKE na lista em memória

-- M4: geocodificação reversa offline (GeoNames cities500, CC-BY 4.0 → exige atribuição)
CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT NOT NULL, admin1 TEXT, admin2 TEXT,
                     country_code TEXT, lat REAL, lon REAL, population INTEGER);

-- ===== thumbs.db (arquivo próprio, WAL próprio, thread escritora própria) =====
CREATE TABLE t2 (asset_id INTEGER PRIMARY KEY, gen INTEGER NOT NULL,
                 w INTEGER NOT NULL, h INTEGER NOT NULL, jpeg BLOB NOT NULL);
-- Ordem de escrita: primeiro o blob no thumbs.db, depois meta_state=2 no library.db.
-- Um crash entre os dois deixa um órfão ou força uma regeneração; os dois casos são inofensivos.
-- Varredura de órfãos via ATTACH quando ocioso. Não depender de atomicidade entre arquivos.
```

**Fora do SQL: o índice de filtro em memória.**
- Struct-of-arrays em ordem de data: `camera u16, lens u16, iso u16, fnum u16, exp u32, focal u16, format u8, kind u8, folder u32, rating u8, lat i32, lon i32, date i64`. Novos itens vão para uma cauda pequena, fora de ordem.
- **Uma passada** produz os ids ordenados e todas as contagens de faceta. Com 1M de linhas, são alguns ms (NV).
- O array é reconstruído (ordenar e copiar, ≤ 100 ms) em background depois de 1 s sem ingestão.
- Anos/Meses/Dias saem da coluna de data **respeitando o filtro ativo**, em ~1–3 ms (NV).
- Nada de `OFFSET`: o grid recebe a lista de ids (4 MB por 1M) e pede ao SQLite só os ~200 visíveis.
- **Gatilho para trocar por bitmaps roaring:** o benchmark do M3 passar de 30 ms p95 com 1M de assets.

### 2.4 Cache em RAM e disco

| Nível | Onde | O quê | Orçamento | Eviction / validade |
|---|---|---|---|---|
| **L0** | Webview | Imagens decodificadas pelo Chromium (**fora do nosso controle**). Nós controlamos só o *pool de tiles*: os visíveis mais o preheat (~3 telas), reciclados | ~600 tiles | Tile que sai de ±3 telas é reciclado |
| **L1** | RAM do Rust | `HashMap<id, Bytes>` com as thumbnails embutidas extraídas da pasta aberta + page cache do SQLite + cache do SO | Descartado ao fechar a pasta | — |
| **L2** | `thumbs.db` → `t2` | JPEG q80 com **384 px no lado maior**, já orientado, com ICC preservado, 15–30 KB | ~2–3 GB por 100k assets | Permanente. Invalidado por `gen` |
| **Viewer** | RAM | Preview de 2048 px (turbojpeg de 1/2 a 1/4) para ±3 vizinhos. RAW: o JPEG cheio embutido. Zoom 100%: `<img>` do original com transform CSS | ≤ 400 MB | Janela deslizante |
| **L3** (M5) | `previews/` em disco | Só para formatos que o webview não exibe (HEIC no Windows, TIFF) | Teto de 5 GB | LRU |
| **Virtual** | Dentro do original | `embed_off/len`: JPEG grande embutido no RAW | 0 B | — |

**Tiers dentro de uma célula:**
1. cor neutra no mesmo frame;
2. ThumbHash;
3. thumbnail embutida (cold) ou L2 (warm);
4. L2 por cima da embutida, com fade de ~100 ms (só se chegar mais de 1 frame depois).

**Por que blob SQLite e não packs próprios:** o próprio sqlite.org mede blobs de ~10 KB sendo lidos ~35% mais rápido que arquivos soltos. O custo dominante no NTFS é `CreateFile` + Defender por arquivo, e o banco elimina isso sem um formato próprio para manter: sem compactação, sem checker de trailer, sem mmap que cresce. Packs com slot fixo (ideia do `.ithmb`) só entram se o gate de 120 Hz falhar.

**Invariantes:**
- **Identidade:** `(volume, file_id)` quando `volumes.fs` é confiável. Fora disso, `(folder_id, file_name)`.
- **Mudança:** `size` ou `mtime_ns` diferente → `gen++`, e o EXIF e os derivados são invalidados. Como a URL inclui `gen`, a tela nunca mostra thumbnail velha. Cache HTTP não entra nessa conta.
- **Move/rename:** um arquivo novo com o mesmo `file_id`, ou com o mesmo `size + quick_hash`, herda os metadados e as thumbnails.
- **Arquivo ausente:** vira `attrs|=8`, mantém os derivados por 30 dias e depois é purgado. Volume desconectado é *offline*, nunca *ausente*.
- **Arquivo em cópia:** se o mtime é de menos de 5 s ou o arquivo dá sharing violation, ele é ignorado agora e tentado de novo em background.
- **Orientação:** todo pixel que chega ao webview satisfaz exatamente uma destas condições: **(a)** já vem orientado e sem tag Orientation (L2 e previews em RAM); **(b)** vem cru, com transform CSS calculado a partir de `assets.orientation` (thumbnails embutidas). Originais exibidos via `<img>` não recebem transform, porque o Chromium já aplica o EXIF. Fontes da orientação: IFD0 do RAW, CMT1 do CR3, `irot/imir` do HEIC, matriz `tkhd` do vídeo.
- **Cor:** o L2 copia o perfil ICC de origem (APP2) quando ele tem até 4 KB. Acima disso, converte para sRGB com `lcms2`. Adobe RGB sem ICC embutido recebe o perfil injetado. HDR gain map fica fora: mostramos a base SDR.

### 2.5 Fluxo de concorrência

```
 UI (WebView2, main thread JS: layout, scroll, eventos; nunca decodifica nem faz I/O síncrono)
   │ invoke(openFolder | viewport{range,gen} | filter | mapMove{bbox,zoom,gen})
   │                                                       ▲ Channel (binário): contagem, stubs,
   │                                                       │   deltas, facetas, clusters
   │                                                       │ http://thumb.localhost/<id>-<gen>
   ▼                                                       │   (handler assíncrono, fora da UI thread)
 ┌───────────────────── Núcleo Rust (tokio = orquestração + IPC apenas) ─────┴──────────────────┐
 │ ViewState { view_gen, viewport_center, velocidade }  (atômico)                               │
 │                                                                                              │
 │ SCANNER (1 por volume) ── GetFileInformationByHandleEx(FileIdExtdDirectoryInfo), em lotes    │
 │    │  filtra extensões, agrupa pilhas por nome-base, segue reparse points de nuvem           │
 │    ├──► Channel UI {count_so_far} a cada ≤16 ms                                               │
 │    └──► diff (file_id, size, mtime) com o banco ──► [Q_db] stubs                             │
 │                                                                                              │
 │ FILA POR VOLUME                                                                              │
 │    P0 = viewport + preheat, ordenado por distância ao centro, marcado com gen, LIFO          │
 │    BG = todo o resto (pasta aberta → raízes da biblioteca)                                   │
 │    ao desenfileirar: job P0 com gen velho → vai para BG (I/O em voo nunca é cancelado)       │
 │    fling > ~3 telas/s → P0 vira "só L1/L2/ThumbHash, sem I/O de original"                    │
 │                │                                                                             │
 │                ▼                                                                             │
 │ POOL DE I/O BLOQUEANTE do volume (SSD 32 | HDD 4 | rede 4 | placeholder de nuvem 0)          │
 │    read 64 KB → parse EXIF/IFD inline → range-read do preview embutido                       │
 │    ├──► L1 (bytes) ──► avisa a UI (só P0)                                                    │
 │    └──► metadados ──► [Q_db]                                                                 │
 │                │                                                                             │
 │                ▼  (só BG)                                                                    │
 │ POOL RAYON DE THUMBNAIL (dedicado, ≤ N/2 threads com UI ativa)                               │
 │    turbojpeg 1/2–1/8 → fast_image_resize → ICC → JPEG q80 384 px + ThumbHash                 │
 │                ▼                                                                             │
 │ ESCRITOR thumbs.db (1 thread, lotes) ──► ok ──► [Q_db] meta_state=2                          │
 │                                                                                              │
 │ [Q_db] canal limitado (o produtor espera quando enche) ──► ESCRITOR library.db               │
 │    (1 thread, BEGIN IMMEDIATE, lote de 1–5k linhas ou 50 ms) ──► commit ──► Delta{ids,gen}   │
 │                                                          ├──► ÍNDICE DE FILTRO (cauda;       │
 │                                                          │     rebuild após 1 s ocioso)      │
 │                                                          └──► UI (deltas da pasta aberta)    │
 │                                                                                              │
 │ GEO: mapMove (throttle de 100–150 ms + disparo final no moveend)                             │
 │    varredura lat/lon em memória ∩ filtro ativo ──► ids → grid + facetas                      │
 │                                                  └► hash de célula Mercator → clusters (<2k) │
 │    (bbox que cruza o antimeridiano vira 2; latitude limitada a ±85,0511°)                    │
 │                                                                                              │
 │ LEITORES (conexão própria por thread, query_only): grid, painel EXIF, viewer                 │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Detecção de mudanças:**
- Ao abrir uma pasta, primeiro pintamos o que está no banco e depois re-enumeramos em background (~40 ms em SSD), comparando `size` e `mtime` arquivo a arquivo. Comparar só o `dir_mtime` não basta, porque ele não muda quando um arquivo é editado no lugar.
- Usamos o watcher `notify` 8.x (com debouncer) só nas raízes da biblioteca. Um overflow dispara um rescan daquela subárvore.
- Não usamos o USN journal na Fase 1.

### 2.6 Riscos técnicos e mitigação

| Risco | Mitigação |
|---|---|
| **O repositório e a pasta Imagens estão no OneDrive.** O Known Folder Move do Windows 11 põe Imagens no OneDrive por padrão, então esse é o **caso principal**, não uma exceção | Mover o repositório para fora do OneDrive (ex.: `C:\dev\OpenPhoto`): o `target/` do cargo tem vários GB e o OneDrive trava arquivos durante o build. Criar uma pasta de teste com arquivos desidratados, hidratados e fixados |
| **Ler um placeholder pode hidratar o arquivo inteiro.** É provável que o OneDrive use política de hidratação completa (NV) | Detectar na enumeração `RECALL_ON_DATA_ACCESS` (0x400000), `RECALL_ON_OPEN` (0x40000) e `OFFLINE`, e nunca abrir o conteúdo. Para a miniatura, usar `IShellItemImageFactory::GetImage(SIIGBF_INCACHEONLY)` (thumbcache do Explorer); para propriedades, `IPropertyStore` **apenas** com `GPS_FASTPROPERTIESONLY`. **Teste no 1º dia:** um arquivo fictício de 100 MB, monitorando o tráfego de rede |
| **Reparse points** | Seguir os reparse points de nuvem (`IO_REPARSE_TAG_CLOUD_*`). Por padrão, não seguir symlinks e junctions de diretório. Detectar ciclos pelo par (volume, FileId) |
| **Custo do Defender na primeira abertura** e **custo por requisição do esquema no WebView2** | Os dois são medidos no 1º dia. Se passarem de 1 ms, o cold < 100 ms cai mesmo em NVMe. Plano: endpoint em lote; nunca abrir arquivo fora do viewport no caminho crítico |
| **Arquivo sem thumbnail embutida** (PNG, export, print de tela) | Tile neutro primeiro, depois decode a 1/8 em P0. Se o arquivo já estiver no thumbcache do Explorer, usar `SIIGBF_INCACHEONLY` |
| **Thumbnail embutida do RAW não é JPEG** (o IFD0 do NEF, o IFD2 do CR2 e muitos DNG trazem strips RGB) | Codificar com turbojpeg (sub-ms). Na semana 1, montar uma tabela por formato (offset, codec, dimensões) a partir de um corpus do raw.pixls.us |
| **RAW exótico** (CR3 novo, X-Trans, IIQ, DNG sem preview) | Ordem de tentativa: parser próprio, depois `rawler`, depois LibRaw (só no viewer). Se nada funcionar, tile genérico com badge do formato |
| **RAW+JPEG, Live Photos e Motion Photos** | Agrupamento por nome-base já no cold, no M1: `{RAW, JPG}` vira 1 tile com badge, e `{HEIC/JPG, MOV ≤ 4 s}` vira Live Photo. A confirmação vem depois, em BG, via `ContentIdentifier`. Motion Photo é detectado pelo XMP `GCamera:MotionPhoto`. A contagem já sai agrupada |
| **XMP / arquivos auxiliares** | Ler `Rating`, `Label` e `dc:subject` do sidecar (`IMG.xmp` / `IMG.CR3.xmp`) ou do XMP embutido. Ignorar `.AAE`, `Thumbs.db`, `desktop.ini`, `.picasa.ini`, `$RECYCLE.BIN`, `@eaDir` e `.@__thumb`. Os ajustes de revelação (`crs:*`) são ignorados, o que deve ser documentado |
| **Licença HEIC/HEVC** | Decodificar pelo SO: WIC com as extensões HEIF + HEVC da Store no Windows (a HEVC é paga, a não ser que venha do OEM) e ImageIO no macOS. Nenhum decoder HEVC vai no instalador. `libheif` só como plugin opcional no Linux |
| **Vídeo** | Não há thumbnail embutida, e o `moov` costuma ficar no fim do arquivo (Android). Em cold: placeholder; a duração vem depois, em BG, percorrendo as caixas com 2–3 leituras posicionadas. Poster frame: thumbcache primeiro, depois Media Foundation (`IMFSourceReader`, D3D11VA). Reprodução pelo `<video>`. Data do vídeo: `com.apple.quicktime.creationdate` > `mvhd` UTC + fuso da foto vizinha > mtime |
| **NAS/SMB** | Profundidade de fila 4. Leitura do cabeçalho numa única requisição. Para esse caso, a promessa de < 100 ms vale só para o esqueleto |
| **HDD** | QD 4 (NCQ), viewport primeiro. Disco USB-BOT sem UAS: QD 1. Não ordenar por LCN |
| **Caminhos** | Prefixo `\\?\`, `path_key` normalizado (NFC/casefold), `display_path` original |
| **Integridade** | WAL + `synchronous=NORMAL`. Antes da 1.0 o catálogo é reconstruível; migrações de verdade só começam com o 1º dado criado pelo usuário. Teste de 1.000 kills aleatórios durante a ingestão **já no M1** |
| **Licenças de dados** | Protomaps/OSM (ODbL) e GeoNames (CC-BY 4.0) exigem atribuição na UI |

**Matriz de formatos:**
- **O webview exibe nativamente:** JPEG, PNG, GIF, WebP, AVIF.
- **Precisam de transcode/L3:** HEIC (Windows), TIFF, RAW (via preview embutido) e JXL (suporte no Chromium: NV).

---

## 3. Roadmap incremental

### M1: Motor de leitura/indexação + grid virtualizado (Windows)

**Escopo:**
- **Dia 1–2, medições** que decidem o resto:
  - custo do Defender por primeira abertura;
  - custo por requisição do esquema no WebView2;
  - hidratação de placeholders do OneDrive;
  - enumeração fria de 30k arquivos.
- **Semana 1, gate de 120 Hz:** `<img>` contra canvas em lote; tabela de thumbnails embutidas por formato de RAW.
- **Scanner:** `FileIdExtdDirectoryInfo`, reparse points de nuvem, agrupamento em pilhas, regra de ordenação com deadline.
- **Pools de I/O por volume**, fila P0/BG com `gen`, parse inline.
- **EXIF:** JPEG e RAW TIFF/CR3/RAF, com o preview embutido (JPEG ou strip RGB).
- **Banco:** `library.db` + `thumbs.db` com `user_version` (rebuild quando divergir); escritores dedicados.
- **Thumbnails:** L2 de 384 px com ICC e ThumbHash; invariante de orientação.
- **Grid:** quadrado e virtualizado (Solid), com scrollbar baseada na contagem.
- **OneDrive:** placeholders recebem thumbnail via `SIIGBF_INCACHEONLY`, sem hidratar.
- **Rescan** com diff ao abrir a pasta.

**Critério de aceite.** Corpus: 30k JPEG + 5k RAW em NVMe, num i7/Ryzen intermediário, com a standby list limpa e o Defender ligado.

| Métrica | Alvo |
|---|---|
| Cold: esqueleto | ≤ 50 ms p95 |
| Cold: ≥ 90% dos tiles visíveis com imagem | ≤ 100 ms p95 em 1080p. Em 4K o número é medido e registrado |
| Warm | ≤ 60 ms p95 |
| Fling por 50k tiles a 120 Hz | ≤ 1% de frames perdidos; nenhuma long task > 16 ms |
| Indexação de cabeçalhos | ≥ 5k arquivos/s |
| L2 completo | ≥ 300 thumbs/s em 8 núcleos |
| RAM do processo Rust | ≤ 500 MB com 100k assets |
| Pasta do OneDrive de teste | Zero hidratações |
| Kills aleatórios durante a ingestão | 1.000 kills sem corromper o banco |

**Fica de fora:** filtros, mapa, viewer, HEIC, vídeo (só placeholder), watcher, macOS/Linux e layout justificado.

### M2: Viewer em tela cheia

**Escopo:**
- transição a partir do tile (upscale no mesmo frame);
- preview de 2048 px em RAM, ou o JPEG cheio embutido do RAW, com cross-fade;
- prefetch de ±3;
- zoom 100% via `<img>` do original com transform CSS;
- painel EXIF: primeiro as colunas indexadas, depois o dump completo parseado dos bytes já lidos.

**Critério de aceite:**

| Métrica | Alvo |
|---|---|
| Abrir com a thumbnail | ≤ 16 ms |
| Preview ≥ 1600 px | ≤ 150 ms p95 |
| Próxima/anterior com prefetch | ≤ 16 ms |
| Zoom 100% num JPEG de 24 MP | ≤ 400 ms |
| Painel EXIF | ≤ 10 ms |
| RAM do viewer | ≤ 400 MB |

**Fica de fora:** revelação RAW completa, edição e vídeo.

### M3: Filtros combinados, timeline e busca

**Escopo:**
- índice colunar em memória e facetas: câmera, lente, ISO, abertura, obturador, focal, formato, resolução, árvore de pastas e rating do XMP;
- raízes da biblioteca e indexação em BG limitada a elas;
- timeline Anos/Meses/Dias que respeita o filtro;
- scrubber por somas de prefixo;
- FTS5 trigram;
- layout justificado opcional quando `scan_state ≥ 2`.

**Critério de aceite** (1M de assets sintéticos):

| Métrica | Alvo |
|---|---|
| Troca de filtro → novo grid | ≤ 30 ms p95. Se não atingir, entram os bitmaps roaring |
| Recontagem de todas as facetas | ≤ 20 ms |
| Arrastar o scrubber | 60 fps |
| Busca de texto | ≤ 50 ms |
| Memória do índice | ≤ 60 MB |

**Fica de fora:** busca semântica, rostos e OCR.

### M4: Mapa 2D, globo 3D e clustering

**Escopo:**
- MapLibre v5 em projeção Mercator e globo;
- PMTiles Protomaps: base mundial embarcada (teto de 100 MB, a medir) e extratos regionais baixados uma única vez;
- glyphs e sprites locais;
- clustering por célula Mercator no Rust, com um asset representativo por cluster, e heatmap;
- o bbox filtra o grid e as facetas;
- tabela `asset_geo` (R*Tree) e geocodificação reversa offline (GeoNames).

**Critério de aceite** (1M de assets, 300k com GPS):

| Métrica | Alvo |
|---|---|
| `moveend` → grid e clusters atualizados | ≤ 150 ms |
| Clustering | ≤ 10 ms |
| Pan/zoom | 60 fps |
| Funciona com a rede desligada | Sim |
| Antimeridiano e polos | Corretos |

**Fica de fora:** CesiumJS, terreno 3D, deck.gl e WebGPU.

### M5: Formatos e fontes difíceis

**Escopo:**
- HEIC via WIC, com L3 em disco;
- vídeo: metadados do `moov`, poster frame via Media Foundation e reprodução;
- otimizações de SMB;
- watcher `notify` com debouncer;
- Synology `@eaDir` como fonte de thumbnail cold (opcional, NV).

**Critério de aceite:**

| Métrica | Alvo |
|---|---|
| 1k HEIC: thumbnails do viewport | ≤ 300 ms |
| Poster de vídeo em BG | ≤ 150 ms cada |
| Mudança externa refletida | ≤ 2 s |
| SMB 1 GbE: esqueleto | ≤ 100 ms |
| SMB 1 GbE: indexação | ≥ 1k cabeçalhos/s |

**Fica de fora:** USN journal.

### M6: Multiplataforma e endurecimento

**Escopo:**
- macOS (FSEvents, ImageIO; verificar o limite de 60 Hz do WKWebView);
- Linux (inotify; WebKitGTK ou o plano B Electron);
- migrações reais de schema, quando surgir o 1º dado criado pelo usuário.

**Critério de aceite:** os números do M1 com tolerância de +30% no macOS (Apple Silicon) e no Linux.

**Fica de fora:** ML (rostos e cenas), que é a Fase 2, versionada e rodando só ociosa ou na tomada.

---

## 4. Decisões para você validar

1. **O que conta como "< 100 ms cold".** O esqueleto sai em < 100 ms em todo volume local e em SMB cabeado. As imagens do viewport saem em < 100 ms **só** em SSD/NVMe e só para arquivos com thumbnail embutida. A medição é feita com o cache do SO limpo e o Defender ligado. Os demais casos seguem a tabela de limites honestos da §2.2.
2. **Ordenação da pasta.** A visão de pasta é sempre por nome natural, com a regra de deadline. A ordem por data fica na Timeline.
3. **Simplificações.** Thumbnails num banco de blobs SQLite (`thumbs.db`) em vez de packs próprios. Filtros por varredura colunar em vez de roaring. Os dois só mudam se um benchmark reprovar.
4. **Somente leitura.** O app nunca grava nos originais: sem XMP e sem pastas `.thumbs`. O catálogo é um cache reconstruível até existir o primeiro dado criado pelo usuário.
5. **Stack.** Tauri 2 + WebView2 + Solid, sujeito ao gate de 120 Hz da semana 1. Electron fica como plano B para Linux e macOS.
6. **Repositório fora do OneDrive.** Posso criar o projeto em `C:\dev\OpenPhoto` (ou outro caminho de sua escolha), mantendo uma pasta de teste no OneDrive?
