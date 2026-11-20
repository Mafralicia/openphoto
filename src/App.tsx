import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Aperture,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronRight,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Heart,
  Images,
  LayoutGrid,
  Map as MapIcon,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import { FilterBar } from './components/FilterBar';
import { Lightbox } from './components/Lightbox';
import { MapGlobeView } from './components/MapGlobeView';
import { VirtualGrid } from './components/VirtualGrid';
import { desktop, usePersistentState } from './desktop';
import {
  EMPTY_FILTERS,
  type FilterFacets,
  type FolderRecord,
  type GeoBounds,
  type LibraryScope,
  type LibraryStats,
  type MediaFilterState,
  type MediaRecord,
  type ScanEventPayload,
  type SortMode,
  type ViewMode,
} from './types';

const nf = new Intl.NumberFormat('pt-BR');

const SCOPES: Array<{ id: LibraryScope; label: string; icon: React.ReactNode; stat: keyof LibraryStats }> = [
  { id: 'all', label: 'Todas as fotos', icon: <Images size={16} />, stat: 'totalMedia' },
  { id: 'favorites', label: 'Favoritas', icon: <Heart size={16} />, stat: 'favorites' },
  { id: 'videos', label: 'Vídeos', icon: <Film size={16} />, stat: 'videos' },
  { id: 'raw', label: 'RAW', icon: <Aperture size={16} />, stat: 'raws' },
];

function folderLabel(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

interface DirNode {
  name: string;
  dir: string; // relative to the library folder, as the server stores it
  count: number; // items in this subfolder and everything below it
  children: DirNode[];
}

/** Server gives flat "A\B" rows with direct counts; build the nested tree with recursive totals. */
function buildDirTree(rows: Array<{ dir: string; count: number }>): DirNode[] {
  const top: DirNode[] = [];
  const byDir = new Map<string, DirNode>();
  for (const row of rows) {
    if (!row.dir) continue; // files directly in the library folder
    const parts = row.dir.split(/[\\/]/).filter(Boolean);
    const sep = row.dir.includes('\\') ? '\\' : '/';
    let siblings = top;
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i + 1).join(sep);
      let node = byDir.get(dir);
      if (!node) {
        node = { name: parts[i], dir, count: 0, children: [] };
        byDir.set(dir, node);
        siblings.push(node);
      }
      node.count += row.count;
      siblings = node.children;
    }
  }
  const sortRec = (nodes: DirNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(top);
  return top;
}

