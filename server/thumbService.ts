import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { extractEmbeddedThumbnail } from './exifExtractor.ts';
import { countThumbBackfill, DATA_DIR, nextThumbBackfill, updateThumbStatus } from './db.ts';
import type { MediaRecord, ScanEventPayload, ThumbCacheStats } from './types.ts';

const execFileAsync = promisify(execFile);

const CACHE_ROOT = path.join(DATA_DIR, 'cache');
const L2_MAX_BYTES = 128 * 1024 * 1024; // 128 MB RAM LRU cache

interface ThumbResult {
  buffer: Buffer;
  contentType: string;
  tier: 'L2-ram' | 'L3-disk' | 'L0-exif' | 'sharp-generated' | 'video-frame';
}

const l2Cache = new Map<string, { buffer: Buffer; contentType: string }>();
let l2Bytes = 0;

const inFlight = new Map<string, Promise<ThumbResult | null>>();

// Priority queue: viewport/adjacent prefetch jobs go to the front (unshift)
const bgQueue: Array<{ media: MediaRecord; size: 'sm' | 'lg' }> = [];
const bgQueuedKeys = new Set<string>();
let bgWorkersActive = 0;
const BG_MAX_CONCURRENCY = 3;


export const thumbStats: ThumbCacheStats = {
  l0ExifHits: 0,
  l2RamHits: 0,
  l3DiskHits: 0,
  sharpGenerated: 0,
  videoFramesGenerated: 0,
  l2RamBytes: 0,
  l2RamEntries: 0,
};

function setL2(key: string, buffer: Buffer, contentType: string): void {
  const existing = l2Cache.get(key);
  if (existing) {
    l2Bytes -= existing.buffer.byteLength;
    l2Cache.delete(key);
  }
  l2Cache.set(key, { buffer, contentType });
  l2Bytes += buffer.byteLength;

  while (l2Bytes > L2_MAX_BYTES && l2Cache.size > 1) {
    const oldestKey = l2Cache.keys().next().value;
    if (!oldestKey) break;
    const oldest = l2Cache.get(oldestKey);
    if (oldest) l2Bytes -= oldest.buffer.byteLength;
    l2Cache.delete(oldestKey);
  }

  thumbStats.l2RamBytes = l2Bytes;
  thumbStats.l2RamEntries = l2Cache.size;
}

function getL2(key: string): { buffer: Buffer; contentType: string } | null {
  const entry = l2Cache.get(key);
  if (!entry) return null;
  l2Cache.delete(key);
  l2Cache.set(key, entry);
  return entry;
}

function getDiskCachePath(quickHash: string, size: 'sm' | 'lg'): string {
  const shard = quickHash.slice(0, 2) || '00';
  return path.join(CACHE_ROOT, shard, `${quickHash}_${size}.webp`);
}

// One shared check: concurrent callers during the first probe all await the same answer
let ffmpegCheck: Promise<boolean> | null = null;
export function hasFfmpeg(): Promise<boolean> {
  ffmpegCheck ??= execFileAsync('ffmpeg', ['-version'], { windowsHide: true, timeout: 5000 }).then(
    () => true,
    () => false,
  );
  return ffmpegCheck;
}

