'use client';

import type { ReviewVersion } from './ReviewPage';

interface VersionSelectorProps {
  versions: ReviewVersion[];
  activeVersionId: string;
  onSelect: (id: string) => void;
}

export function VersionSelector({ versions, activeVersionId, onSelect }: VersionSelectorProps) {
  return (
    <select
      value={activeVersionId}
      onChange={e => onSelect(e.target.value)}
      className="px-2 py-1 rounded-lg text-xs font-medium border-none outline-none cursor-pointer"
      style={{ background: 'rgba(124,58,237,0.1)', color: '#a78bfa' }}
    >
      {versions.map(v => (
        <option key={v.id} value={v.id}>
          v{v.version_number} — {new Date(v.created_at).toLocaleDateString()}
        </option>
      ))}
    </select>
  );
}
