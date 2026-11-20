export type MediaType = 0 | 1 | 2; // 0: photo, 1: raw, 2: video

export interface FolderRecord {
  id: number;
  path: string;
  parent_id: number | null;
  last_scanned_at: number;
  item_count: number;
  volume_id: string | null;
}

export interface MediaRecord {
  id: number;
  folder_id: number;
  filename: string;
  path: string;
  media_type: MediaType;
  format: string;
  file_size: number;
  mtime_ns: number;
  quick_hash: string;
  width: number | null;
  height: number | null;
  orientation: number;
  taken_at_ms: number;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  iso: number | null;
  aperture_f: number | null;
  shutter_us: number | null;
  focal_length_mm: number | null;
  duration_ms: number | null;
  has_gps: number;
  lat: number | null;
  lon: number | null;
  exif_status: number; // 0: pending, 1: done, 2: error
  thumb_status: number; // 0: none, 1: exif_embedded_ok, 2: pyramid_ready, 3: error
  favorite: number;
  dir: string;
  live_video_id: number | null; // Live Photo: id of the motion clip
  live_component: number; // 1 = this video is the hidden motion part of a Live Photo
}

export interface MediaInsertInput {
  folder_id: number;
  filename: string;
  path: string;
  dir: string; // subfolder relative to the library folder, '' for its root
  media_type: MediaType;
  format: string;
  file_size: number;
  mtime_ns: number;
  quick_hash: string;
  width?: number | null;
  height?: number | null;
  orientation?: number;
  taken_at_ms: number;
  camera_make?: string | null;
  camera_model?: string | null;
  lens_model?: string | null;
  iso?: number | null;
  aperture_f?: number | null;
  shutter_us?: number | null;
  focal_length_mm?: number | null;
  duration_ms?: number | null;
  has_gps?: number;
  lat?: number | null;
  lon?: number | null;
  exif_status?: number;
  thumb_status?: number;
}

export interface MediaFilterParams {
  folderId?: number | null;
  dir?: string | null;
  q?: string | null;
  mediaType?: number | null;
  format?: string | null;
  camera?: string | null;
  lens?: string | null;
  isoMin?: number | null;
  isoMax?: number | null;
  apertureMin?: number | null;
  apertureMax?: number | null;
  dateFrom?: number | null;
  dateTo?: number | null;
  hasGps?: boolean | null;
  favorite?: boolean | null;
  minLat?: number | null;
  maxLat?: number | null;
  minLon?: number | null;
  maxLon?: number | null;
}

export interface FilterFacets {
  cameras: Array<{ value: string; count: number }>;
  lenses: Array<{ value: string; count: number }>;
  formats: Array<{ value: string; count: number }>;
  isoRange: { min: number | null; max: number | null };
  apertureRange: { min: number | null; max: number | null };
  dateRange: { min: number | null; max: number | null };
  gpsCount: number;
  totalCount: number;
}

export interface MapCluster {
  id: string;
  lat: number;
  lon: number;
  count: number;
  coverId: number;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface ScanEventPayload {
  type:
    | 'scan:started'
    | 'scan:batch'
    | 'scan:enriched'
    | 'scan:complete'
    | 'scan:error'
    | 'fs:changed'
    | 'library:changed' // folder went online/offline or moved to another drive letter
    | 'thumbs:progress';
  folderId: number;
  folderPath: string;
  discovered: number;
  enriched: number;
  elapsedMs: number;
  firstBatchMs?: number;
  removed?: number;
  done?: number;
  total?: number;
  message?: string;
}

export interface ThumbCacheStats {
  l0ExifHits: number;
  l2RamHits: number;
  l3DiskHits: number;
  sharpGenerated: number;
  videoFramesGenerated: number;
  l2RamBytes: number;
  l2RamEntries: number;
}