/** Write to a temp file then rename, so a concurrent reader never sees a half-written thumbnail. */
async function writeCacheFile(diskPath: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(diskPath), { recursive: true });
  const tmp = `${diskPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, diskPath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    // Duplicate files share a cache key; Windows refuses to rename over the copy another worker just
    // wrote. That copy is identical, so it counts as success.
    if (!existsSync(diskPath)) throw err;
  }
}

async function extractVideoKeyframeWebP(media: MediaRecord, size: 'sm' | 'lg'): Promise<Buffer | null> {
  if (!(await hasFfmpeg())) return null;
  const targetPx = size === 'sm' ? 360 : 1280;
  try {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      ['-ss', '00:00:00.5', '-i', media.path, '-vframes', '1', '-vf', `scale=${targetPx}:-2`, '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 15000 },
    );
    if (!stdout || stdout.byteLength < 256) return null;

    const webp = await sharp(stdout).webp({ quality: 78, effort: 2 }).toBuffer();
    await writeCacheFile(getDiskCachePath(media.quick_hash, size), webp);
    updateThumbStatus(media.id, 2);
    thumbStats.videoFramesGenerated++;
    return webp;
  } catch {
    return null;
  }
}

const isHeif = (media: MediaRecord) => media.format.toLowerCase() === 'heic' || media.format.toLowerCase() === 'heif';

/**
 * HEIC (iPhone) is HEVC inside, which the bundled image library can't decode (patents). ffmpeg 7.1+
 * decodes it and reassembles iPhone's 512px tile grid. Output is a full-size JPEG that sharp then resizes.
 */
async function decodeHeifWithFfmpeg(media: MediaRecord): Promise<Buffer | null> {
  if (!(await hasFfmpeg())) return null;
  try {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', media.path, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20000 },
    );
    if (!stdout || stdout.byteLength < 256) return null;
    // An ffmpeg that doesn't understand tile grids returns a single 512x512 tile: reject it rather than
    // caching a wrong thumbnail forever
    if (media.width && media.height) {
      const meta = await sharp(stdout).metadata();
      const got = Math.max(meta.width ?? 0, meta.height ?? 0);
      if (got < 0.9 * Math.max(media.width, media.height)) {
        console.warn(`[OpenPhoto] HEIC decoded at ${meta.width}x${meta.height}, expected ${media.width}x${media.height}: ffmpeg 7.1+ needed for tiled HEIC`);
        return null;
      }
    }
    return stdout;
  } catch {
    return null;
  }
}

async function generateAndPersistWebP(media: MediaRecord, size: 'sm' | 'lg'): Promise<Buffer | null> {
  if (media.media_type === 2) {
    return extractVideoKeyframeWebP(media, size);
  }

  const targetPx = size === 'sm' ? 360 : 2048;
  const quality = size === 'sm' ? 78 : 84;
  const render = (input: string | Buffer) =>
    sharp(input, { failOn: 'none', limitInputPixels: false })
      .rotate()
      .resize({
        width: targetPx,
        height: targetPx,
        fit: size === 'sm' ? 'cover' : 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality, effort: 2 })
      .toBuffer();

  try {
    let outBuf: Buffer;
    if (isHeif(media)) {
      const decoded = await decodeHeifWithFfmpeg(media);
      if (!decoded) return null;
      outBuf = await render(decoded);
    } else {
      try {
        outBuf = await render(media.path);
      } catch (err) {
        // Most RAW formats can't be decoded by sharp: fall back to the camera's embedded JPEG preview
        const embedded = await extractEmbeddedThumbnail(media.path);
        if (!embedded) throw err;
        outBuf = await render(embedded);
      }
    }

    await writeCacheFile(getDiskCachePath(media.quick_hash, size), outBuf);
    if (size === 'sm') updateThumbStatus(media.id, 2);
    return outBuf;
  } catch {
    return null;
  }
}

export function enqueueThumbnailJob(media: MediaRecord, size: 'sm' | 'lg', highPriority = false): void {
  const key = `${media.quick_hash}_${size}`;
  if (l2Cache.has(key) || bgQueuedKeys.has(key)) return;
  if (bgQueue.length > 600 && !highPriority) return;

  bgQueuedKeys.add(key);
  if (highPriority) {
    bgQueue.unshift({ media, size });
  } else {
    bgQueue.push({ media, size });
  }
  drainBackgroundQueue();
}

function drainBackgroundQueue(): void {
  while (bgWorkersActive < BG_MAX_CONCURRENCY && bgQueue.length > 0) {
    const job = bgQueue.shift()!;
    const key = `${job.media.quick_hash}_${job.size}`;
    bgWorkersActive++;

    generateAndPersistWebP(job.media, job.size)
      .then((buf) => {
        if (buf) {
          setL2(key, buf, 'image/webp');
        }
      })
      .finally(() => {
        bgQueuedKeys.delete(key);
        bgWorkersActive--;
        drainBackgroundQueue();
      });
  }
}

// ---------- Background backfill: every small thumbnail on the internal disk, so browsing never waits on the HD ----------

let lastInteractiveAt = 0;
const backfillQueue: Array<{ folderId: number; root: string }> = [];
let backfillRunning = false;
const BACKFILL_CONCURRENCY = 2; // external HDDs are slow at random reads; 2 keeps the disk busy without thrashing

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once the item's small thumbnail is in the disk cache (generated now, or already there). */
async function ensureSmallThumb(media: MediaRecord): Promise<boolean> {
  try {
    await fs.access(getDiskCachePath(media.quick_hash, 'sm'));
    updateThumbStatus(media.id, 2);
    return true;
  } catch {
    // not cached yet
  }
  return (await generateAndPersistWebP(media, 'sm')) !== null;
}

const cancelledBackfills = new Set<number>();

export function queueThumbnailBackfill(
  folderId: number,
  root: string,
  emit: (event: ScanEventPayload) => void,
): void {
  cancelledBackfills.delete(folderId);
  if (!backfillQueue.some((j) => j.folderId === folderId)) backfillQueue.push({ folderId, root });
  if (!backfillRunning) void runBackfill(emit);
}

/** Stop touching a folder's drive (it's being ejected or removed). */
export function cancelThumbnailBackfill(folderId: number): void {
  cancelledBackfills.add(folderId);
  const idx = backfillQueue.findIndex((j) => j.folderId === folderId);
  if (idx !== -1) backfillQueue.splice(idx, 1);
}

async function runBackfill(emit: (event: ScanEventPayload) => void): Promise<void> {
  backfillRunning = true;
  try {
    while (backfillQueue.length > 0) {
      const { folderId, root } = backfillQueue.shift()!;
      const withFfmpeg = await hasFfmpeg(); // without it, videos/HEIC wait instead of being marked failed
      const total = countThumbBackfill(folderId, withFfmpeg);
      if (total === 0) continue;
      let done = 0;
      let stop = false;
      const progress = () =>
        emit({ type: 'thumbs:progress', folderId, folderPath: root, discovered: 0, enriched: 0, elapsedMs: 0, done, total });
      progress();

      while (!stop) {
        const batch = nextThumbBackfill(folderId, 48, withFfmpeg);
        if (batch.length === 0) break;
        let cursor = 0;
        const worker = async () => {
          while (!stop && cursor < batch.length) {
            if (cancelledBackfills.has(folderId)) {
              stop = true;
              return;
            }
            // Someone is scrolling: their thumbnails go first
            while (Date.now() - lastInteractiveAt < 400) await sleep(150);
            const media = batch[cursor++];
            if (await ensureSmallThumb(media)) {
              done++;
              continue;
            }
            if (!existsSync(root)) {
              stop = true; // drive unplugged: resume on reconnect, don't mark anything as failed
              return;
            }
            updateThumbStatus(media.id, 3); // undecodable or missing file: don't retry forever
            done++;
          }
        };
        await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, worker));
        if (!stop) progress();
      }
      // Always end with done === total so the UI drops the progress line (also when stopped early)
      done = total;
      progress();
    }
  } finally {
    backfillRunning = false;
  }
}

export async function getThumbnail(media: MediaRecord, size: 'sm' | 'lg'): Promise<ThumbResult | null> {
  lastInteractiveAt = Date.now();
  const cacheKey = `${media.quick_hash}_${size}`;

  const ramHit = getL2(cacheKey);
  if (ramHit) {
    thumbStats.l2RamHits++;
    return { buffer: ramHit.buffer, contentType: ramHit.contentType, tier: 'L2-ram' };
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const task = (async (): Promise<ThumbResult | null> => {
    const diskPath = getDiskCachePath(media.quick_hash, size);
    try {
      const diskBuf = await fs.readFile(diskPath);
      thumbStats.l3DiskHits++;
      setL2(cacheKey, diskBuf, 'image/webp');
      return { buffer: diskBuf, contentType: 'image/webp', tier: 'L3-disk' };
    } catch {
      // Cache miss on disk
    }

    if (size === 'sm' && media.media_type !== 2) {
      const embedded = await extractEmbeddedThumbnail(media.path);
      if (embedded) {
        thumbStats.l0ExifHits++;
        if (media.thumb_status === 0) {
          updateThumbStatus(media.id, 1);
        }
        enqueueThumbnailJob(media, 'sm', false);
        return { buffer: embedded, contentType: 'image/jpeg', tier: 'L0-exif' };
      }
    }

    const generated = await generateAndPersistWebP(media, size);
    if (generated) {
      if (media.media_type !== 2) thumbStats.sharpGenerated++;
      setL2(cacheKey, generated, 'image/webp');
      return {
        buffer: generated,
        contentType: 'image/webp',
        tier: media.media_type === 2 ? 'video-frame' : 'sharp-generated',
      };
    }

    return null;
  })();

  inFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inFlight.delete(cacheKey);
  }
}
