import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import exifr from 'exifr';

const HEADER_READ_BYTES = 262_144; // 256 KB header-only partial read
const EMBEDDED_THUMB_SCAN_BYTES = 524_288; // 512 KB max scan for RAW/JPEG embedded preview

export interface ParsedHeaderInfo {
  quickHash: string;
  width: number | null;
  height: number | null;
  orientation: number;
  takenAtMs: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  iso: number | null;
  apertureF: number | null;
  shutterUs: number | null;
  focalLengthMm: number | null;
  hasGps: number;
  lat: number | null;
  lon: number | null;
  durationMs: number | null; // videos only
}

const QT_EPOCH_OFFSET_S = 2_082_844_800; // seconds between 1904-01-01 (QuickTime) and 1970-01-01

/**
 * Duration and capture time of an MP4/MOV from its `mvhd` box. Walks top-level boxes by their
 * size fields (skipping the multi-GB `mdat` without reading it), so it costs a handful of tiny
 * reads even when `moov` sits at the end of the file, as it does in iPhone videos.
 */
export async function readMp4Info(
  filePath: string,
  fileSize: number,
): Promise<{ durationMs: number; createdMs: number | null } | null> {
  const fh = await fs.open(filePath, 'r');
  try {
    const hdr = Buffer.alloc(16);
    let off = 0;
    for (let i = 0; i < 64 && off + 8 <= fileSize; i++) {
      const { bytesRead } = await fh.read(hdr, 0, 16, off);
      if (bytesRead < 8) return null;
      let size = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      let headerLen = 8;
      if (size === 1) {
        if (bytesRead < 16) return null;
        size = Number(hdr.readBigUInt64BE(8));
        headerLen = 16;
      } else if (size === 0) {
        size = fileSize - off; // box runs to end of file
      }
      if (size < headerLen) return null; // corrupt: would loop forever

      if (type === 'moov') {
        const len = Math.min(size - headerLen, 8192);
        const buf = Buffer.alloc(len);
        const { bytesRead: n } = await fh.read(buf, 0, len, off + headerLen);
        const at = buf.subarray(0, n).indexOf('mvhd', 0, 'latin1');
        if (at < 4) return null;
        const p = at + 4; // version byte
        let created: number;
        let timescale: number;
        let duration: number;
        if (buf[p] === 1) {
          if (p + 32 > n) return null;
          created = Number(buf.readBigUInt64BE(p + 4));
          timescale = buf.readUInt32BE(p + 20);
          duration = Number(buf.readBigUInt64BE(p + 24));
        } else {
          if (p + 20 > n) return null;
          created = buf.readUInt32BE(p + 4);
          timescale = buf.readUInt32BE(p + 12);
          duration = buf.readUInt32BE(p + 16);
        }
        const createdMs = created > QT_EPOCH_OFFSET_S ? (created - QT_EPOCH_OFFSET_S) * 1000 : null;
        const plausible = createdMs !== null && createdMs > Date.UTC(1995, 0, 1) && createdMs < Date.now() + 86_400_000;
        return {
          durationMs: timescale > 0 ? Math.round((duration * 1000) / timescale) : 0,
          createdMs: plausible ? createdMs : null,
        };
      }
      off += size;
    }
    return null;
  } finally {
    await fh.close();
  }
}

export function computeSeedHash(filePath: string, fileSize: number, mtimeNs: number): string {
  return crypto
    .createHash('sha1')
    .update(`${filePath}|${fileSize}|${mtimeNs}`)
    .digest('hex')
    .slice(0, 20);
}

/**
 * Fast partial read of the first `maxBytes` of a file (never loads 40MB RAWs into RAM).
 */
async function readHeaderSlice(filePath: string, maxBytes: number): Promise<Buffer> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return bytesRead === maxBytes ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Fallback dimension reader for PNG and JPEG SOF headers when EXIF dimensions are missing.
 */
function parseQuickDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }

  // JPEG SOF0/SOF2 marker scan
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1];
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > buf.length) break;
      const len = buf.readUInt16BE(offset);
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (offset + 7 <= buf.length) {
          return {
            height: buf.readUInt16BE(offset + 3),
            width: buf.readUInt16BE(offset + 5),
          };
        }
      }
      if (len < 2) break;
      offset += len;
    }
  }

  return null;
}

