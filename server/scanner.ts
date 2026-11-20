import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  batchApplyEnrichment,
  batchUpsertMedia,
  deleteMediaByIds,
  getExistingMediaMap,
  moveMediaRow,
  pathKey,
  relinkLivePhotos,
  type ExistingMediaRow,
  upsertFolder,
  type ExifEnrichmentRow,
} from './db.ts';
import { computeSeedHash, parseHeaderMetadata } from './exifExtractor.ts';
import type { MediaInsertInput, MediaType, ScanEventPayload } from './types.ts';

const PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'avif', 'gif', 'tif', 'tiff', 'bmp']);
const RAW_EXTS = new Set(['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'raf', 'rw2', 'pef', 'srw']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi']);

const FIRST_BATCH_SIZE = 60; // Tiny first batch for < 100ms Cold Start first render
const STEADY_BATCH_SIZE = 500;
const ENRICH_BATCH_SIZE = 150;
const ENRICH_CONCURRENCY = Math.max(4, Math.min(12, os.cpus().length - 1));

function classifyExtension(ext: string): MediaType | null {
  if (PHOTO_EXTS.has(ext)) return 0;
  if (RAW_EXTS.has(ext)) return 1;
  if (VIDEO_EXTS.has(ext)) return 2;
  return null;
}

export type ScanEventListener = (event: ScanEventPayload) => void;

const activeScans = new Set<string>();
const cancelledScans = new Set<number>();

/** Ask a running scan of this folder to stop (drive being ejected/removed). It stops before deleting anything. */
export function cancelScan(folderId: number): void {
  cancelledScans.add(folderId);
}

class ScanCancelled extends Error {}
function checkCancelled(folderId: number): void {
  if (cancelledScans.has(folderId)) throw new ScanCancelled('Verificação interrompida');
}

interface PendingEnrichJob {
  path: string;
  fileSize: number;
  mtimeNs: number;
  isVideo: boolean;
}

export async function scanDirectory(rootPath: string, emit: ScanEventListener): Promise<{ folderId: number }> {
  const normalized = path.resolve(rootPath);
  const stat = await fs.stat(normalized);
  if (!stat.isDirectory()) {
    throw new Error(`O caminho não é um diretório válido: ${normalized}`);
  }

  const folder = upsertFolder(normalized, null);

  if (activeScans.has(normalized)) {
    return { folderId: folder.id };
  }
  activeScans.add(normalized);
  cancelledScans.delete(folder.id);

  // Run scan pipeline asynchronously so HTTP /api/scan returns immediately
  void runScanPipeline(folder.id, normalized, emit).finally(() => {
    activeScans.delete(normalized);
  });

  return { folderId: folder.id };
}

/**
 * Drops rows for files deleted from disk. Conservative on purpose (favorites live in these rows):
 * the library root must still be there, the file's directory must have been listed successfully,
 * and the file itself must report "does not exist". A drive unplugged mid-scan removes nothing.
 */
const identityKey = (filePath: string, size: number, mtime: number) =>
  `${path.basename(filePath).toLowerCase()}|${size}|${mtime}`;

