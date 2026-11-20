# OpenPhoto

Biblioteca de fotos e vídeos para Windows que lê direto do disco, inclusive de HD externo. Nada é copiado nem enviado para a nuvem: o OpenPhoto indexa as pastas que você escolher e guarda só os metadados e as miniaturas no seu computador.

## O que ele faz

- Galeria rápida mesmo com dezenas de milhares de itens (grade virtualizada, miniaturas em cache).
- Pastas e subpastas em árvore, favoritas, filtros por câmera, lente, ISO, abertura e data.
- Mapa 2D e globo 3D com as fotos que têm GPS.
- HEIC do iPhone e Live Photos (a foto e o vídeo curto aparecem como um item só).
- HD externo: o disco é reconhecido mesmo se voltar com outra letra; com ele desconectado, a biblioteca continua navegável pelas miniaturas já geradas.
- Atualização automática pelas releases deste repositório.

## Instalar

Baixe o instalador mais recente em [Releases](https://github.com/mafralicia/openphoto/releases). Para HEIC e miniaturas de vídeo, tenha o [ffmpeg](https://ffmpeg.org/download.html) 7.1 ou mais novo no `PATH`.

## Desenvolver

Requer Node.js 22 ou mais novo.

```bash
npm install
npx tsx scripts/generateDemoPhotos.ts   # opcional: fotos de exemplo em sample-photos/
npm run app                             # compila e abre o app
npm test                                # testes da biblioteca (scan, HD externo, Live Photos)
npm run dev                             # modo web, com recarga automática
```

Onde ficam os dados do app: `%APPDATA%\openphoto\library` (banco SQLite e cache de miniaturas).

## Publicar uma versão

```bash
npm version patch        # ou minor / major
git push --follow-tags
```

A tag `v*` dispara o workflow de release, que gera o instalador e o publica em Releases. Os apps instalados baixam a atualização sozinhos.

## Contribuir

Pull requests são bem-vindos. A branch `main` é protegida: toda mudança entra por PR, precisa passar nos testes e ser aprovada pelo mantenedor.

## Licença

[MIT](LICENSE)
