import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Heart, Play } from 'lucide-react';
import type { MediaRecord } from '../types';

interface VirtualGridProps {
  total: number;
  queryString: string;
  tileSize: number;
  revision: number;
  selection: Set<number>;
  onTileClick: (e: React.MouseEvent, item: MediaRecord, index: number) => void;
  onToggleSelect: (item: MediaRecord, index: number) => void;
  itemCacheRef: React.MutableRefObject<Map<number, MediaRecord>>;
}

const GAP = 2;
const PAD = 2;
const PAGE_SIZE = 240;
const OVERSCAN_ROWS = 2;

export const VirtualGrid: React.FC<VirtualGridProps> = ({
  total,
  queryString,
  tileSize,
  revision,
  selection,
  onTileClick,
  onToggleSelect,
  itemCacheRef,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [viewportHeight, setViewportHeight] = useState(720);
  const [scrollTop, setScrollTop] = useState(0);
  const [cacheVersion, setCacheVersion] = useState(0);

  // Each query/revision is a "generation". Every page keeps showing its old tiles until its own new
  // data lands (no flash to blank skeletons). Once all on-screen pages are fresh, leftovers from the
  // previous generation (off-screen pages) are dropped so nothing stale is reused later.
  const genRef = useRef(0);
  const loadedPagesRef = useRef<Set<number>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const visiblePagesRef = useRef<[number, number]>([0, 0]);

  useEffect(() => {
    genRef.current++;
    loadedPagesRef.current.clear();
    setCacheVersion((v) => v + 1);
  }, [queryString, revision]);

  // A different query is a different list: start at the top
  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0 });
  }, [queryString]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportWidth(entry.contentRect.width);
        setViewportHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    setViewportWidth(el.clientWidth);
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const usable = Math.max(200, viewportWidth - PAD * 2);
  const columns = useMemo(() => Math.max(2, Math.floor((usable + GAP) / (tileSize + GAP))), [usable, tileSize]);
  const actualTileWidth = (usable - GAP * (columns - 1)) / columns;

  const rowHeight = actualTileWidth + GAP;
  const totalRows = Math.ceil(total / columns);
  const totalHeight = Math.max(0, totalRows * rowHeight + PAD * 2);

  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const endRow = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS);

  const visibleStartIndex = startRow * columns;
  const visibleEndIndex = Math.min(total - 1, (endRow + 1) * columns - 1);

  const fetchPage = useCallback(
    async (pageIdx: number) => {
      const gen = genRef.current;
      const key = `${gen}:${pageIdx}`;
      if (inFlightRef.current.has(key)) return;
      inFlightRef.current.add(key);
      const offset = pageIdx * PAGE_SIZE;
      try {
        const params = new URLSearchParams(queryString);
        params.set('offset', String(offset));
        params.set('limit', String(PAGE_SIZE));
        const res = await fetch(`/api/media?${params.toString()}`);
        if (!res.ok) return;
        const data = (await res.json()) as { items: MediaRecord[] };
        if (gen !== genRef.current) return; // superseded while in flight
        const cache = itemCacheRef.current;
        for (let i = 0; i < PAGE_SIZE; i++) {
          const item = data.items[i];
          if (item) cache.set(offset + i, item);
          else cache.delete(offset + i); // list got shorter
        }
        const loaded = loadedPagesRef.current;
        loaded.add(pageIdx);
        const [first, last] = visiblePagesRef.current;
        let allVisibleFresh = true;
        for (let p = first; p <= last; p++) if (!loaded.has(p)) allVisibleFresh = false;
        if (allVisibleFresh) {
          for (const k of cache.keys()) if (!loaded.has(Math.floor(k / PAGE_SIZE))) cache.delete(k);
        }
        setCacheVersion((v) => v + 1);
      } finally {
        inFlightRef.current.delete(key);
      }
    },
    [queryString, itemCacheRef],
  );

  useEffect(() => {
    if (total === 0) return;
    const firstPage = Math.floor(visibleStartIndex / PAGE_SIZE);
    const lastPage = Math.floor(Math.max(visibleStartIndex, visibleEndIndex) / PAGE_SIZE);
    visiblePagesRef.current = [firstPage, lastPage];
    for (let p = firstPage; p <= lastPage; p++) {
      if (!loadedPagesRef.current.has(p)) void fetchPage(p);
    }
  }, [total, visibleStartIndex, visibleEndIndex, fetchPage, cacheVersion]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const selecting = selection.size > 0;
  const rows: React.ReactNode[] = [];

  for (let rowIndex = startRow; total > 0 && rowIndex <= endRow; rowIndex++) {
    const cells: React.ReactNode[] = [];
    for (let c = 0; c < columns; c++) {
      const itemIndex = rowIndex * columns + c;
      if (itemIndex >= total) break;
      const item = itemCacheRef.current.get(itemIndex);
      const selected = item ? selection.has(item.id) : false;

      cells.push(
        <div
          key={item ? item.id : `slot-${itemIndex}`}
          className={`tile ${selected ? 'selected' : ''} ${selecting ? 'selecting' : ''}`}
          style={{ height: actualTileWidth }}
          onClick={(e) => item && onTileClick(e, item, itemIndex)}
          title={item?.filename}
        >
          {!item ? (
            <div className="tile-skeleton" />
          ) : (
            <>
              <img
                src={`/api/thumb/${item.id}/sm`}
                alt={item.filename}
                decoding="async"
                draggable={false}
                onError={(e) => {
                  e.currentTarget.style.visibility = 'hidden';
                }}
              />
              <button
                type="button"
                className="tile-check"
                aria-label={selected ? 'Desmarcar' : 'Selecionar'}
                aria-pressed={selected}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(item, itemIndex);
                }}
              >
                <Check size={13} strokeWidth={3} />
              </button>
              {item.media_type === 2 && (
                <span className="tile-tag">
                  <Play size={11} fill="currentColor" />
                </span>
              )}
              {item.media_type === 1 && <span className="tile-tag">{item.format.toUpperCase()}</span>}
              {item.live_video_id !== null && item.media_type !== 1 && <span className="tile-tag">LIVE</span>}
              {item.favorite === 1 && <Heart className="tile-fav" size={14} fill="currentColor" aria-label="Favorita" />}
            </>
          )}
        </div>,
      );
    }

    rows.push(
      <div
        key={rowIndex}
        className="grid-row"
        style={{
          transform: `translate3d(0, ${rowIndex * rowHeight + PAD}px, 0)`,
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: `${GAP}px`,
          padding: `0 ${PAD}px`,
        }}
      >
        {cells}
      </div>,
    );
  }

  return (
    <div ref={containerRef} className="viewport" onScroll={handleScroll}>
      <div className="grid-canvas" style={{ height: totalHeight }} data-cache-v={cacheVersion}>
        {rows}
      </div>
    </div>
  );
};