export async function parseHeaderMetadata(
  filePath: string,
  fileSize: number,
  mtimeNs: number,
  isVideo: boolean,
): Promise<ParsedHeaderInfo> {
  const headerBuf = await readHeaderSlice(filePath, isVideo ? 65_536 : HEADER_READ_BYTES);
  const hashSlice = headerBuf.subarray(0, Math.min(65_536, headerBuf.length));
  const quickHash = crypto
    .createHash('sha1')
    .update(hashSlice)
    .update(`|${fileSize}|${mtimeNs}`)
    .digest('hex')
    .slice(0, 20);

  const result: ParsedHeaderInfo = {
    quickHash,
    width: null,
    height: null,
    orientation: 1,
    takenAtMs: null,
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
    iso: null,
    apertureF: null,
    shutterUs: null,
    focalLengthMm: null,
    hasGps: 0,
    lat: null,
    lon: null,
    durationMs: null,
  };

  if (isVideo) {
    const info = await readMp4Info(filePath, fileSize).catch(() => null);
    result.durationMs = info?.durationMs ?? 0; // 0 = read but unknown, so it isn't retried every scan
    result.takenAtMs = info?.createdMs ?? null;
    return result;
  }

  try {
    const exif = await exifr.parse(headerBuf, {
      tiff: true,
      exif: true,
      gps: true,
      translateValues: false,
      pick: [
        'DateTimeOriginal',
        'CreateDate',
        'Make',
        'Model',
        'LensModel',
        'ISO',
        'FNumber',
        'ExposureTime',
        'FocalLength',
        'ExifImageWidth',
        'ExifImageHeight',
        'ImageWidth',
        'ImageHeight',
        'Orientation',
        'latitude',
        'longitude',
      ],
    });

    if (exif) {
      const dt = exif.DateTimeOriginal ?? exif.CreateDate;
      if (dt instanceof Date && !Number.isNaN(dt.getTime())) {
        result.takenAtMs = dt.getTime();
      }
      if (typeof exif.Make === 'string') result.cameraMake = exif.Make.trim();
      if (typeof exif.Model === 'string') result.cameraModel = exif.Model.trim();
      if (typeof exif.LensModel === 'string') result.lensModel = exif.LensModel.trim();
      if (typeof exif.ISO === 'number') result.iso = Math.round(exif.ISO);
      if (typeof exif.FNumber === 'number') result.apertureF = Number(exif.FNumber.toFixed(2));
      if (typeof exif.ExposureTime === 'number' && exif.ExposureTime > 0) {
        result.shutterUs = Math.round(exif.ExposureTime * 1_000_000);
      }
      if (typeof exif.FocalLength === 'number') {
        result.focalLengthMm = Number(exif.FocalLength.toFixed(1));
      }
      const w = exif.ExifImageWidth ?? exif.ImageWidth;
      const h = exif.ExifImageHeight ?? exif.ImageHeight;
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
        result.width = w;
        result.height = h;
      }
      if (typeof exif.Orientation === 'number') {
        result.orientation = exif.Orientation;
      }
      if (
        typeof exif.latitude === 'number' &&
        typeof exif.longitude === 'number' &&
        !Number.isNaN(exif.latitude) &&
        !Number.isNaN(exif.longitude)
      ) {
        result.hasGps = 1;
        result.lat = exif.latitude;
        result.lon = exif.longitude;
      }
    }
  } catch {
    // Non-EXIF files (PNG, WebP, etc.) fall through cleanly
  }

  if (result.width === null || result.height === null) {
    const dims = parseQuickDimensions(headerBuf);
    if (dims) {
      result.width = dims.width;
      result.height = dims.height;
    }
  }

  return result;
}

/**
 * L0 Cold Start Zero-Generation Extractor:
 * Reads only the file header (<= 512KB) and extracts the embedded EXIF/RAW JPEG thumbnail in ~1-3ms.
 */
export async function extractEmbeddedThumbnail(filePath: string): Promise<Buffer | null> {
  try {
    const headerBuf = await readHeaderSlice(filePath, EMBEDDED_THUMB_SCAN_BYTES);
    const thumb = await exifr.thumbnail(headerBuf);
    if (thumb && thumb.byteLength > 512) {
      return Buffer.from(thumb);
    }
  } catch {
    // No embedded EXIF thumbnail available
  }
  return null;
}