const DirTreeNode: React.FC<{
  node: DirNode;
  depth: number;
  folderId: number;
  expanded: string[];
  selected: string | null;
  onToggle: (key: string) => void;
  onSelect: (dir: string) => void;
}> = ({ node, depth, folderId, expanded, selected, onToggle, onSelect }) => {
  const key = `${folderId}:${node.dir}`;
  const open = expanded.includes(key);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <div className={`nav-item folder-row tree-row ${selected === node.dir ? 'active' : ''}`} style={{ paddingLeft: depth * 14 }}>
        {hasChildren ? (
          <button
            type="button"
            className="tree-toggle"
            aria-expanded={open}
            aria-label={open ? `Recolher ${node.name}` : `Abrir ${node.name}`}
            onClick={() => onToggle(key)}
          >
            <ChevronRight size={14} />
          </button>
        ) : (
          <span className="tree-toggle-spacer" />
        )}
        <button type="button" className="folder-main" onClick={() => onSelect(node.dir)} title={node.dir}>
          <span className="nav-label">
            <Folder size={15} />
            <span className="truncate">{node.name}</span>
          </span>
          <span className="nav-count">{nf.format(node.count)}</span>
        </button>
      </div>
      {open &&
        node.children.map((child) => (
          <DirTreeNode
            key={child.dir}
            node={child}
            depth={depth + 1}
            folderId={folderId}
            expanded={expanded}
            selected={selected}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </>
  );
};

function buildQueryParams(
  folderId: number | null,
  dir: string | null,
  scope: LibraryScope,
  sort: SortMode,
  filters: MediaFilterState,
  geoBounds: GeoBounds | null,
): string {
  const p = new URLSearchParams();
  if (folderId !== null) p.set('folderId', String(folderId));
  if (folderId !== null && dir) p.set('dir', dir);
  if (scope === 'favorites') p.set('favorite', '1');
  if (scope === 'videos') p.set('mediaType', '2');
  if (scope === 'raw') p.set('mediaType', '1');
  if (sort !== 'date_desc') p.set('sort', sort);
  if (filters.q.trim()) p.set('q', filters.q.trim());
  if (filters.camera) p.set('camera', filters.camera);
  if (filters.lens) p.set('lens', filters.lens);
  if (filters.format) p.set('format', filters.format);
  if (filters.isoMin) p.set('isoMin', filters.isoMin);
  if (filters.isoMax) p.set('isoMax', filters.isoMax);
  if (filters.apertureMin) p.set('apertureMin', filters.apertureMin);
  if (filters.apertureMax) p.set('apertureMax', filters.apertureMax);
  if (filters.dateFrom) {
    const ts = Date.parse(`${filters.dateFrom}T00:00:00`);
    if (!Number.isNaN(ts)) p.set('dateFrom', String(ts));
  }
  if (filters.dateTo) {
    const ts = Date.parse(`${filters.dateTo}T23:59:59.999`);
    if (!Number.isNaN(ts)) p.set('dateTo', String(ts));
  }
  if (filters.hasGps) p.set('hasGps', '1');
  if (geoBounds) {
    p.set('minLat', geoBounds.minLat.toFixed(5));
    p.set('maxLat', geoBounds.maxLat.toFixed(5));
    p.set('minLon', geoBounds.minLon.toFixed(5));
    p.set('maxLon', geoBounds.maxLon.toFixed(5));
  }
  return p.toString();
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export const App: React.FC = () => {
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [demoFolder, setDemoFolder] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [expanded, setExpanded] = usePersistentState<string[]>('expandedDirs', []);
  const [trees, setTrees] = useState<Record<number, DirNode[]>>({});
  const [thumbProgress, setThumbProgress] = useState<{ done: number; total: number } | null>(null);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => desktop?.onUpdateReady(setUpdateVersion), []);
  const [scope, setScope] = useState<LibraryScope>('all');
  const [totalMedia, setTotalMedia] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [statsTick, setStatsTick] = useState(0);

  const [tileSize, setTileSize] = usePersistentState('tileSize', 180);
  const [sort, setSort] = usePersistentState<SortMode>('sort', 'date_desc');
  const [showFilters, setShowFilters] = usePersistentState('showFilters', false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [filters, setFilters] = useState<MediaFilterState>(EMPTY_FILTERS);
  const [facets, setFacets] = useState<FilterFacets | null>(null);
  const [geoBounds, setGeoBounds] = useState<GeoBounds | null>(null);
  const [syncMapBounds, setSyncMapBounds] = useState(true);

  const [scan, setScan] = useState<{ active: boolean; text: string; error?: boolean }>({ active: false, text: '' });
  const [dragOver, setDragOver] = useState(false);

  const [selection, setSelection] = useState<Set<number>>(new Set());
  const lastClickedIndexRef = useRef<number | null>(null);
  const [activeSelection, setActiveSelection] = useState<{ item: MediaRecord; index: number } | null>(null);
  const itemCacheRef = useRef<Map<number, MediaRecord>>(new Map());
  const searchRef = useRef<HTMLInputElement | null>(null);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.camera) n++;
    if (filters.lens) n++;
    if (filters.format) n++;
    if (filters.isoMin || filters.isoMax) n++;
    if (filters.apertureMin || filters.apertureMax) n++;
    if (filters.dateFrom || filters.dateTo) n++;
    if (filters.hasGps) n++;
    return n;
  }, [filters]);

  const baseQueryString = useMemo(
    () => buildQueryParams(selectedFolderId, selectedDir, scope, sort, filters, null),
    [selectedFolderId, selectedDir, scope, sort, filters],
  );
  const effectiveBounds = viewMode === 'grid' || !syncMapBounds ? null : geoBounds;
  const fullQueryString = useMemo(
    () => buildQueryParams(selectedFolderId, selectedDir, scope, sort, filters, effectiveBounds),
    [selectedFolderId, selectedDir, scope, sort, filters, effectiveBounds],
  );

  // Server events arrive in bursts while indexing 20k+ files; refresh at most every 1.5s
  // (first one immediately, so the first batch still shows up right away)
  const lastBumpRef = useRef(0);
  const bumpTimerRef = useRef<number | null>(null);
  const bumpRevision = useCallback(() => {
    const wait = 1500 - (performance.now() - lastBumpRef.current);
    const fire = () => {
      bumpTimerRef.current = null;
      lastBumpRef.current = performance.now();
      setRevision((r) => r + 1);
    };
    if (wait <= 0) fire();
    else if (bumpTimerRef.current === null) bumpTimerRef.current = window.setTimeout(fire, wait);
  }, []);

  const selectFolder = (folderId: number | null, dir: string | null = null) => {
    setScope('all');
    setSelectedFolderId(folderId);
    setSelectedDir(dir);
  };

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  // Load subfolder trees for expanded library folders
  const expandedFolderIds = useMemo(
    () => folders.filter((f) => expanded.includes(`${f.id}:`)).map((f) => f.id),
    [folders, expanded],
  );
  useEffect(() => {
    for (const id of expandedFolderIds) {
      void fetch(`/api/folders/${id}/tree`).then(async (res) => {
        if (!res.ok) return;
        const { dirs } = (await res.json()) as { dirs: Array<{ dir: string; count: number }> };
        setTrees((t) => ({ ...t, [id]: buildDirTree(dirs) }));
      });
    }
  }, [expandedFolderIds, revision]);

  // New query = new result set: selection no longer maps to what's on screen
  useEffect(() => {
    setSelection(new Set());
    lastClickedIndexRef.current = null;
  }, [fullQueryString]);

  useEffect(() => {
    void (async () => {
      const [foldersRes, facetsRes] = await Promise.all([
        fetch('/api/folders'),
        fetch(`/api/filters${selectedFolderId !== null ? `?folderId=${selectedFolderId}` : ''}`),
      ]);
      if (foldersRes.ok) {
        const data = (await foldersRes.json()) as { folders: FolderRecord[]; stats: LibraryStats; demoFolder: string | null };
        setFolders(data.folders);
        setStats(data.stats);
        setDemoFolder(data.demoFolder);
      }
      if (facetsRes.ok) setFacets((await facetsRes.json()) as FilterFacets);
    })();
  }, [selectedFolderId, revision, statsTick]);

  useEffect(() => {
    const params = new URLSearchParams(fullQueryString);
    params.set('offset', '0');
    params.set('limit', '1');
    void fetch(`/api/media?${params.toString()}`).then(async (res) => {
      if (!res.ok) return;
      const data = (await res.json()) as { total: number };
      setTotalMedia(data.total);
      setLoaded(true);
    });
  }, [fullQueryString, revision]);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      try {
        const p = JSON.parse(ev.data) as ScanEventPayload;
        if (p.type === 'scan:started') {
          setScan({ active: true, text: 'Procurando arquivos…' });
        } else if (p.type === 'scan:batch') {
          setScan({ active: true, text: `${nf.format(p.discovered ?? 0)} encontrados` });
          bumpRevision();
        } else if (p.type === 'scan:enriched') {
          setScan({ active: true, text: `Lendo detalhes: ${nf.format(p.enriched ?? 0)} de ${nf.format(p.discovered ?? 0)}` });
          bumpRevision();
        } else if (p.type === 'scan:complete') {
          const removed = p.removed ? `, ${nf.format(p.removed)} removidos do disco` : '';
          setScan({ active: false, text: `${nf.format(p.discovered ?? 0)} itens indexados${removed}` });
          bumpRevision();
        } else if (p.type === 'fs:changed') {
          bumpRevision();
        } else if (p.type === 'library:changed') {
          setStatsTick((t) => t + 1); // a drive connected/disconnected or moved letters
        } else if (p.type === 'thumbs:progress') {
          const done = p.done ?? 0;
          const total = p.total ?? 0;
          setThumbProgress(done < total ? { done, total } : null);
        } else if (p.type === 'scan:error') {
          setScan({ active: false, text: p.message ?? 'Não foi possível ler a pasta.', error: true });
        }
      } catch {
        // keepalive frames
      }
    };
    return () => es.close();
  }, [bumpRevision]);

  const startScan = useCallback(async (targetPath: string) => {
    const clean = targetPath.trim();
    if (!clean) return;
    setScan({ active: true, text: 'Abrindo pasta…' });
    const res = await postJson('/api/scan', { path: clean });
    if (res.ok) {
      // A subfolder of something already in the library just opens there (dir set, nothing new indexed)
      const data = (await res.json()) as { folderId: number; dir: string | null };
      selectFolder(data.folderId, data.dir || null);
      if (data.dir) {
        setExpanded((prev) => (prev.includes(`${data.folderId}:`) ? prev : [...prev, `${data.folderId}:`]));
        setScan({ active: false, text: 'Essa pasta já faz parte da biblioteca' });
      }
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      setScan({ active: false, text: err.error ?? 'Essa pasta não pôde ser aberta.', error: true });
    }
  }, []);

  const handleAddFolder = async () => {
    let chosen: string | null = null;
    if (desktop) {
      chosen = await desktop.pickFolder();
    } else {
      const res = await fetch('/api/pick-folder', { method: 'POST' });
      if (res.ok) chosen = ((await res.json()) as { path: string | null }).path;
    }
    if (chosen) await startScan(chosen);
  };

  const handleRemoveFolder = async (folder: FolderRecord) => {
    const ok = window.confirm(
      `Remover "${folderLabel(folder.path)}" da biblioteca?\n\nOs arquivos continuam no disco; só deixam de aparecer aqui.`,
    );
    if (!ok) return;
    await fetch(`/api/folders/${folder.id}/remove`, { method: 'POST' });
    if (selectedFolderId === folder.id) selectFolder(null);
    setRevision((r) => r + 1);
  };

  const fetchItemAt = async (index: number): Promise<MediaRecord | null> => {
    const cached = itemCacheRef.current.get(index);
    if (cached) return cached;
    const params = new URLSearchParams(fullQueryString);
    params.set('offset', String(index));
    params.set('limit', '1');
    const res = await fetch(`/api/media?${params.toString()}`);
    if (!res.ok) return null;
    const item = ((await res.json()) as { items: MediaRecord[] }).items[0] ?? null;
    if (item) itemCacheRef.current.set(index, item);
    return item;
  };

  const openLightboxAt = async (index: number) => {
    if (index < 0 || index >= totalMedia) return;
    const item = await fetchItemAt(index);
    if (item) setActiveSelection({ item, index });
  };

  const openLightboxById = useCallback(async (mediaId: number) => {
    const res = await fetch(`/api/media/${mediaId}`);
    if (!res.ok) return;
    setActiveSelection({ item: (await res.json()) as MediaRecord, index: -1 });
  }, []);

  const setFavorite = async (ids: number[], value: boolean) => {
    if (ids.length === 0) return;
    const res = await postJson('/api/favorite', { ids, value });
    if (!res.ok) return;
    const flag = value ? 1 : 0;
    const idSet = new Set(ids);
    for (const item of itemCacheRef.current.values()) if (idSet.has(item.id)) item.favorite = flag;
    setActiveSelection((s) => (s && idSet.has(s.item.id) ? { ...s, item: { ...s.item, favorite: flag } } : s));
    if (scope === 'favorites' && !value) setRevision((r) => r + 1);
    else setStatsTick((t) => t + 1);
  };

  const trashItems = async (ids: number[]): Promise<boolean> => {
    if (!desktop || ids.length === 0) return false;
    const label = ids.length === 1 ? 'este arquivo' : `${ids.length} arquivos`;
    if (!window.confirm(`Mover ${label} para a Lixeira?\n\nDá para restaurar pela Lixeira do Windows.`)) return false;
    await desktop.trash(ids);
    itemCacheRef.current.clear();
    setSelection(new Set());
    setRevision((r) => r + 1);
    return true;
  };

  const handleLightboxTrash = async () => {
    if (!activeSelection) return;
    const { item, index } = activeSelection;
    if (!(await trashItems([item.id]))) return;
    if (index < 0) {
      setActiveSelection(null);
      return;
    }
    // Show whatever slid into this position, like a culling workflow
    const params = new URLSearchParams(fullQueryString);
    params.set('offset', String(index));
    params.set('limit', '1');
    const res = await fetch(`/api/media?${params.toString()}`);
    const next = res.ok ? ((await res.json()) as { items: MediaRecord[] }).items[0] : undefined;
    setActiveSelection(next ? { item: next, index } : null);
  };

  const handleTileClick = (e: React.MouseEvent, item: MediaRecord, index: number) => {
    const last = lastClickedIndexRef.current;
    if (e.shiftKey && last !== null) {
      const next = new Set(selection);
      for (let i = Math.min(last, index); i <= Math.max(last, index); i++) {
        const it = itemCacheRef.current.get(i);
        if (it) next.add(it.id);
      }
      setSelection(next);
    } else if (e.ctrlKey || e.metaKey || selection.size > 0) {
      toggleSelect(item, index);
    } else {
      setActiveSelection({ item, index });
    }
  };

  const toggleSelect = (item: MediaRecord, index: number) => {
    lastClickedIndexRef.current = index;
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (e.key === 'Escape' && !activeSelection && selection.size > 0) setSelection(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeSelection, selection.size]);

  const adjacentIds = useMemo(() => {
    if (!activeSelection || activeSelection.index < 0) return [];
    const ids: number[] = [];
    for (let off = -3; off <= 3; off++) {
      const n = off !== 0 ? itemCacheRef.current.get(activeSelection.index + off) : undefined;
      if (n) ids.push(n.id);
    }
    return ids;
  }, [activeSelection]);

  const selectedIds = [...selection];
  const selectedAllFavorite =
    selectedIds.length > 0 &&
    selectedIds.every((id) => [...itemCacheRef.current.values()].find((i) => i.id === id)?.favorite === 1);

  const currentFolder = folders.find((f) => f.id === selectedFolderId) ?? null;
  const dirParts = selectedDir ? selectedDir.split(/[\\/]/).filter(Boolean) : [];
  const dirSep = selectedDir?.includes('\\') ? '\\' : '/';
  const pageTitle = dirParts.length
    ? dirParts[dirParts.length - 1]
    : currentFolder
      ? folderLabel(currentFolder.path)
      : SCOPES.find((s) => s.id === scope)!.label;
  const libraryEmpty = (stats?.totalMedia ?? 0) === 0 && folders.length === 0;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && desktop) void startScan(desktop.pathForFile(file));
  };

  return (
    <div
      className={`app-shell ${desktop ? 'is-desktop' : ''}`}
      onDragOver={(e) => {
        if (desktop && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <aside className="sidebar">
        <div className="sidebar-brand drag-region">OpenPhoto</div>

        <nav className="nav-group" aria-label="Biblioteca">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`nav-item ${selectedFolderId === null && scope === s.id ? 'active' : ''}`}
              onClick={() => {
                selectFolder(null);
                setScope(s.id);
              }}
            >
              <span className="nav-label">
                {s.icon}
                {s.label}
              </span>
              <span className="nav-count">{stats ? nf.format(stats[s.stat]) : ''}</span>
            </button>
          ))}
        </nav>

        <div className="nav-heading">
          <span>Pastas</span>
          <button type="button" className="icon-btn" onClick={() => void handleAddFolder()} title="Adicionar pasta">
            <FolderPlus size={15} />
          </button>
        </div>

        <nav className="nav-group nav-folders" aria-label="Pastas">
          {folders.map((folder) => {
            const key = `${folder.id}:`;
            const open = expanded.includes(key);
            const offline = folder.online === false;
            return (
              <React.Fragment key={folder.id}>
                <div
                  className={`nav-item folder-row ${selectedFolderId === folder.id && !selectedDir ? 'active' : ''} ${offline ? 'offline' : ''}`}
                >
                  <button
                    type="button"
                    className="tree-toggle"
                    aria-expanded={open}
                    aria-label={open ? 'Recolher subpastas' : 'Mostrar subpastas'}
                    onClick={() => toggleExpanded(key)}
                  >
                    <ChevronRight size={14} />
                  </button>
                  <button
                    type="button"
                    className="folder-main"
                    onClick={() => selectFolder(folder.id)}
                    title={offline ? `${folder.path}\nDisco desconectado: mostrando o que já foi indexado` : folder.path}
                  >
                    <span className="nav-label">
                      {offline ? <Unplug size={16} /> : <FolderOpen size={16} />}
                      <span className="truncate">{folderLabel(folder.path)}</span>
                    </span>
                    <span className="nav-count">{nf.format(folder.item_count)}</span>
                  </button>
                  <span className="folder-actions">
                    {!offline && (
                      <button
                        type="button"
                        className="icon-btn"
                        title="Ejetar: libera o disco para 'Remover hardware com segurança'. As fotos continuam visíveis."
                        onClick={() => void fetch(`/api/folders/${folder.id}/eject`, { method: 'POST' })}
                      >
                        <ArrowUpFromLine size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn"
                      title={offline ? 'Reconectar e verificar' : 'Verificar novamente'}
                      onClick={() => void startScan(folder.path)}
                    >
                      <RefreshCw size={13} />
                    </button>
                    <button type="button" className="icon-btn" title="Remover da biblioteca" onClick={() => void handleRemoveFolder(folder)}>
                      <X size={14} />
                    </button>
                  </span>
                </div>
                {open &&
                  (trees[folder.id] ?? []).map((node) => (
                    <DirTreeNode
                      key={node.dir}
                      node={node}
                      depth={1}
                      folderId={folder.id}
                      expanded={expanded}
                      selected={selectedFolderId === folder.id ? selectedDir : null}
                      onToggle={toggleExpanded}
                      onSelect={(dir) => selectFolder(folder.id, dir)}
                    />
                  ))}
              </React.Fragment>
            );
          })}
          {folders.length === 0 && <p className="nav-hint">Nenhuma pasta ainda.</p>}
        </nav>

        {(scan.text || thumbProgress) && (
          <div className="scan-status-group" role="status">
            {scan.text && (
              <div className={`scan-status ${scan.error ? 'error' : ''}`}>
                {scan.active && <span className="spinner" aria-hidden />}
                <span>{scan.text}</span>
              </div>
            )}
            {thumbProgress && (
              <div className="scan-status" title="Depois disso, navegar não precisa mais ler o HD">
                <span className="spinner" aria-hidden />
                <span>
                  Miniaturas: {nf.format(thumbProgress.done)} de {nf.format(thumbProgress.total)}
                </span>
              </div>
            )}
          </div>
        )}

        {updateVersion && (
          <div className="update-ready" role="status">
            <span>Versão {updateVersion} pronta</span>
            <button type="button" className="btn btn-primary" onClick={() => void desktop?.installUpdate()}>
              Reiniciar e atualizar
            </button>
          </div>
        )}
      </aside>

      <section className="workspace">
        <header className="toolbar drag-region">
          <label className="search">
            <Search size={15} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              placeholder="Buscar por nome, câmera, lente"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
            <kbd>Ctrl F</kbd>
          </label>

          <div className="segmented" role="tablist" aria-label="Visualização">
            {(
              [
                ['grid', <LayoutGrid size={15} key="g" />, 'Grade'],
                ['map-2d', <MapIcon size={15} key="m" />, 'Mapa'],
                ['globe-3d', <Globe size={15} key="o" />, 'Globo'],
              ] as const
            ).map(([mode, icon, label]) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={viewMode === mode}
                className={viewMode === mode ? 'active' : ''}
                onClick={() => setViewMode(mode)}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>

          <div className="toolbar-end">
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortMode)} title="Ordenar">
              <option value="date_desc">Mais recentes</option>
              <option value="date_asc">Mais antigas</option>
              <option value="name">Nome</option>
              <option value="size">Maiores arquivos</option>
            </select>
            <button
              type="button"
              className={`btn ${showFilters || activeFilterCount > 0 ? 'btn-on' : ''}`}
              onClick={() => setShowFilters((s) => !s)}
              aria-pressed={showFilters}
            >
              <SlidersHorizontal size={15} />
              Filtros{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
            </button>
            <input
              className="zoom"
              type="range"
              min={100}
              max={320}
              step={10}
              value={tileSize}
              onChange={(e) => setTileSize(Number(e.target.value))}
              aria-label="Tamanho das miniaturas"
            />
          </div>
        </header>

        {showFilters && <FilterBar filters={filters} facets={facets} onChange={setFilters} activeCount={activeFilterCount} />}

        {selection.size > 0 ? (
          <div className="page-head selection-head">
            <button type="button" className="icon-btn" onClick={() => setSelection(new Set())} title="Limpar seleção (Esc)">
              <X size={16} />
            </button>
            <h1>
              {selection.size} {selection.size === 1 ? 'selecionada' : 'selecionadas'}
            </h1>
            <div className="head-actions">
              <button type="button" className="btn" onClick={() => void setFavorite(selectedIds, !selectedAllFavorite)}>
                <Heart size={15} fill={selectedAllFavorite ? 'currentColor' : 'none'} />
                {selectedAllFavorite ? 'Desfavoritar' : 'Favoritar'}
              </button>
              {desktop && selection.size === 1 && (
                <button type="button" className="btn" onClick={() => void desktop!.reveal(selectedIds[0])}>
                  <FolderOpen size={15} />
                  Mostrar na pasta
                </button>
              )}
              {desktop && (
                <button type="button" className="btn btn-danger" onClick={() => void trashItems(selectedIds)}>
                  <Trash2 size={15} />
                  Mover para a Lixeira
                </button>
              )}
            </div>
          </div>
        ) : (
          !libraryEmpty && (
            <div className="page-head">
              {currentFolder && dirParts.length > 0 && (
                <nav className="crumbs" aria-label="Caminho">
                  <button type="button" className="link-btn" onClick={() => selectFolder(currentFolder.id)}>
                    {folderLabel(currentFolder.path)}
                  </button>
                  {dirParts.slice(0, -1).map((part, i) => (
                    <React.Fragment key={i}>
                      <span aria-hidden>/</span>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => selectFolder(currentFolder.id, dirParts.slice(0, i + 1).join(dirSep))}
                      >
                        {part}
                      </button>
                    </React.Fragment>
                  ))}
                </nav>
              )}
              <h1>{pageTitle}</h1>
              <span className="page-count">
                {nf.format(totalMedia)} {totalMedia === 1 ? 'item' : 'itens'}
              </span>
            </div>
          )
        )}

        <div className={`stage ${viewMode !== 'grid' ? 'with-map' : ''}`}>
          {viewMode !== 'grid' && (
            <MapGlobeView
              mode={viewMode}
              baseQueryString={baseQueryString}
              revision={revision}
              syncBounds={syncMapBounds}
              onToggleSyncBounds={() => setSyncMapBounds((s) => !s)}
              onBoundsChange={setGeoBounds}
              onSelectPhotoId={(id) => void openLightboxById(id)}
            />
          )}

          {totalMedia > 0 ? (
            <VirtualGrid
              total={totalMedia}
              queryString={fullQueryString}
              tileSize={tileSize}
              revision={revision}
              selection={selection}
              onTileClick={handleTileClick}
              onToggleSelect={toggleSelect}
              itemCacheRef={itemCacheRef}
            />
          ) : (
            loaded && (
              <main className="empty">
                {libraryEmpty ? (
                  <>
                    <h2>Suas fotos, direto do disco.</h2>
                    <p>
                      Escolha uma pasta do computador. Nada é copiado ou enviado: o OpenPhoto só lê os arquivos e
                      acompanha as mudanças.
                    </p>
                    <div className="empty-actions">
                      <button type="button" className="btn btn-primary" onClick={() => void handleAddFolder()}>
                        <FolderPlus size={16} />
                        Adicionar pasta
                      </button>
                      {demoFolder && (
                        <button type="button" className="btn" onClick={() => void startScan(demoFolder)}>
                          Abrir fotos de exemplo
                        </button>
                      )}
                    </div>
                    {desktop && <p className="empty-hint">Ou arraste uma pasta para esta janela.</p>}
                  </>
                ) : scope === 'favorites' && activeFilterCount === 0 && !filters.q ? (
                  <>
                    <h2>Nenhuma favorita ainda</h2>
                    <p>
                      Toque no coração de uma foto, ou pressione <kbd>F</kbd> ao visualizá-la.
                    </p>
                  </>
                ) : (
                  <>
                    <h2>Nada corresponde a essa busca</h2>
                    <p>
                      {viewMode !== 'grid' && syncMapBounds
                        ? 'Afaste o mapa ou desligue o filtro por área para ver mais.'
                        : 'Tente outro termo ou limpe os filtros.'}
                    </p>
                    <div className="empty-actions">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setFilters(EMPTY_FILTERS);
                        }}
                      >
                        Limpar busca e filtros
                      </button>
                    </div>
                  </>
                )}
              </main>
            )
          )}
        </div>
      </section>

      {dragOver && (
        <div className="drop-overlay">
          <CheckCircle2 size={28} />
          Solte a pasta para adicioná-la
        </div>
      )}

      {activeSelection && (
        <Lightbox
          item={activeSelection.item}
          adjacentIds={adjacentIds}
          position={activeSelection.index >= 0 ? `${nf.format(activeSelection.index + 1)} de ${nf.format(totalMedia)}` : null}
          onClose={() => setActiveSelection(null)}
          hasPrev={activeSelection.index > 0}
          hasNext={activeSelection.index >= 0 && activeSelection.index < totalMedia - 1}
          onPrev={() => void openLightboxAt(activeSelection.index - 1)}
          onNext={() => void openLightboxAt(activeSelection.index + 1)}
          onToggleFavorite={() => void setFavorite([activeSelection.item.id], activeSelection.item.favorite !== 1)}
          onTrash={desktop ? () => void handleLightboxTrash() : undefined}
        />
      )}
    </div>
  );
};
