import fs from 'node:fs/promises';
import path from 'node:path';

// On Windows, stat().dev is the volume serial number: it identifies a drive (e.g. an external HD)
// no matter which letter Windows gives it, and only changes if the drive is reformatted.

export async function getVolumeId(p: string): Promise<string | null> {
  try {
    const dev = (await fs.stat(path.parse(p).root)).dev;
    return dev ? String(dev) : null; // 0 = filesystem without a serial (some network shares)
  } catch {
    return null;
  }
}

/** "E:\Fotos\2024" -> "Fotos\2024": the part of the path that survives a drive-letter change. */
export function pathWithinVolume(p: string): string {
  return p.slice(path.parse(p).root.length);
}

/** Current mount root of a volume ("F:\"), or null when the drive isn't connected. */
export async function findVolumeRoot(volumeId: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const roots = Array.from({ length: 24 }, (_, i) => `${String.fromCharCode(67 + i)}:\\`); // C..Z
  const ids = await Promise.all(roots.map(getVolumeId));
  const idx = ids.indexOf(volumeId);
  return idx === -1 ? null : roots[idx];
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
