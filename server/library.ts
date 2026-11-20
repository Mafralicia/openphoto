import fs from 'node:fs/promises';
import path from 'node:path';
import {
  listFolders,
  mergeFolderInto,
  pathKey,
  relocateFolder,
  resetFfmpegThumbFailures,
  sampleFolderMedia,
  setFolderVolume,
  upsertFolder,
} from './db.ts';
import { cancelScan, scanDirectory } from './scanner.ts';
import { cancelThumbnailBackfill, hasFfmpeg, queueThumbnailBackfill } from './thumbService.ts';
import type { FolderRecord, ScanEventPayload } from './types.ts';
import { findVolumeRoot, getVolumeId, isDirectory, pathWithinVolume } from './volumes.ts';
import { isWatching, unwatchFolder, watchFolder } from './watcher.ts';

// Keeps library folders in sync with what's plugged in: external drives come and go, and come back
// under a different letter. Rows (EXIF, favorites, thumbnails) are never dropped because a drive is
// missing; the folder just shows as offline until it returns.

type Emit = (event: ScanEventPayload) => void;

const POLL_MS = 5000;
const online = new Map<number, boolean>();
const removed = new Set<number>(); // ids are never reused, so this can't hide a future folder
const ejected = new Set<number>(); // user released the drive: hands off until it's unplugged and back
let reconciling = false;

const changed = (emit: Emit, f: { id: number; path: string }) =>
  emit({ type: 'library:changed', folderId: f.id, folderPath: f.path, discovered: 0, enriched: 0, elapsedMs: 0 });

const isInside = (child: string, parent: string) => pathKey(child).startsWith(pathKey(parent) + path.sep);

export function isFolderOnline(folderId: number): boolean {
  return online.get(folderId) === true;
}

function stopTouching(folderId: number): void {
  unwatchFolder(folderId);
  cancelThumbnailBackfill(folderId);
  cancelScan(folderId);
}

export function forgetFolder(folderId: number): void {
  removed.add(folderId);
  stopTouching(folderId);
  online.delete(folderId);
}

/** Releases the drive (closes the watcher, stops scans/thumbnails) so Windows lets the user eject it. */
export function ejectFolder(folderId: number, emit: Emit): void {
  const folder = listFolders().find((f) => f.id === folderId);
  if (!folder) return;
  ejected.add(folderId);
  stopTouching(folderId);
  online.set(folderId, false);
  changed(emit, folder);
}

function runScan(folderId: number, folderPath: string, emit: Emit): Promise<{ folderId: number }> {
  return scanDirectory(folderPath, (ev) => {
    emit(ev);
    if (ev.type === 'scan:complete') queueThumbnailBackfill(folderId, folderPath, emit);
  });
}

/** Watch + incremental scan + thumbnail backfill. */
function startSync(folderId: number, folderPath: string, emit: Emit): Promise<{ folderId: number }> {
  ejected.delete(folderId);
  online.set(folderId, true);
  unwatchFolder(folderId);
  watchFolder(folderId, folderPath, emit, () => void runScan(folderId, folderPath, emit).catch(() => {}));
  return runScan(folderId, folderPath, emit);
}

