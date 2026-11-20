import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  FilterFacets,
  FolderRecord,
  MapCluster,
  MediaFilterParams,
  MediaInsertInput,
  MediaRecord,
} from './types.ts';

export const DATA_DIR = process.env.OPENPHOTO_DATA_DIR || path.resolve(process.cwd(), '.openphoto');
const DB_PATH = path.join(DATA_DIR, 'openphoto.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA mmap_size = 268435456;
  PRAGMA cache_size = -64000;
  PRAGMA foreign_keys = ON;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    parent_id INTEGER NULL REFERENCES folders(id) ON DELETE CASCADE,
    last_scanned_at INTEGER NOT NULL DEFAULT 0,
    item_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    path TEXT UNIQUE NOT NULL,
    media_type INTEGER NOT NULL DEFAULT 0,
    format TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    quick_hash TEXT NOT NULL,
    width INTEGER NULL,
    height INTEGER NULL,
    orientation INTEGER NOT NULL DEFAULT 1,
    taken_at_ms INTEGER NOT NULL,
    camera_make TEXT NULL,
    camera_model TEXT NULL,
    lens_model TEXT NULL,
    iso INTEGER NULL,
    aperture_f REAL NULL,
    shutter_us INTEGER NULL,
    focal_length_mm REAL NULL,
    duration_ms INTEGER NULL,
    has_gps INTEGER NOT NULL DEFAULT 0,
    lat REAL NULL,
    lon REAL NULL,
    exif_status INTEGER NOT NULL DEFAULT 0,
    thumb_status INTEGER NOT NULL DEFAULT 0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS media_rtree USING rtree(
    id,
    min_lat, max_lat,
    min_lon, max_lon
  );

  CREATE INDEX IF NOT EXISTS idx_media_timeline
    ON media(taken_at_ms DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_media_folder
    ON media(folder_id, taken_at_ms DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_media_gear
    ON media(camera_make, camera_model, lens_model, taken_at_ms DESC);

  CREATE INDEX IF NOT EXISTS idx_media_exposure
    ON media(format, iso, aperture_f, taken_at_ms DESC);

  CREATE INDEX IF NOT EXISTS idx_media_queue
    ON media(thumb_status, taken_at_ms DESC);

  UPDATE media SET mtime_ns = mtime_ns / 1000000 WHERE mtime_ns > 9007199254740991;
`);

// Migration: favorites (kept on rescans because the upsert never touches this column)
const mediaColumns = db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string }>;
if (!mediaColumns.some((c) => c.name === 'favorite')) {
  db.exec('ALTER TABLE media ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0');
}

// Migration: volume serial per folder, so a drive that comes back under another letter is recognized
const folderColumns = db.prepare('PRAGMA table_info(folders)').all() as Array<{ name: string }>;
if (!folderColumns.some((c) => c.name === 'volume_id')) {
  db.exec('ALTER TABLE folders ADD COLUMN volume_id TEXT NULL');
}

// Migration: subfolder of each file relative to its library folder ('' = root), for the folder tree
if (!mediaColumns.some((c) => c.name === 'dir')) {
  db.exec("ALTER TABLE media ADD COLUMN dir TEXT NOT NULL DEFAULT ''");
  const rows = db
    .prepare('SELECT m.id, m.path, f.path AS root FROM media m JOIN folders f ON f.id = m.folder_id')
    .all() as Array<{ id: number; path: string; root: string }>;
  const setDir = db.prepare('UPDATE media SET dir = ? WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) setDir.run(path.relative(r.root, path.dirname(r.path)), r.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_media_folder_dir ON media(folder_id, dir)');

// Migration: Live Photos. The photo points at its motion clip; the clip is hidden from listings.
if (!mediaColumns.some((c) => c.name === 'live_video_id')) {
  db.exec('ALTER TABLE media ADD COLUMN live_video_id INTEGER NULL');
  db.exec('ALTER TABLE media ADD COLUMN live_component INTEGER NOT NULL DEFAULT 0');
}

// Live Photo clips are ~3s. A same-named video longer than this is a real video whose number collided
// (iPhone numbering wraps at 9999), so it stays a separate item.
const LIVE_MAX_MS = 4500;
const HEIF_FORMATS = "('heic','heif')";

const SORT_SQL: Record<string, string> = {
  date_desc: 'm.taken_at_ms DESC, m.id DESC',
  date_asc: 'm.taken_at_ms ASC, m.id ASC',
  name: 'm.filename COLLATE NOCASE ASC, m.id ASC',
  size: 'm.file_size DESC, m.id DESC',
};

const stmtUpsertFolder = db.prepare(`
  INSERT INTO folders (path, parent_id, last_scanned_at, item_count)
  VALUES (?, ?, ?, 0)
  ON CONFLICT(path) DO UPDATE SET last_scanned_at = excluded.last_scanned_at
  RETURNING id, path, parent_id, last_scanned_at, item_count
`);

const stmtUpsertMedia = db.prepare(`
  INSERT INTO media (
    folder_id, filename, path, media_type, format, file_size, mtime_ns, quick_hash,
    width, height, orientation, taken_at_ms,
    camera_make, camera_model, lens_model, iso, aperture_f, shutter_us, focal_length_mm,
    duration_ms, has_gps, lat, lon, exif_status, thumb_status, dir
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?
  )
  ON CONFLICT(path) DO UPDATE SET
    dir = excluded.dir,
    file_size = excluded.file_size,
    mtime_ns = excluded.mtime_ns,
    quick_hash = excluded.quick_hash,
    thumb_status = 0,
    taken_at_ms = CASE WHEN media.exif_status = 1 THEN media.taken_at_ms ELSE excluded.taken_at_ms END
  -- A row never changes owner through a scan: that's how a nested folder used to steal (and on removal, delete) rows
  WHERE media.folder_id = excluded.folder_id
`);

const stmtUpdateEnrichment = db.prepare(`
  UPDATE media SET
    quick_hash = ?,
    width = COALESCE(?, width),
    height = COALESCE(?, height),
    orientation = COALESCE(?, orientation),
    taken_at_ms = COALESCE(?, taken_at_ms),
    duration_ms = COALESCE(?, duration_ms),
    camera_make = ?,
    camera_model = ?,
    lens_model = ?,
    iso = ?,
    aperture_f = ?,
    shutter_us = ?,
    focal_length_mm = ?,
    has_gps = ?,
    lat = ?,
    lon = ?,
    exif_status = ?
  WHERE path = ?
  RETURNING id
`);

const stmtUpsertRtree = db.prepare(`
  INSERT OR REPLACE INTO media_rtree (id, min_lat, max_lat, min_lon, max_lon)
  VALUES (?, ?, ?, ?, ?)
`);

const stmtDeleteRtree = db.prepare(`DELETE FROM media_rtree WHERE id = ?`);

const stmtUpdateFolderCount = db.prepare(`
  UPDATE folders
  SET item_count = (SELECT COUNT(*) FROM media WHERE folder_id = ? AND live_component = 0),
      last_scanned_at = ?
  WHERE id = ?
`);

const stmtUpdateThumbStatus = db.prepare(`
  UPDATE media SET thumb_status = ? WHERE id = ?
`);

export function upsertFolder(folderPath: string, parentId: number | null = null): FolderRecord {
  const normalized = path.resolve(folderPath);
  return stmtUpsertFolder.get(normalized, parentId, Date.now()) as unknown as FolderRecord;
}

export function listFolders(): FolderRecord[] {
  // Stable order (by creation) so the sidebar doesn't reshuffle after every background rescan
  return db
    .prepare('SELECT id, path, parent_id, last_scanned_at, item_count, volume_id FROM folders ORDER BY id')
    .all() as unknown as FolderRecord[];
}

/** A few files of a folder, spread across it, to confirm a candidate location really holds this library. */
export function sampleFolderMedia(folderId: number, n: number): Array<{ path: string; file_size: number }> {
  return db
    .prepare(
      `SELECT path, file_size FROM media WHERE folder_id = ? AND id IN (
         SELECT id FROM media WHERE folder_id = ? ORDER BY (id * 2654435761) % 4294967296 LIMIT ?)`,
    )
    .all(folderId, folderId, n) as Array<{ path: string; file_size: number }>;
}

export function setFolderVolume(folderId: number, volumeId: string | null): void {
  db.prepare('UPDATE folders SET volume_id = ? WHERE id = ?').run(volumeId, folderId);
}

/**
 * Moves a library folder to a new location (e.g. the external drive came back as F: instead of E:).
 * Rewrites the stored paths in place, so EXIF, favorites and thumbnails are all kept.
 */
export function relocateFolder(folderId: number, newPath: string): void {
  const folder = db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as { path: string } | undefined;
  if (!folder || folder.path === newPath) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // substr/length run in SQLite so character counting matches how the paths are stored
    db.prepare('UPDATE media SET path = ? || substr(path, length(?) + 1) WHERE folder_id = ?').run(
      newPath,
      folder.path,
      folderId,
    );
    db.prepare('UPDATE folders SET path = ? WHERE id = ?').run(newPath, folderId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface ExistingMediaRow {
  id: number;
  path: string;
  file_size: number;
  mtime_ns: number;
  exif_status: number;
  media_type: number;
  duration_ms: number | null;
}

/** Windows paths are case-insensitive: "Fotos" renamed to "fotos" is the same file, not a new one. */
export const pathKey = process.platform === 'win32' ? (p: string) => p.toLowerCase() : (p: string) => p;

/** Existing rows of a folder keyed by pathKey(path). */
export function getExistingMediaMap(folderId: number): Map<string, ExistingMediaRow> {
  const rows = db
    .prepare('SELECT id, path, file_size, mtime_ns, exif_status, media_type, duration_ms FROM media WHERE folder_id = ?')
    .all(folderId) as unknown as ExistingMediaRow[];
  const map = new Map<string, ExistingMediaRow>();
  for (const r of rows) map.set(pathKey(r.path), r);
  return map;
}

/**
 * Points an existing row at a new path (file moved/renamed inside the library, or its case changed),
 * keeping its id, favorite, EXIF and thumbnail. Drops any row that was just inserted for the new path.
 */
export function moveMediaRow(id: number, newPath: string, newDir: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const dup = db.prepare('SELECT id, favorite FROM media WHERE path = ? AND id != ?').get(newPath, id) as
      | { id: number; favorite: number }
      | undefined;
    if (dup) {
      stmtDeleteRtree.run(dup.id);
      db.prepare('DELETE FROM media WHERE id = ?').run(dup.id);
      if (dup.favorite) db.prepare('UPDATE media SET favorite = 1 WHERE id = ?').run(id); // favorited at the new path meanwhile
    }
    db.prepare('UPDATE media SET path = ?, dir = ?, filename = ? WHERE id = ?').run(newPath, newDir, path.basename(newPath), id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * The user added a folder that contains an existing library folder: fold the child's rows into the
 * parent (dir gets the child's relative path as prefix) instead of rescanning them as new.
 */
export function mergeFolderInto(childId: number, parentId: number, childRel: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE media SET folder_id = ?, dir = CASE WHEN dir = '' THEN ? ELSE ? || dir END WHERE folder_id = ?`,
    ).run(parentId, childRel, childRel + path.sep, childId);
    db.prepare('DELETE FROM folders WHERE id = ?').run(childId);
    stmtUpdateFolderCount.run(parentId, Date.now(), parentId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Pairs iPhone Live Photos: IMG_1234.HEIC + IMG_1234.MOV/MP4 in the same subfolder, clip <= LIVE_MAX_MS.
 * Recomputed from scratch per folder (cheap: one pass over the rows), so renames and deletions fix themselves.
 */
export function relinkLivePhotos(folderId: number): number {
  const rows = db
    .prepare('SELECT id, dir, filename, media_type, duration_ms FROM media WHERE folder_id = ?')
    .all(folderId) as Array<{ id: number; dir: string; filename: string; media_type: number; duration_ms: number | null }>;
  const key = (r: { dir: string; filename: string }) => `${r.dir.toLowerCase()}\0${r.filename.replace(/\.[^.]+$/, '').toLowerCase()}`;
  const clips = new Map<string, number>();
  for (const r of rows) {
    if (r.media_type === 2 && r.duration_ms !== null && r.duration_ms > 0 && r.duration_ms <= LIVE_MAX_MS) clips.set(key(r), r.id);
  }
  const pairs: Array<[number, number]> = [];
  for (const r of rows) {
    if (r.media_type === 2) continue;
    const clip = clips.get(key(r));
    if (clip !== undefined) {
      pairs.push([r.id, clip]);
      clips.delete(key(r)); // one clip per photo (IMG_1.HEIC + IMG_1.JPG must not share it)
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE media SET live_video_id = NULL, live_component = 0 WHERE folder_id = ? AND (live_video_id IS NOT NULL OR live_component = 1)').run(folderId);
    const setPhoto = db.prepare('UPDATE media SET live_video_id = ? WHERE id = ?');
    const setClip = db.prepare('UPDATE media SET live_component = 1 WHERE id = ?');
    for (const [photo, clip] of pairs) {
      setPhoto.run(clip, photo);
      setClip.run(clip);
    }
    stmtUpdateFolderCount.run(folderId, Date.now(), folderId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return pairs.length;
}

export function deleteMediaByIds(ids: number[], folderId: number): void {
  if (ids.length === 0) return;
  const delRow = db.prepare('DELETE FROM media WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) {
      stmtDeleteRtree.run(id);
      delRow.run(id);
    }
    stmtUpdateFolderCount.run(folderId, Date.now(), folderId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Distinct subfolders of a library folder with their direct item counts. */
export function listFolderDirs(folderId: number): Array<{ dir: string; count: number }> {
  return db
    .prepare('SELECT dir, COUNT(*) AS count FROM media WHERE folder_id = ? AND live_component = 0 GROUP BY dir')
    .all(folderId) as unknown as Array<{ dir: string; count: number }>;
}

// Thumbnails pending on disk (0 = none, 1 = only the embedded EXIF preview was seen). Live clips are
// never shown in the grid, so they're skipped. Videos and HEIC need ffmpeg: without it they're left
// pending (not failed) so they get done once ffmpeg is available.
const backfillWhere = (withFfmpeg: boolean) =>
  `folder_id = ? AND thumb_status IN (0, 1) AND live_component = 0` +
  (withFfmpeg ? '' : ` AND media_type != 2 AND lower(format) NOT IN ${HEIF_FORMATS}`);

export function nextThumbBackfill(folderId: number, limit: number, withFfmpeg: boolean): MediaRecord[] {
  return db
    .prepare(`SELECT * FROM media WHERE ${backfillWhere(withFfmpeg)} ORDER BY taken_at_ms DESC LIMIT ?`)
    .all(folderId, limit) as unknown as MediaRecord[];
}

export function countThumbBackfill(folderId: number, withFfmpeg: boolean): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${backfillWhere(withFfmpeg)}`).get(folderId) as { n: number };
  return row.n;
}

/** ffmpeg became available: give videos/HEIC that failed for lack of it another chance. */
export function resetFfmpegThumbFailures(): void {
  db.prepare(`UPDATE media SET thumb_status = 0 WHERE thumb_status = 3 AND (media_type = 2 OR lower(format) IN ${HEIF_FORMATS})`).run();
}

export function batchUpsertMedia(records: MediaInsertInput[], folderId: number): void {
  if (records.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of records) {
      stmtUpsertMedia.run(
        r.folder_id,
        r.filename,
        r.path,
        r.media_type,
        r.format,
        r.file_size,
        r.mtime_ns,
        r.quick_hash,
        r.width ?? null,
        r.height ?? null,
        r.orientation ?? 1,
        r.taken_at_ms,
        r.camera_make ?? null,
        r.camera_model ?? null,
        r.lens_model ?? null,
        r.iso ?? null,
        r.aperture_f ?? null,
        r.shutter_us ?? null,
        r.focal_length_mm ?? null,
        r.duration_ms ?? null,
        r.has_gps ?? 0,
        r.lat ?? null,
        r.lon ?? null,
        r.exif_status ?? 0,
        r.thumb_status ?? 0,
        r.dir,
      );
    }
    stmtUpdateFolderCount.run(folderId, Date.now(), folderId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface ExifEnrichmentRow {
  path: string;
  quick_hash: string;
  width: number | null;
  height: number | null;
  orientation: number;
  taken_at_ms: number | null;
  duration_ms?: number | null;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  iso: number | null;
  aperture_f: number | null;
  shutter_us: number | null;
  focal_length_mm: number | null;
  has_gps: number;
  lat: number | null;
  lon: number | null;
  exif_status: number;
}

export function batchApplyEnrichment(rows: ExifEnrichmentRow[]): void {
  if (rows.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      const updated = stmtUpdateEnrichment.get(
        r.quick_hash,
        r.width,
        r.height,
        r.orientation,
        r.taken_at_ms,
        r.duration_ms ?? null,
        r.camera_make,
        r.camera_model,
        r.lens_model,
        r.iso,
        r.aperture_f,
        r.shutter_us,
        r.focal_length_mm,
        r.has_gps,
        r.lat,
        r.lon,
        r.exif_status,
        r.path,
      ) as { id: number } | undefined;

      if (updated && r.has_gps === 1 && r.lat !== null && r.lon !== null) {
        stmtUpsertRtree.run(updated.id, r.lat, r.lat, r.lon, r.lon);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function deleteMediaByPath(filePath: string, folderId: number): boolean {
  const row = db.prepare('SELECT id FROM media WHERE path = ?').get(filePath) as { id: number } | undefined;
  if (!row) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    stmtDeleteRtree.run(row.id);
    db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
    stmtUpdateFolderCount.run(folderId, Date.now(), folderId);
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function buildFilterQuery(filters: MediaFilterParams): {
  joinSql: string;
  whereSql: string;
  bindings: SQLInputValue[];
} {
  const clauses: string[] = ['m.live_component = 0']; // Live clips are shown through their photo
  const bindings: SQLInputValue[] = [];
  let joinSql = '';

  const hasBbox =
    typeof filters.minLat === 'number' &&
    typeof filters.maxLat === 'number' &&
    typeof filters.minLon === 'number' &&
    typeof filters.maxLon === 'number' &&
    !Number.isNaN(filters.minLat) &&
    !Number.isNaN(filters.maxLat) &&
    !Number.isNaN(filters.minLon) &&
    !Number.isNaN(filters.maxLon);

  if (hasBbox) {
    joinSql = 'INNER JOIN media_rtree rt ON rt.id = m.id';
    clauses.push('rt.min_lat >= ? AND rt.max_lat <= ?');
    bindings.push(filters.minLat!, filters.maxLat!);

    // Handle antimeridian wrap if minLon > maxLon
    if (filters.minLon! <= filters.maxLon!) {
      clauses.push('rt.min_lon >= ? AND rt.max_lon <= ?');
      bindings.push(filters.minLon!, filters.maxLon!);
    } else {
      clauses.push('(rt.min_lon >= ? OR rt.max_lon <= ?)');
      bindings.push(filters.minLon!, filters.maxLon!);
    }
  }

  if (typeof filters.folderId === 'number' && !Number.isNaN(filters.folderId)) {
    clauses.push('m.folder_id = ?');
    bindings.push(filters.folderId);
  }

  // Subfolder including everything below it. The separator in the prefix keeps "A" from matching "AB".
  if (filters.dir) {
    const prefix = `${filters.dir}${path.sep}`.replace(/[!%_]/g, '!$&');
    clauses.push("(m.dir = ? OR m.dir LIKE ? ESCAPE '!')");
    bindings.push(filters.dir, `${prefix}%`);
  }

  if (filters.q && filters.q.trim().length > 0) {
    const like = `%${filters.q.trim()}%`;
    clauses.push('(m.filename LIKE ? OR m.camera_model LIKE ? OR m.lens_model LIKE ? OR m.path LIKE ?)');
    bindings.push(like, like, like, like);
  }

  if (typeof filters.mediaType === 'number' && !Number.isNaN(filters.mediaType)) {
    clauses.push('m.media_type = ?');
    bindings.push(filters.mediaType);
  }

  if (filters.format && filters.format.trim().length > 0) {
    clauses.push('m.format = ?');
    bindings.push(filters.format.trim().toLowerCase());
  }

  if (filters.camera && filters.camera.trim().length > 0) {
    clauses.push('m.camera_model = ?');
    bindings.push(filters.camera.trim());
  }

  if (filters.lens && filters.lens.trim().length > 0) {
    clauses.push('m.lens_model = ?');
    bindings.push(filters.lens.trim());
  }

  if (typeof filters.isoMin === 'number' && !Number.isNaN(filters.isoMin)) {
    clauses.push('m.iso >= ?');
    bindings.push(filters.isoMin);
  }

  if (typeof filters.isoMax === 'number' && !Number.isNaN(filters.isoMax)) {
    clauses.push('m.iso <= ?');
    bindings.push(filters.isoMax);
  }

  if (typeof filters.apertureMin === 'number' && !Number.isNaN(filters.apertureMin)) {
    clauses.push('m.aperture_f >= ?');
    bindings.push(filters.apertureMin);
  }

  if (typeof filters.apertureMax === 'number' && !Number.isNaN(filters.apertureMax)) {
    clauses.push('m.aperture_f <= ?');
    bindings.push(filters.apertureMax);
  }

  if (typeof filters.dateFrom === 'number' && !Number.isNaN(filters.dateFrom)) {
    clauses.push('m.taken_at_ms >= ?');
    bindings.push(filters.dateFrom);
  }

  if (typeof filters.dateTo === 'number' && !Number.isNaN(filters.dateTo)) {
    clauses.push('m.taken_at_ms <= ?');
    bindings.push(filters.dateTo);
  }

  if (filters.hasGps) {
    clauses.push('m.has_gps = 1');
  }

  if (filters.favorite) {
    clauses.push('m.favorite = 1');
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return { joinSql, whereSql, bindings };
}

export function queryMediaPage(params: {
  filters: MediaFilterParams;
  offset: number;
  limit: number;
  sort?: string | null;
}): { items: MediaRecord[]; total: number; queryMs: number } {
  const start = performance.now();
  const { joinSql, whereSql, bindings } = buildFilterQuery(params.filters);
  const orderSql = SORT_SQL[params.sort ?? ''] ?? SORT_SQL.date_desc;

  const totalRow = db
    .prepare(`SELECT COUNT(*) as total FROM media m ${joinSql} ${whereSql}`)
    .get(...bindings) as { total: number };

  const items = db
    .prepare(
      `SELECT m.* FROM media m ${joinSql} ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ? OFFSET ?`,
    )
    .all(...bindings, params.limit, params.offset) as unknown as MediaRecord[];

  return {
    items,
    total: totalRow?.total ?? 0,
    queryMs: Number((performance.now() - start).toFixed(2)),
  };
}

export function getFilterFacets(folderId?: number | null): FilterFacets {
  const hasFolder = typeof folderId === 'number' && !Number.isNaN(folderId);
  const where = hasFolder ? 'WHERE live_component = 0 AND folder_id = ?' : 'WHERE live_component = 0';
  const bind: SQLInputValue[] = hasFolder ? [folderId!] : [];

  const cameras = db
    .prepare(
      `SELECT camera_model as value, COUNT(*) as count FROM media ${where} ${
        where ? 'AND' : 'WHERE'
      } camera_model IS NOT NULL AND camera_model != ''
       GROUP BY camera_model ORDER BY count DESC LIMIT 60`,
    )
    .all(...bind) as unknown as Array<{ value: string; count: number }>;

  const lenses = db
    .prepare(
      `SELECT lens_model as value, COUNT(*) as count FROM media ${where} ${
        where ? 'AND' : 'WHERE'
      } lens_model IS NOT NULL AND lens_model != ''
       GROUP BY lens_model ORDER BY count DESC LIMIT 60`,
    )
    .all(...bind) as unknown as Array<{ value: string; count: number }>;

  const formats = db
    .prepare(
      `SELECT format as value, COUNT(*) as count FROM media ${where}
       GROUP BY format ORDER BY count DESC`,
    )
    .all(...bind) as unknown as Array<{ value: string; count: number }>;

  const ranges = db
    .prepare(
      `SELECT
        MIN(iso) as minIso, MAX(iso) as maxIso,
        MIN(aperture_f) as minAp, MAX(aperture_f) as maxAp,
        MIN(taken_at_ms) as minDate, MAX(taken_at_ms) as maxDate,
        SUM(CASE WHEN has_gps = 1 THEN 1 ELSE 0 END) as gpsCount,
        COUNT(*) as totalCount
       FROM media ${where}`,
    )
    .get(...bind) as {
    minIso: number | null;
    maxIso: number | null;
    minAp: number | null;
    maxAp: number | null;
    minDate: number | null;
    maxDate: number | null;
    gpsCount: number | null;
    totalCount: number;
  };

  return {
    cameras,
    lenses,
    formats,
    isoRange: { min: ranges?.minIso ?? null, max: ranges?.maxIso ?? null },
    apertureRange: { min: ranges?.minAp ?? null, max: ranges?.maxAp ?? null },
    dateRange: { min: ranges?.minDate ?? null, max: ranges?.maxDate ?? null },
    gpsCount: ranges?.gpsCount ?? 0,
    totalCount: ranges?.totalCount ?? 0,
  };
}

/**
 * Spatial R-Tree query + zoom-aware hierarchical clustering for 2D Map and 3D Globe.
 */
export function queryMapClusters(params: {
  filters: MediaFilterParams;
  zoom: number;
}): { clusters: MapCluster[]; totalPoints: number; queryMs: number } {
  const start = performance.now();
  const filtersWithGps: MediaFilterParams = { ...params.filters, hasGps: true };
  const { joinSql, whereSql, bindings } = buildFilterQuery(filtersWithGps);

  // Pull only lightweight spatial columns via R-Tree index
  const rows = db
    .prepare(
      `SELECT m.id, m.lat, m.lon
       FROM media m ${joinSql} ${whereSql}
       ORDER BY m.taken_at_ms DESC
       LIMIT 50000`,
    )
    .all(...bindings) as unknown as Array<{ id: number; lat: number; lon: number }>;

  // Integer zoom: the cluster grid only changes at whole zoom steps, so markers stay put while zooming
  const z = Math.max(0, Math.min(20, Math.floor(params.zoom)));
  // Cell size in degrees shrinks exponentially with zoom
  const cellDeg = z >= 15 ? 0.0005 : 60 / Math.pow(2, z);

  const buckets = new Map<
    string,
    {
      sumLat: number;
      sumLon: number;
      count: number;
      coverId: number;
      minLat: number;
      maxLat: number;
      minLon: number;
      maxLon: number;
    }
  >();

  for (const pt of rows) {
    if (pt.lat === null || pt.lon === null) continue;
    const gx = Math.floor((pt.lon + 180) / cellDeg);
    const gy = Math.floor((pt.lat + 90) / cellDeg);
    const key = `${gx}:${gy}`;

    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        sumLat: pt.lat,
        sumLon: pt.lon,
        count: 1,
        coverId: pt.id,
        minLat: pt.lat,
        maxLat: pt.lat,
        minLon: pt.lon,
        maxLon: pt.lon,
      });
    } else {
      existing.sumLat += pt.lat;
      existing.sumLon += pt.lon;
      existing.count++;
      if (pt.lat < existing.minLat) existing.minLat = pt.lat;
      if (pt.lat > existing.maxLat) existing.maxLat = pt.lat;
      if (pt.lon < existing.minLon) existing.minLon = pt.lon;
      if (pt.lon > existing.maxLon) existing.maxLon = pt.lon;
    }
  }

  const clusters: MapCluster[] = [];
  for (const [key, b] of buckets) {
    clusters.push({
      id: key,
      lat: b.sumLat / b.count,
      lon: b.sumLon / b.count,
      count: b.count,
      coverId: b.coverId,
      minLat: b.minLat,
      maxLat: b.maxLat,
      minLon: b.minLon,
      maxLon: b.maxLon,
    });
  }

  // Keep highest-density clusters first (cap at 250 markers for 60/120fps WebGL/DOM)
  clusters.sort((a, b) => b.count - a.count);

  return {
    clusters: clusters.slice(0, 250),
    totalPoints: rows.length,
    queryMs: Number((performance.now() - start).toFixed(2)),
  };
}

export function getMediaById(id: number): MediaRecord | null {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id) as unknown as MediaRecord | undefined;
  return row ?? null;
}

export function getMediaByIds(ids: number[]): MediaRecord[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM media WHERE id IN (${placeholders})`)
    .all(...ids) as unknown as MediaRecord[];
}

export function setFavorite(ids: number[], value: boolean): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const res = db.prepare(`UPDATE media SET favorite = ? WHERE id IN (${placeholders})`).run(value ? 1 : 0, ...ids);
  return Number(res.changes);
}

/** Forgets a folder (and its media rows). Files on disk are never touched. */
export function removeFolder(folderId: number): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM media_rtree WHERE id IN (SELECT id FROM media WHERE folder_id = ?)').run(folderId);
    db.prepare('DELETE FROM media WHERE folder_id = ?').run(folderId);
    db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function updateThumbStatus(id: number, status: number): void {
  stmtUpdateThumbStatus.run(status, id);
}

export function getDbStats(): {
  totalMedia: number;
  totalFolders: number;
  gpsIndexed: number;
  exifDone: number;
  favorites: number;
  videos: number;
  raws: number;
} {
  return db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM media WHERE live_component = 0) as totalMedia,
        (SELECT COUNT(*) FROM media WHERE favorite = 1 AND live_component = 0) as favorites,
        (SELECT COUNT(*) FROM media WHERE media_type = 2 AND live_component = 0) as videos,
        (SELECT COUNT(*) FROM media WHERE media_type = 1) as raws,
        (SELECT COUNT(*) FROM folders) as totalFolders,
        (SELECT COUNT(*) FROM media WHERE has_gps = 1) as gpsIndexed,
        (SELECT COUNT(*) FROM media WHERE exif_status = 1) as exifDone`,
    )
    .get() as ReturnType<typeof getDbStats>;
}
