import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  Heart,
  Info,
  Pause,
  Play,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { desktop } from '../desktop';
import type { MediaRecord } from '../types';

interface LightboxProps {
  item: MediaRecord;
  adjacentIds: number[];
  position: string | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onToggleFavorite: () => void;
  onTrash?: () => void;
}

const SLIDE_MS = 3500;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatShutter(us: number | null): string | null {
  if (!us || us <= 0) return null;
  const sec = us / 1_000_000;
  return sec >= 1 ? `${sec.toFixed(1)} s` : `1/${Math.round(1 / sec)} s`;
}

export const Lightbox: React.FC<LightboxProps> = ({
  item,
  adjacentIds,
  position,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onToggleFavorite,
  onTrash,
}) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showInfo, setShowInfo] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [livePlaying, setLivePlaying] = useState(false);
  const drag = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 });
  const hasLive = item.live_video_id !== null;

  const zoomBy = useCallback((delta: number) => {
    setZoom((z) => {
      const next = Math.max(1, Math.min(6, Number((z + delta).toFixed(2))));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setLivePlaying(false);
  }, [item.id]);

  // Slideshow: advance on a timer, stop at the end
  useEffect(() => {
    if (!playing) return;
    if (!hasNext) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(onNext, SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [playing, hasNext, onNext, item.id]);

  useEffect(() => {
    if (adjacentIds.length === 0) return;
    void fetch('/api/prefetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: adjacentIds, size: 'lg' }),
    }).catch(() => {});
    for (const id of adjacentIds) {
      const img = new Image();
      img.decoding = 'async';
      img.src = `/api/thumb/${id}/lg`;
    }
  }, [adjacentIds]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLVideoElement) return;
      const k = e.key;
      if (k === 'Escape') onClose();
      else if (k === 'ArrowLeft' && hasPrev) onPrev();
      else if (k === 'ArrowRight' && hasNext) onNext();
      else if (k === '+' || k === '=') zoomBy(0.5);
      else if (k === '-') zoomBy(-0.5);
      else if (k === '0') zoomBy(-10);
      else if (k.toLowerCase() === 'i') setShowInfo((s) => !s);
      else if (k.toLowerCase() === 'f') onToggleFavorite();
      else if (k.toLowerCase() === 'l' && hasLive) setLivePlaying((p) => !p);
      else if (k === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (k === 'Delete' && onTrash) onTrash();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, onPrev, onNext, hasPrev, hasNext, zoomBy, onToggleFavorite, onTrash, hasLive]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    drag.current = { active: true, startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drag.current.active) return;
    setPan({
      x: drag.current.origX + (e.clientX - drag.current.startX),
      y: drag.current.origY + (e.clientY - drag.current.startY),
    });
  };

  const date = new Date(item.taken_at_ms);
  const camera = [item.camera_make, item.camera_model].filter(Boolean).join(' ');
  const exposure = [
    item.aperture_f ? `f/${item.aperture_f}` : null,
    formatShutter(item.shutter_us),
    item.iso ? `ISO ${item.iso}` : null,
    item.focal_length_mm ? `${item.focal_length_mm} mm` : null,
  ].filter(Boolean);
  const isFav = item.favorite === 1;

  const details: Array<[string, React.ReactNode]> = [
    ['Data', date.toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' })],
    ['Arquivo', `${item.format.toUpperCase()}, ${formatBytes(item.file_size)}`],
    ['Dimensões', item.width && item.height ? `${item.width} × ${item.height}` : null],
    ['Câmera', camera || null],
    ['Lente', item.lens_model],
    ['Exposição', exposure.length ? exposure.join('   ') : null],
    [
      'Local',
      item.has_gps === 1 && item.lat !== null && item.lon !== null ? (
        <a href={`https://www.openstreetmap.org/?mlat=${item.lat}&mlon=${item.lon}#map=14/${item.lat}/${item.lon}`} target="_blank" rel="noreferrer">
          {item.lat.toFixed(4)}, {item.lon.toFixed(4)}
        </a>
      ) : null,
    ],
  ];

  return (
    <div
      className={`viewer ${showInfo ? '' : 'no-info'}`}
      role="dialog"
      aria-modal="true"
      aria-label={item.filename}
      onMouseMove={handleMouseMove}
      onMouseUp={() => (drag.current.active = false)}
    >
      <div className="viewer-bar drag-region">
        <button className="icon-btn lg" onClick={onClose} title="Fechar (Esc)">
          <X size={18} />
        </button>
        <div className="viewer-title">
          <span className="truncate">{item.filename}</span>
          {position && <span className="viewer-pos">{position}</span>}
        </div>
        <div className="viewer-actions">
          {hasLive && (
            <button
              className={`live-btn ${livePlaying ? 'on' : ''}`}
              onClick={() => setLivePlaying((p) => !p)}
              title="Reproduzir Live Photo (L)"
              aria-pressed={livePlaying}
            >
              LIVE
            </button>
          )}
          <button
            className={`icon-btn lg ${isFav ? 'fav-on' : ''}`}
            onClick={onToggleFavorite}
            title={isFav ? 'Remover dos favoritos (F)' : 'Favoritar (F)'}
            aria-pressed={isFav}
          >
            <Heart size={18} fill={isFav ? 'currentColor' : 'none'} />
          </button>
          {item.media_type !== 2 && (
            <>
              <button className="icon-btn lg" onClick={() => zoomBy(-0.5)} title="Diminuir zoom (−)" disabled={zoom <= 1}>
                <ZoomOut size={18} />
              </button>
              <button className="zoom-readout" onClick={() => zoomBy(-10)} title="Ajustar à tela (0)">
                {Math.round(zoom * 100)}%
              </button>
              <button className="icon-btn lg" onClick={() => zoomBy(0.5)} title="Aumentar zoom (+)">
                <ZoomIn size={18} />
              </button>
            </>
          )}
          <button
            className={`icon-btn lg ${playing ? 'on' : ''}`}
            onClick={() => setPlaying((p) => !p)}
            title={playing ? 'Pausar apresentação (Espaço)' : 'Apresentação (Espaço)'}
            disabled={!hasNext && !playing}
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button className={`icon-btn lg ${showInfo ? 'on' : ''}`} onClick={() => setShowInfo((s) => !s)} title="Detalhes (I)">
            <Info size={18} />
          </button>
          {onTrash && (
            <button className="icon-btn lg danger" onClick={onTrash} title="Mover para a Lixeira (Delete)">
              <Trash2 size={18} />
            </button>
          )}
        </div>
      </div>

      <div
        className="viewer-stage"
        onWheel={(e) => zoomBy(e.deltaY < 0 ? 0.35 : -0.35)}
        onMouseDown={handleMouseDown}
        onDoubleClick={() => (zoom > 1 ? zoomBy(-10) : zoomBy(1.5))}
        style={{ cursor: zoom > 1 ? 'grab' : 'default' }}
      >
        {hasPrev && (
          <button className="viewer-nav prev" onClick={onPrev} title="Anterior (←)">
            <ChevronLeft size={22} />
          </button>
        )}

        {item.media_type === 2 ? (
          <video key={item.id} src={`/api/original/${item.id}`} controls autoPlay />
        ) : livePlaying && hasLive ? (
          <video
            key={`live-${item.id}`}
            className="live-video"
            src={`/api/original/${item.live_video_id}`}
            autoPlay
            onEnded={() => setLivePlaying(false)}
            onError={() => setLivePlaying(false)}
            onClick={() => setLivePlaying(false)}
          />
        ) : (
          <img
            key={item.id}
            src={`/api/thumb/${item.id}/lg`}
            alt={item.filename}
            decoding="async"
            draggable={false}
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              transition: drag.current.active ? 'none' : 'transform 0.14s ease-out',
            }}
          />
        )}

        {hasNext && (
          <button className="viewer-nav next" onClick={onNext} title="Próxima (→)">
            <ChevronRight size={22} />
          </button>
        )}
      </div>

      {showInfo && (
        <aside className="viewer-info">
          <dl className="info-list">
            {details
              .filter(([, v]) => v !== null && v !== undefined && v !== '')
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
          <p className="info-path" title={item.path}>
            {item.path}
          </p>
          {desktop && (
            <div className="info-actions">
              <button className="btn" onClick={() => void desktop!.reveal(item.id)}>
                <FolderOpen size={15} />
                Mostrar na pasta
              </button>
              <button className="btn" onClick={() => void desktop!.openExternal(item.id)}>
                <ExternalLink size={15} />
                Abrir no app padrão
              </button>
            </div>
          )}
        </aside>
      )}
    </div>
  );
};