/** Do a few known files exist (same size) under `candidateRoot`? Confirms a folder moved there. */
async function holdsSameFiles(folder: FolderRecord, candidateRoot: string): Promise<boolean> {
  const sample = sampleFolderMedia(folder.id, 5);
  if (sample.length === 0) return false;
  for (const m of sample) {
    const rel = path.relative(folder.path, m.path); // media paths carry the same (possibly parked) prefix
    try {
      if ((await fs.stat(path.join(candidateRoot, rel))).size !== m.file_size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Where an offline folder lives now, if its drive is plugged in under another letter. */
async function findMovedLocation(folder: FolderRecord): Promise<string | null> {
  const inner = pathWithinVolume(folder.path.replace(/::relocating-\d+$/, ''));
  if (folder.volume_id) {
    const root = await findVolumeRoot(folder.volume_id);
    const candidate = root ? path.join(root, inner) : null;
    return candidate && candidate !== folder.path && (await isDirectory(candidate)) ? candidate : null;
  }
  // Folder indexed before volume serials were recorded: try the same path on every drive letter and
  // accept it only if sample files match
  if (process.platform !== 'win32' || !/^[A-Za-z]:\\/.test(folder.path)) return null;
  for (let c = 67; c <= 90; c++) {
    const candidate = path.join(`${String.fromCharCode(c)}:\\`, inner);
    if (pathKey(candidate) === pathKey(folder.path)) continue;
    if ((await isDirectory(candidate)) && (await holdsSameFiles(folder, candidate))) return candidate;
  }
  return null;
}

/**
 * Moves folder `f` to `target`. If another (displaced) folder still holds that path, as when two
 * drives swap letters, that one is parked on a temporary path first; the next iteration relocates it.
 */
function moveFolderTo(f: FolderRecord, target: string, folders: FolderRecord[]): boolean {
  const holder = folders.find((o) => o.id !== f.id && pathKey(o.path) === pathKey(target));
  if (holder) {
    if (online.get(holder.id) === true) return false; // genuinely in use there
    const parked = `${holder.path}::relocating-${holder.id}`;
    relocateFolder(holder.id, parked);
    holder.path = parked;
  }
  relocateFolder(f.id, target);
  console.log(`[OpenPhoto] ${f.path} -> ${target} (same drive, new letter)`);
  f.path = target;
  return true;
}

/**
 * Adds a folder from the UI. Returns the library folder (and subfolder) to show:
 * - inside an existing folder: nothing new is created, the UI just opens that subfolder;
 * - containing existing folders: those are folded into the new one, keeping favorites/EXIF;
 * - same drive under a new letter: the old entry is moved instead of duplicated.
 */
export async function addFolder(folderPath: string, emit: Emit): Promise<{ folderId: number; path: string; dir: string | null }> {
  const resolved = path.resolve(folderPath);
  if (!(await isDirectory(resolved))) throw new Error(`Pasta não encontrada: ${resolved}`);
  const volumeId = await getVolumeId(resolved);
  const folders = listFolders();

  const parent = folders.find((f) => isInside(resolved, f.path));
  if (parent) return { folderId: parent.id, path: parent.path, dir: path.relative(parent.path, resolved) };

  const same = folders.find((f) => pathKey(f.path) === pathKey(resolved));
  if (same?.volume_id && volumeId && same.volume_id !== volumeId) {
    throw new Error(
      `${resolved} já pertence a outro disco na biblioteca (desconectado agora). Conecte aquele disco ou remova a pasta antiga antes.`,
    );
  }

  if (!same) {
    // Same drive, new letter? Move the known (offline) entry here instead of starting over.
    for (const f of folders) {
      if (online.get(f.id) === true || pathKey(pathWithinVolume(f.path)) !== pathKey(pathWithinVolume(resolved))) continue;
      const sameDrive = f.volume_id ? f.volume_id === volumeId : await holdsSameFiles(f, resolved);
      if (sameDrive && !(await isDirectory(f.path))) {
        moveFolderTo(f, resolved, folders);
        break;
      }
    }
  }

  const folder = upsertFolder(same ? same.path : resolved, null);
  setFolderVolume(folder.id, volumeId);

  // Folders that live inside the new one become part of it
  for (const child of folders) {
    if (child.id !== folder.id && isInside(child.path, folder.path)) {
      forgetFolder(child.id);
      mergeFolderInto(child.id, folder.id, path.relative(folder.path, child.path));
    }
  }

  await startSync(folder.id, folder.path, emit);
  changed(emit, folder);
  return { folderId: folder.id, path: folder.path, dir: null };
}

async function reconcileFolder(folder: FolderRecord, folders: FolderRecord[], emit: Emit): Promise<void> {
  let present = await isDirectory(folder.path);
  // A different drive got this letter and happens to have the same path: not our folder.
  // Scanning it would look like every photo was deleted.
  if (present && folder.volume_id && (await getVolumeId(folder.path)) !== folder.volume_id) present = false;

  if (ejected.has(folder.id)) {
    if (!present) ejected.delete(folder.id); // unplugged after eject: next plug-in syncs normally
    return;
  }

  if (!present) {
    const moved = await findMovedLocation(folder);
    if (moved && moveFolderTo(folder, moved, folders)) present = true;
  }

  if (present && !folder.volume_id) setFolderVolume(folder.id, await getVolumeId(folder.path));

  const was = online.get(folder.id);
  if (present && (was !== true || !isWatching(folder.id))) {
    // First sighting since launch, reconnect, or the watcher died in a drive blip: catch up
    void startSync(folder.id, folder.path, emit).catch(() => online.set(folder.id, false));
    changed(emit, folder);
  } else if (!present && was !== false) {
    online.set(folder.id, false);
    stopTouching(folder.id);
    changed(emit, folder);
  }
}

async function reconcile(emit: Emit): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const folders = listFolders();
    for (const folder of folders) {
      if (removed.has(folder.id)) continue;
      try {
        await reconcileFolder(folder, folders, emit);
      } catch (err) {
        // One bad folder (e.g. a path conflict) must not stop the others from syncing
        console.warn(`[OpenPhoto] reconcile ${folder.path}:`, err);
      }
    }
  } finally {
    reconciling = false;
  }
}

export function startLibraryMonitor(emit: Emit): void {
  // ffmpeg installed since last time: retry the videos/HEIC that failed without it
  void hasFfmpeg().then((ok) => ok && resetFfmpegThumbFailures());
  void reconcile(emit);
  setInterval(() => void reconcile(emit), POLL_MS).unref();
}
