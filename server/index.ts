import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  getDbStats,
  getFilterFacets,
  getMediaById,
  getMediaByIds,
  listFolderDirs,
  listFolders,
  queryMapClusters,
  queryMediaPage,
  removeFolder,
  setFavorite,
} from './db.ts';
import { addFolder, ejectFolder, forgetFolder, isFolderOnline, startLibraryMonitor } from './library.ts';
import { enqueueThumbnailJob, getThumbnail, thumbStats } from './thumbService.ts';
import type { MediaFilterParams, ScanEventPayload } from './types.ts';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT ?? 4173);
const DEMO_FOLDER_PATH = process.env.OPENPHOTO_DEMO_DIR || path.resolve(process.cwd(), 'sample-photos');
const UI_DIR = path.resolve(process.env.OPENPHOTO_UI_DIR || path.resolve(process.cwd(), 'dist'));

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** Serves the built UI (dist/). Unknown paths fall back to index.html. */
async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  let filePath = path.join(UI_DIR, decodeURIComponent(pathname));
  if (!filePath.startsWith(UI_DIR + path.sep)) filePath = path.join(UI_DIR, 'index.html');
  let body: Buffer;
  try {
    body = await fs.promises.readFile(filePath);
  } catch {
    filePath = path.join(UI_DIR, 'index.html');
    try {
      body = await fs.promises.readFile(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Interface not built. Run "npm run build".');
      return;
    }
  }
  res.writeHead(200, {
    'Content-Type': STATIC_MIME[path.extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

const sseClients = new Set<http.ServerResponse>();

function broadcastSse(payload: ScanEventPayload): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  // Requiring JSON forces a CORS preflight, which this server never answers: other sites can't trigger writes
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new Error('Content-Type application/json is required.');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
}

function parseOptionalNumber(val: string | null): number | null {
  if (val === null || val.trim() === '') return null;
  const n = Number(val);
  return Number.isNaN(n) ? null : n;
}

function parseFiltersFromUrl(url: URL): MediaFilterParams {
  return {
    folderId: parseOptionalNumber(url.searchParams.get('folderId')),
    dir: url.searchParams.get('dir'),
    q: url.searchParams.get('q'),
    mediaType: parseOptionalNumber(url.searchParams.get('mediaType')),
    format: url.searchParams.get('format'),
    camera: url.searchParams.get('camera'),
    lens: url.searchParams.get('lens'),
    isoMin: parseOptionalNumber(url.searchParams.get('isoMin')),
    isoMax: parseOptionalNumber(url.searchParams.get('isoMax')),
    apertureMin: parseOptionalNumber(url.searchParams.get('apertureMin')),
    apertureMax: parseOptionalNumber(url.searchParams.get('apertureMax')),
    dateFrom: parseOptionalNumber(url.searchParams.get('dateFrom')),
    dateTo: parseOptionalNumber(url.searchParams.get('dateTo')),
    hasGps: url.searchParams.get('hasGps') === '1' || url.searchParams.get('hasGps') === 'true',
    favorite: url.searchParams.get('favorite') === '1',
    minLat: parseOptionalNumber(url.searchParams.get('minLat')),
    maxLat: parseOptionalNumber(url.searchParams.get('maxLat')),
    minLon: parseOptionalNumber(url.searchParams.get('minLon')),
    maxLon: parseOptionalNumber(url.searchParams.get('maxLon')),
  };
}

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

async function openNativeFolderPicker(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Selecione uma pasta de fotos e videos para o OpenPhoto'
    $dialog.UseDescriptionForTitle = $true
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Output $dialog.SelectedPath
    }
  `;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], {
    windowsHide: false,
  });
  const chosen = stdout.trim();
  return chosen.length > 0 ? chosen : null;
}

// Watch, catch up and backfill thumbnails for every folder whose drive is connected; keep polling for drives
startLibraryMonitor(broadcastSse);

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    res.writeHead(400);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      await serveStatic(pathname, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/favorite') {
      const body = await readJsonBody(req);
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      sendJson(res, 200, { updated: setFavorite(ids.slice(0, 5000), body.value === true) });
      return;
    }

    const folderRemoveMatch = pathname.match(/^\/api\/folders\/(\d+)\/remove$/);
    if (req.method === 'POST' && folderRemoveMatch) {
      const folderId = Number(folderRemoveMatch[1]);
      forgetFolder(folderId);
      removeFolder(folderId);
      sendJson(res, 200, { ok: true });
      return;
    }

    const folderEjectMatch = pathname.match(/^\/api\/folders\/(\d+)\/eject$/);
    if (req.method === 'POST' && folderEjectMatch) {
      ejectFolder(Number(folderEjectMatch[1]), broadcastSse);
      sendJson(res, 200, { ok: true });
      return;
    }

    const folderTreeMatch = pathname.match(/^\/api\/folders\/(\d+)\/tree$/);
    if (req.method === 'GET' && folderTreeMatch) {
      sendJson(res, 200, { dirs: listFolderDirs(Number(folderTreeMatch[1])) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        db: getDbStats(),
        cache: thumbStats,
        demoFolder: fs.existsSync(DEMO_FOLDER_PATH) ? DEMO_FOLDER_PATH : null,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/folders') {
      sendJson(res, 200, {
        folders: listFolders().map((f) => ({ ...f, online: isFolderOnline(f.id) })),
        stats: getDbStats(),
        cache: thumbStats,
        demoFolder: fs.existsSync(DEMO_FOLDER_PATH) ? DEMO_FOLDER_PATH : null,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/filters') {
      const folderId = parseOptionalNumber(url.searchParams.get('folderId'));
      sendJson(res, 200, getFilterFacets(folderId));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/map/clusters') {
      const filters = parseFiltersFromUrl(url);
      const zoom = parseOptionalNumber(url.searchParams.get('zoom')) ?? 2;
      const result = queryMapClusters({ filters, zoom });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pick-folder') {
      const selected = await openNativeFolderPicker();
      sendJson(res, 200, { path: selected });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/scan') {
      const body = await readJsonBody(req);
      const targetPath = typeof body.path === 'string' ? body.path.trim() : '';
      if (!targetPath) {
        sendJson(res, 400, { error: 'Informe o caminho da pasta (path).' });
        return;
      }
      sendJson(res, 202, await addFolder(targetPath, broadcastSse));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/prefetch') {
      const body = await readJsonBody(req);
      const rawIds = Array.isArray(body.ids) ? body.ids : [];
      const size = body.size === 'lg' ? 'lg' : 'sm';
      const ids = rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 24);
      const items = getMediaByIds(ids);
      for (const item of items) {
        enqueueThumbnailJob(item, size, true);
      }
      sendJson(res, 200, { queued: items.length });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/media') {
      const filters = parseFiltersFromUrl(url);
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));

      const result = queryMediaPage({ filters, offset, limit, sort: url.searchParams.get('sort') });
      sendJson(res, 200, {
        ...result,
        cache: thumbStats,
      });
      return;
    }

    const mediaDetailMatch = pathname.match(/^\/api\/media\/(\d+)$/);
    if (req.method === 'GET' && mediaDetailMatch) {
      const id = Number(mediaDetailMatch[1]);
      const media = getMediaById(id);
      if (!media) {
        sendJson(res, 404, { error: 'Mídia não encontrada' });
        return;
      }
      sendJson(res, 200, media);
      return;
    }

    const thumbMatch = pathname.match(/^\/api\/thumb\/(\d+)\/(sm|lg)$/);
    if (req.method === 'GET' && thumbMatch) {
      const id = Number(thumbMatch[1]);
      const size = thumbMatch[2] as 'sm' | 'lg';
      const media = getMediaById(id);
      if (!media) {
        res.writeHead(404);
        res.end();
        return;
      }

      const t0 = performance.now();
      const thumb = await getThumbnail(media, size);
      if (!thumb) {
        res.writeHead(404);
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': thumb.contentType,
        'Content-Length': thumb.buffer.byteLength,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Thumb-Tier': thumb.tier,
        'X-Thumb-Ms': (performance.now() - t0).toFixed(2),
      });
      res.end(thumb.buffer);
      return;
    }

    const origMatch = pathname.match(/^\/api\/original\/(\d+)$/);
    if (req.method === 'GET' && origMatch) {
      const id = Number(origMatch[1]);
      const media = getMediaById(id);
      if (!media) {
        res.writeHead(404);
        res.end();
        return;
      }

      const contentType = MIME_MAP[media.format.toLowerCase()] ?? 'application/octet-stream';
      const stat = await fs.promises.stat(media.path);
      // Range support so the <video> element can seek
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range && stat.size > 0) {
        const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': contentType,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(media.path, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(media.path).pipe(res);
      return;
    }

    sendJson(res, 404, { error: 'Endpoint não encontrado' });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : 'Erro interno no servidor OpenPhoto',
    });
  }
});

/** Resolves with the bound port (PORT=0 picks a free one; the desktop app uses that). */
export const ready = new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    console.log(`[OpenPhoto] http://127.0.0.1:${port}`);
    resolve(port);
  });
});
