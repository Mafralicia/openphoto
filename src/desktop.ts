import { useState } from 'react';

/** Native bridge exposed by electron/preload.ts. Null when the UI runs in a plain browser (npm run dev). */
export interface DesktopBridge {
  pickFolder(): Promise<string | null>;
  pathForFile(file: File): string;
  reveal(id: number): Promise<void>;
  openExternal(id: number): Promise<void>;
  trash(ids: number[]): Promise<number>;
  onUpdateReady(cb: (version: string) => void): void;
  installUpdate(): Promise<void>;
}

export const desktop: DesktopBridge | null =
  (window as unknown as { openphoto?: DesktopBridge }).openphoto ?? null;

/** useState that survives restarts (per-viewer UI preferences only). */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`openphoto:${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (v: T | ((prev: T) => T)) =>
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      try {
        localStorage.setItem(`openphoto:${key}`, JSON.stringify(next));
      } catch {
        // storage unavailable: preference just isn't remembered
      }
      return next;
    });
  return [value, set];
}
