export interface FolderRecord {
  id: number;
  path: string;
  parent_id: number | null;
  last_scanned_at: number;
  item_count: number;
  online?: boolean; // false while its drive is disconnected
}

export interface MediaRecord {
  id: number;
  folder_id: number;
  filename: string;
  path: string;
  media_type: 0 | 1 | 2;
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
  exif_status: number;
  thumb_status: number;
  favorite: number;
  dir: string;
  live_video_id: number | null; // Live Photo: id of its motion clip
}

export type SortMode = 'date_desc' | 'date_asc' | 'name' | 'size';
export type LibraryScope = 'all' | 'favorites' | 'videos' | 'raw';

export interface LibraryStats {
  totalMedia: number;
  favorites: number;
  videos: number;
  raws: number;
  gpsIndexed: number;
}

export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface MediaFilterState {
  q: string;
  camera: string;
  lens: string;
  format: string;
  isoMin: string;
  isoMax: string;
  apertureMin: string;
  apertureMax: string;
  dateFrom: string;
  dateTo: string;
  hasGps: boolean;
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

export interface ThumbCacheStats {
  l0ExifHits: number;
  l2RamHits: number;
  l3DiskHits: number;
  sharpGenerated: number;
  videoFramesGenerated: number;
  l2RamBytes: number;
  l2RamEntries: number;
}

export interface ScanEventPayload {
  type:
    | 'connected'
    | 'scan:started'
    | 'scan:batch'
    | 'scan:enriched'
    | 'scan:complete'
    | 'scan:error'
    | 'fs:changed'
    | 'library:changed'
    | 'thumbs:progress';
  folderId?: number;
  folderPath?: string;
  discovered?: number;
  enriched?: number;
  elapsedMs?: number;
  firstBatchMs?: number;
  removed?: number;
  done?: number;
  total?: number;
  message?: string;
}

export type ViewMode = 'grid' | 'map-2d' | 'globe-3d';

export const EMPTY_FILTERS: MediaFilterState = {
  q: '',
  camera: '',
  lens: '',
  format: '',
  isoMin: '',
  isoMax: '',
  apertureMin: '',
  apertureMax: '',
  dateFrom: '',
  dateTo: '',
  hasGps: false,
};
