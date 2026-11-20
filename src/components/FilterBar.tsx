import React from 'react';
import { MapPin } from 'lucide-react';
import { EMPTY_FILTERS, type FilterFacets, type MediaFilterState } from '../types';

interface FilterBarProps {
  filters: MediaFilterState;
  facets: FilterFacets | null;
  onChange: (next: MediaFilterState) => void;
  activeCount: number;
}

export const FilterBar: React.FC<FilterBarProps> = ({ filters, facets, onChange, activeCount }) => {
  const update = <K extends keyof MediaFilterState>(key: K, value: MediaFilterState[K]) => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <div className="filters" role="group" aria-label="Filtros">
      <select className="select" value={filters.camera} onChange={(e) => update('camera', e.target.value)} aria-label="Câmera">
        <option value="">Qualquer câmera</option>
        {facets?.cameras.map((c) => (
          <option key={c.value} value={c.value}>
            {c.value} ({c.count})
          </option>
        ))}
      </select>

      <select className="select" value={filters.lens} onChange={(e) => update('lens', e.target.value)} aria-label="Lente">
        <option value="">Qualquer lente</option>
        {facets?.lenses.map((l) => (
          <option key={l.value} value={l.value}>
            {l.value} ({l.count})
          </option>
        ))}
      </select>

      <select className="select" value={filters.format} onChange={(e) => update('format', e.target.value)} aria-label="Formato">
        <option value="">Qualquer formato</option>
        {facets?.formats.map((f) => (
          <option key={f.value} value={f.value}>
            {f.value.toUpperCase()} ({f.count})
          </option>
        ))}
      </select>

      <fieldset className="range">
        <legend>ISO</legend>
        <input
          type="number"
          inputMode="numeric"
          aria-label="ISO mínimo"
          placeholder={facets?.isoRange.min ? String(facets.isoRange.min) : 'mín'}
          value={filters.isoMin}
          onChange={(e) => update('isoMin', e.target.value)}
        />
        <span aria-hidden>–</span>
        <input
          type="number"
          inputMode="numeric"
          aria-label="ISO máximo"
          placeholder={facets?.isoRange.max ? String(facets.isoRange.max) : 'máx'}
          value={filters.isoMax}
          onChange={(e) => update('isoMax', e.target.value)}
        />
      </fieldset>

      <fieldset className="range">
        <legend>f/</legend>
        <input
          type="number"
          step="0.1"
          aria-label="Abertura mínima"
          placeholder={facets?.apertureRange.min ? String(facets.apertureRange.min) : 'mín'}
          value={filters.apertureMin}
          onChange={(e) => update('apertureMin', e.target.value)}
        />
        <span aria-hidden>–</span>
        <input
          type="number"
          step="0.1"
          aria-label="Abertura máxima"
          placeholder={facets?.apertureRange.max ? String(facets.apertureRange.max) : 'máx'}
          value={filters.apertureMax}
          onChange={(e) => update('apertureMax', e.target.value)}
        />
      </fieldset>

      <fieldset className="range">
        <legend>De</legend>
        <input type="date" className="date" aria-label="Data inicial" value={filters.dateFrom} onChange={(e) => update('dateFrom', e.target.value)} />
        <span aria-hidden>até</span>
        <input type="date" className="date" aria-label="Data final" value={filters.dateTo} onChange={(e) => update('dateTo', e.target.value)} />
      </fieldset>

      <button
        type="button"
        className={`btn ${filters.hasGps ? 'btn-on' : ''}`}
        onClick={() => update('hasGps', !filters.hasGps)}
        aria-pressed={filters.hasGps}
      >
        <MapPin size={14} />
        Com local ({facets?.gpsCount ?? 0})
      </button>

      {activeCount > 0 && (
        <button type="button" className="link-btn" onClick={() => onChange({ ...EMPTY_FILTERS, q: filters.q })}>
          Limpar filtros
        </button>
      )}
    </div>
  );
};
