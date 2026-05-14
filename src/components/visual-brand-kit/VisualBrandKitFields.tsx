'use client';

/**
 * Form-field subcomponents shared between the channel-level visual brand
 * kit page (`/channel/[id]/visual-brand-kit`) and the per-doc override
 * panel on the production-doc page. Kept in one place so the look,
 * validation, and font-preview list stay in lock-step — the override
 * panel should feel like an inline version of the same controls.
 *
 * No state ownership here: each field is a pure controlled input. The
 * caller decides where the value lives (channel kit row, per-doc entry
 * override, etc.).
 */
import { useRef } from 'react';
import { ALLOWED_FONT_FAMILIES, FONT_REGISTRY, type FontFamilyName } from '@/remotion/fonts';

export const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export const COLOR_FIELDS = [
  { key: 'primaryColor',    label: 'Primary accent',     hint: 'Hooks, callouts, the bright bit the eye lands on.' },
  { key: 'secondaryColor',  label: 'Secondary accent',   hint: 'Supporting accent, used on dividers and chip backgrounds.' },
  { key: 'backgroundColor', label: 'Background',         hint: 'Scene background. White by default.' },
  { key: 'textColor',       label: 'Body text',          hint: 'Lower-third + on-screen text.' },
  { key: 'titleColor',      label: 'Title text',         hint: 'Bold titles + section-divider stripe.' },
] as const;

export type ColorFieldKey = (typeof COLOR_FIELDS)[number]['key'];

// ─── FontPicker ─────────────────────────────────────────────────────────────

export function FontPicker({
  label,
  hint,
  value,
  onChange,
  defaultPlaceholder = 'Use default (Inter)',
}: {
  label: string;
  hint?: string;
  value: FontFamilyName | '';
  onChange: (v: FontFamilyName | '') => void;
  defaultPlaceholder?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <FontOption
          name=""
          previewFamily="Inter, system-ui, sans-serif"
          selected={value === ''}
          onSelect={() => onChange('')}
          label={defaultPlaceholder}
        />
        {ALLOWED_FONT_FAMILIES.map((name) => (
          <FontOption
            key={name}
            name={name}
            previewFamily={FONT_REGISTRY[name].fallback}
            selected={value === name}
            onSelect={() => onChange(name)}
          />
        ))}
      </div>
    </Field>
  );
}

function FontOption({
  name,
  previewFamily,
  selected,
  onSelect,
  label,
}: {
  name: string;
  previewFamily: string;
  selected: boolean;
  onSelect: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        textAlign: 'left',
        padding: '10px 12px',
        borderRadius: 8,
        border: selected ? '1px solid rgba(99,102,241,0.6)' : '1px solid rgba(255,255,255,0.08)',
        background: selected ? 'rgba(99,102,241,0.08)' : 'rgba(255,255,255,0.02)',
        color: 'var(--text-primary)',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
        {label ?? name}
      </div>
      <div style={{ fontFamily: previewFamily, fontSize: 18, lineHeight: 1.2 }}>
        The quick brown fox
      </div>
    </button>
  );
}

// ─── ColorField ─────────────────────────────────────────────────────────────

export function ColorField({
  label,
  hint,
  value,
  onChange,
  placeholder = '#RRGGBB or blank for default',
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="color"
          value={value || '#000000'}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 44,
            height: 36,
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6,
            padding: 0,
            background: 'transparent',
            cursor: 'pointer',
          }}
        />
        <input
          className="input-field"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, fontFamily: 'monospace' }}
          maxLength={7}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="btn-secondary"
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            Clear
          </button>
        )}
      </div>
    </Field>
  );
}

// ─── LogoDropzone ───────────────────────────────────────────────────────────
//
// Caller owns the upload protocol — we just hand back the picked file via
// `onPick`. The channel-settings page hits `/api/channels/[id]/visual-brand-
// kit/logo`; the per-doc override panel could either share that endpoint
// (channel-scoped key prefix) or skip the dropzone entirely. The component
// stays uploader-agnostic so neither use case forks.

export function LogoDropzone({
  logoUrl,
  uploading,
  error,
  onPick,
  onRemove,
  hint,
}: {
  logoUrl: string;
  uploading: boolean;
  error: string | null;
  onPick: (file: File) => void;
  onRemove: () => void;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onPick(file);
    e.target.value = '';
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) onPick(file);
  }

  return (
    <Field label="Logo image" hint={hint ?? 'Used by the outro scene. PNG / WebP with transparent background works best. Max 2 MB.'}>
      <div
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: '1px dashed rgba(255,255,255,0.18)',
          borderRadius: 8,
          padding: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          cursor: 'pointer',
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        {logoUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={logoUrl}
            alt="Channel logo preview"
            style={{
              width: 72,
              height: 72,
              objectFit: 'contain',
              borderRadius: 6,
              background: '#fff',
            }}
          />
        ) : (
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 6,
              background: 'rgba(255,255,255,0.04)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              fontSize: 11,
            }}
          >
            no logo
          </div>
        )}
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', flex: 1 }}>
          {uploading ? 'Uploading…' : logoUrl ? 'Drop a new file or click to replace.' : 'Drop a logo here, or click to choose a file.'}
          {error && <div style={{ color: '#ef4444', marginTop: 4 }}>{error}</div>}
        </div>
        {logoUrl && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="btn-secondary"
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            Remove
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/svg+xml"
        onChange={onChange}
        style={{ display: 'none' }}
      />
    </Field>
  );
}

// ─── Field wrapper ──────────────────────────────────────────────────────────
//
// Exported so callers can wrap arbitrary controls in the same label/hint
// shell — useful when the channel-display-name input is the odd one out.

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--text-secondary)',
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      {hint && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            marginBottom: 6,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}
