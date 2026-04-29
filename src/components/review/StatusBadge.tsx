'use client';

const STYLES: Record<string, { bg: string; text: string; label: string }> = {
  'in-review': { bg: 'rgba(6,182,212,0.15)', text: '#06b6d4', label: 'In Review' },
  'needs-changes': { bg: 'rgba(234,179,8,0.15)', text: '#eab308', label: 'Needs Changes' },
  'approved': { bg: 'rgba(34,197,94,0.15)', text: '#22c55e', label: 'Approved' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STYLES[status] || STYLES['in-review'];
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: s.bg, color: s.text }}>
      {s.label}
    </span>
  );
}
