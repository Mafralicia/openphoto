import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { batchApplyEnrichment, batchUpsertMedia, relinkLivePhotos } from './db.ts';
import { computeSeedHash, parseHeaderMetadata } from './exifExtractor.ts';
import type { MediaType, ScanEventPayload } from './types.ts';

const PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'avif', 'gif', 'tif', 'tiff', 'bmp']);
const RAW_EXTS = new Set(['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'raf', 'rw2', 'pef', 'srw']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi']);

const RESCAN_DEBOUNCE_MS = 1500;

function classifyExt(ext: string): MediaType | null {
  if (PHOTO_EXTS.has(ext)) return 0;
  if (RAW_EXTS.has(ext)) return 1;
  if (VIDEO_EXTS.has(ext)) return 2;
  return null;
}

const activeWatchers = new Map<number, fs.FSWatcher>();

export function unwatchFolder(folderId: number): void {
  activeWatchers.get(folderId)?.close();
  activeWatchers.delete(folderId);
}

export function isWatching(folderId: number): boolean {
  return activeWatchers.has(folderId);
}

/**
 * New/changed files are indexed right away. Anything that removes or moves things (deleted files,
 * renamed files or folders) triggers `rescan` instead: the scanner can tell a move from a deletion
 * and keeps favorites/EXIF on moved files, which per-event handling can't.
 */
export function watchFolder(
  folderId: number,
  folderPath: string,
  emit: (event: ScanEventPayload) => void,
  rescan: () => void,
): void {
  if (activeWatchers.has(folderId)) return;

  const pendingPaths = new Map<string, boolean>(); // path -> saw a 'rename' (create/delete/move) event
  let flushTimer: NodeJS.Timeout | null = null;
  let rescanTimer: NodeJS.Timeout | null = null;
  const scheduleRescan = () => {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      if (activeWatchers.has(folderId)) rescan();
    }, RESCAN_DEBOUNCE_MS);
  };

  const flushChanges = async () => {
    flushTimer = null;
    const paths = Array.from(pendingPaths);
    pendingPaths.clear();
    if (paths.length === 0) return;

    let changed = false;
    for (const [fullPath, renamed] of paths) {
      let st: fs.Stats;
      try {
        st = await fsp.stat(fullPath);
      } catch {
        scheduleRescan(); // gone: deleted, or renamed/moved (the scan decides which)
        continue;
      }
      if (st.isDirectory()) {
        // Folder created/renamed/moved in: index its whole subtree. Plain 'change' events on folders
        // just mean a file inside was written (handled by that file's own event).
        if (renamed) scheduleRescan();
        continue;
      }
      const ext = path.extname(fullPath).slice(1).toLowerCase();
      const mediaType = classifyExt(ext);
      if (mediaType === null || !st.isFile()) continue;

      try {
        const mtimeNs = Math.trunc(st.mtimeMs);
        batchUpsertMedia(
          [
            {
              folder_id: folderId,
              filename: path.basename(fullPath),
              path: fullPath,
              dir: path.relative(folderPath, path.dirname(fullPath)),
              media_type: mediaType,
              format: ext,
              file_size: st.size,
              mtime_ns: mtimeNs,
              quick_hash: computeSeedHash(fullPath, st.size, mtimeNs),
              taken_at_ms: mtimeNs,
              exif_status: 0,
              thumb_status: 0,
            },
          ],
          folderId,
        );

        const meta = await parseHeaderMetadata(fullPath, st.size, mtimeNs, mediaType === 2);
        batchApplyEnrichment([
          {
            path: fullPath,
            quick_hash: meta.quickHash,
            width: meta.width,
            height: meta.height,
            orientation: meta.orientation,
            taken_at_ms: meta.takenAtMs,
            duration_ms: meta.durationMs,
            camera_make: meta.cameraMake,
            camera_model: meta.cameraModel,
            lens_model: meta.lensModel,
            iso: meta.iso,
            aperture_f: meta.apertureF,
            shutter_us: meta.shutterUs,
            focal_length_mm: meta.focalLengthMm,
            has_gps: meta.hasGps,
            lat: meta.lat,
            lon: meta.lon,
            exif_status: 1,
          },
        ]);
        changed = true;
      } catch {
        // File still being copied or locked: the next event (or rescan) picks it up
      }
    }

    if (changed) {
      relinkLivePhotos(folderId); // a new photo/clip may complete a Live Photo pair
      emit({
        type: 'fs:changed',
        folderId,
        folderPath,
        discovered: 0,
        enriched: 0,
        elapsedMs: 0,
        message: 'Alteração detectada no disco',
      });
    }
  };

  try {
    const watcher = fs.watch(folderPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const full = path.resolve(folderPath, filename.toString());
      pendingPaths.set(full, pendingPaths.get(full) === true || eventType === 'rename');
      if (!flushTimer) {
        flushTimer = setTimeout(() => void flushChanges(), 180);
      }
    });

    watcher.on('error', () => {
      // Typically the drive was unplugged. The library monitor restarts us when it's back.
      watcher.close();
      activeWatchers.delete(folderId);
    });

    activeWatchers.set(folderId, watcher);
  } catch {
    // Non-fatal if OS rejects watcher on unavailable path
  }
}