async function removeVanished(
  folderId: number,
  rootPath: string,
  existingMap: Map<string, ExistingMediaRow>,
  seenPaths: Set<string>,
  unreadableDirs: string[],
  insertedThisScan: Map<string, string>,
): Promise<number> {
  const blocked = unreadableDirs.map((d) => pathKey(d + path.sep));
  const candidates: ExistingMediaRow[] = [];
  for (const [key, row] of existingMap) {
    if (seenPaths.has(key)) continue;
    if (blocked.some((b) => key.startsWith(b))) continue;
    candidates.push(row);
  }
  if (candidates.length === 0) return 0;

  try {
    if (!(await fs.stat(rootPath)).isDirectory()) return 0;
  } catch {
    return 0;
  }

  const gone: ExistingMediaRow[] = [];
  for (let i = 0; i < candidates.length; i += 64) {
    await Promise.all(
      candidates.slice(i, i + 64).map(async (c) => {
        try {
          await fs.stat(c.path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') gone.push(c);
        }
      }),
    );
  }

  // Same name, size and mtime present at another path = the file (or its folder) was moved/renamed:
  // keep the old row (favorite, EXIF, thumbnail) and point it at the new place. The new path may have
  // been inserted by this scan or, moments earlier, by the watcher.
  const targets = new Map(insertedThisScan);
  for (const [key, row] of existingMap) {
    if (seenPaths.has(key)) {
      const id = identityKey(row.path, row.file_size, row.mtime_ns);
      if (!targets.has(id)) targets.set(id, row.path);
    }
  }
  const deleted: number[] = [];
  for (const row of gone) {
    const id = identityKey(row.path, row.file_size, row.mtime_ns);
    const newPath = targets.get(id);
    if (newPath) {
      targets.delete(id);
      moveMediaRow(row.id, newPath, path.relative(rootPath, path.dirname(newPath)));
    } else {
      deleted.push(row.id);
    }
  }
  deleteMediaByIds(deleted, folderId);
  return deleted.length;
}

async function runScanPipeline(folderId: number, rootPath: string, emit: ScanEventListener): Promise<void> {
  const startedAt = performance.now();
  let firstBatchMs: number | undefined;
  let discovered = 0;
  let enriched = 0;

  emit({
    type: 'scan:started',
    folderId,
    folderPath: rootPath,
    discovered: 0,
    enriched: 0,
    elapsedMs: 0,
  });

  try {
    const existingMap = getExistingMediaMap(folderId);
    const pendingInsert: MediaInsertInput[] = [];
    const pendingEnrich: PendingEnrichJob[] = [];
    let isFirstBatch = true;

    const flushInsertBatch = () => {
      if (pendingInsert.length === 0) return;
      batchUpsertMedia(pendingInsert, folderId);
      pendingInsert.length = 0;

      const elapsedMs = Number((performance.now() - startedAt).toFixed(1));
      if (isFirstBatch) {
        firstBatchMs = elapsedMs;
        isFirstBatch = false;
      }

      emit({
        type: 'scan:batch',
        folderId,
        folderPath: rootPath,
        discovered,
        enriched,
        elapsedMs,
        firstBatchMs,
      });
    };

    // Everything seen on disk this pass, and directories we could not list (their contents are unknown,
    // so nothing under them may be treated as deleted)
    const seenPaths = new Set<string>(); // pathKey()s
    const unreadableDirs: string[] = [];
    const insertedThisScan = new Map<string, string>(); // identityKey -> path, for move detection

    // Fast parallel BFS directory walker
    const dirQueue: string[] = [rootPath];

    while (dirQueue.length > 0) {
      checkCancelled(folderId);
      const currentDirs = dirQueue.splice(0, 8);
      await Promise.all(
        currentDirs.map(async (dir) => {
          let entries;
          try {
            entries = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            unreadableDirs.push(dir);
            return;
          }

          const fileCandidates: Array<{ fullPath: string; name: string; ext: string; mediaType: MediaType }> = [];

          for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN') {
              continue;
            }
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              dirQueue.push(fullPath);
            } else if (entry.isFile()) {
              const dotIdx = entry.name.lastIndexOf('.');
              if (dotIdx === -1) continue;
              const ext = entry.name.slice(dotIdx + 1).toLowerCase();
              const mediaType = classifyExtension(ext);
              if (mediaType !== null) {
                fileCandidates.push({ fullPath, name: entry.name, ext, mediaType });
              }
            }
          }

          // Stat discovered files in parallel chunks of 32
          for (let i = 0; i < fileCandidates.length; i += 32) {
            const slice = fileCandidates.slice(i, i + 32);
            await Promise.all(
              slice.map(async (cand) => {
                const key = pathKey(cand.fullPath);
                seenPaths.add(key); // listed by readdir = present, even if stat fails below
                try {
                  const st = await fs.stat(cand.fullPath);
                  const mtimeNs = Math.trunc(st.mtimeMs);
                  const fileSize = st.size;
                  const existing = existingMap.get(key);
                  const relDir = path.relative(rootPath, dir);

                  discovered++;

                  // Only the letter case changed (Windows): same file, keep the row
                  if (existing && existing.path !== cand.fullPath) {
                    moveMediaRow(existing.id, cand.fullPath, relDir);
                    existing.path = cand.fullPath;
                  }

                  if (existing && existing.file_size === fileSize && existing.mtime_ns === mtimeNs) {
                    // Videos indexed before durations were read get one more pass (needed for Live Photos)
                    const needsVideoInfo = existing.media_type === 2 && existing.duration_ms === null;
                    if (existing.exif_status === 1 && !needsVideoInfo) {
                      enriched++;
                    } else {
                      pendingEnrich.push({
                        path: cand.fullPath,
                        fileSize,
                        mtimeNs,
                        isVideo: cand.mediaType === 2,
                      });
                    }
                    return;
                  }

                  const seedHash = computeSeedHash(cand.fullPath, fileSize, mtimeNs);
                  pendingInsert.push({
                    folder_id: folderId,
                    filename: cand.name,
                    path: cand.fullPath,
                    dir: relDir,
                    media_type: cand.mediaType,
                    format: cand.ext,
                    file_size: fileSize,
                    mtime_ns: mtimeNs,
                    quick_hash: seedHash,
                    taken_at_ms: Math.trunc(st.mtimeMs),
                    exif_status: 0,
                    thumb_status: 0,
                  });

                  if (!existing) insertedThisScan.set(identityKey(cand.fullPath, fileSize, mtimeNs), cand.fullPath);

                  pendingEnrich.push({
                    path: cand.fullPath,
                    fileSize,
                    mtimeNs,
                    isVideo: cand.mediaType === 2,
                  });

                  const threshold = isFirstBatch ? FIRST_BATCH_SIZE : STEADY_BATCH_SIZE;
                  if (pendingInsert.length >= threshold) {
                    flushInsertBatch();
                  }
                } catch {
                  // Skip unreadable file
                }
              }),
            );
          }
        }),
      );
    }

    // Flush remaining fast-path items
    flushInsertBatch();
    checkCancelled(folderId); // never run deletions for a scan that was interrupted

    const removed = await removeVanished(folderId, rootPath, existingMap, seenPaths, unreadableDirs, insertedThisScan);

    // Phase B: Background Header-Only EXIF & GPS Enrichment Pool
    if (pendingEnrich.length > 0) {
      let cursor = 0;
      const enrichedBuffer: ExifEnrichmentRow[] = [];

      const flushEnrich = () => {
        if (enrichedBuffer.length === 0) return;
        const batch = enrichedBuffer.splice(0, enrichedBuffer.length);
        batchApplyEnrichment(batch);
        emit({
          type: 'scan:enriched',
          folderId,
          folderPath: rootPath,
          discovered,
          enriched,
          elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
          firstBatchMs,
        });
      };

      const worker = async () => {
        while (cursor < pendingEnrich.length && !cancelledScans.has(folderId)) {
          const job = pendingEnrich[cursor++];
          try {
            const meta = await parseHeaderMetadata(job.path, job.fileSize, job.mtimeNs, job.isVideo);
            enrichedBuffer.push({
              path: job.path,
              quick_hash: meta.quickHash,
              width: meta.width,
              height: meta.height,
              orientation: meta.orientation,
              taken_at_ms: meta.takenAtMs,
              camera_make: meta.cameraMake,
              camera_model: meta.cameraModel,
              lens_model: meta.lensModel,
              iso: meta.iso,
              aperture_f: meta.apertureF,
              shutter_us: meta.shutterUs,
              focal_length_mm: meta.focalLengthMm,
              duration_ms: meta.durationMs,
              has_gps: meta.hasGps,
              lat: meta.lat,
              lon: meta.lon,
              exif_status: 1,
            });
          } catch {
            enrichedBuffer.push({
              path: job.path,
              quick_hash: computeSeedHash(job.path, job.fileSize, job.mtimeNs),
              width: null,
              height: null,
              orientation: 1,
              taken_at_ms: null,
              camera_make: null,
              camera_model: null,
              lens_model: null,
              iso: null,
              aperture_f: null,
              shutter_us: null,
              focal_length_mm: null,
              has_gps: 0,
              lat: null,
              lon: null,
              exif_status: 2,
            });
          }

          enriched++;
          if (enrichedBuffer.length >= ENRICH_BATCH_SIZE) {
            flushEnrich();
          }
        }
      };

      await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, () => worker()));
      flushEnrich();
      checkCancelled(folderId);
    }

    relinkLivePhotos(folderId);

    emit({
      type: 'scan:complete',
      folderId,
      folderPath: rootPath,
      discovered,
      enriched,
      removed,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      firstBatchMs,
    });
  } catch (err) {
    emit({
      type: 'scan:error',
      folderId,
      folderPath: rootPath,
      discovered,
      enriched,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
