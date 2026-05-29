'use client';

/**
 * Per-video visual brand kit override panel on the production-doc page.
 *
 * Sits below the brand-kit quick-tweak bar and lets a creator override
 * any field of the channel-level visual brand kit just for this video.
 * The override is persisted into the production-doc entry's payload via
 * the parent component — this panel never touches the API by itself
 * for the kit values; only the logo upload reaches out (and only when a
 * channel id is present, since the upload endpoint is channel-scoped).
 *
 * Empty override fields fall through to the channel default — the
 * placeholder text always shows the value the renderer would use if the
 * field stayed empty.
 *
 * Lazy-user posture (CLAUDE.md rule 10): default collapsed, one-click
 * expand, every field labelled with the channel default it replaces,
 * "Clear override" button per field instead of forcing a typed reset.
 */
import { useState } from 'react';
import type { FontFamilyName } from '@/remotion/fonts';
import { ALLOWED_FONT_FAMILIES, FONT_REGISTRY } from '@/remotion/fonts';
import type { ChannelVisualBrandKit } from '@/lib/channel-visual-brand-kit';
import {
  COLOR_FIELDS,
  HEX_RE,
  LogoDropzone,
  Field,
  type ColorFieldKey,
} from '@/components/visual-brand-kit/VisualBrandKitFields';

export function VisualBrandKitOverridePanel({
  channelId,
  channelKit,
  override,
  onChange,
}: {
  /** Active channel id, or null when no channel is pinned. Drives the
   *  logo upload endpoint — without a channel id we can't presign. */
  channelId: string | null;
  /** Channel-level defaults; values shown as placeholders. Null when no
   *  channel is active (the override is then the only source). */
  channelKit: ChannelVisualBrandKit | null;
  override: ChannelVisualBrandKit;
  onChange: (next: ChannelVisualBrandKit) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  // Count of overridden fields drives the chip label so the collapsed
  // state shows whether anything is in effect.
  const overrideCount = countOverrideFields(override);

  function patch<K extends keyof ChannelVisualBrandKit>(
    key: K,
    value: ChannelVisualBrandKit[K] | undefined,
  ) {
    const next = { ...override };
    if (value === undefined || value === '') {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  }

  async function uploadLogo(file: File) {
    if (!channelId) {
      setLogoError('Pin a channel before uploading a logo.');
      return;
    }
    setLogoError(null);
    setLogoUploading(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const presignRes = await fetch(`/api/channels/${channelId}/visual-brand-kit/logo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          fileSize: file.size,
        }),
      });
      if (!presignRes.ok) {
        const d = await presignRes.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to issue logo upload URL');
      }
      const { uploadUrl, downloadUrl } = (await presignRes.json()) as {
        uploadUrl: string;
        downloadUrl: string;
      };
      // eslint-disable-next-line no-restricted-syntax -- awaited PUT RPC - awaits and uses response
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (HTTP ${putRes.status})`);
      patch('logoUrl', downloadUrl);
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : 'Logo upload failed');
    } finally {
      setLogoUploading(false);
    }
  }

  // ─── Collapsed header ───────────────────────────────────────────────

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '8px 12px',
          borderRadius: 8,
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(255,255,255,0.02)',
          color: 'var(--text-secondary)',
          fontSize: 13,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>
          ▸ Override visual brand kit (this video only)
        </span>
        <span
          style={{
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 999,
            background:
              overrideCount > 0 ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.04)',
            color: overrideCount > 0 ? '#a5b4fc' : 'var(--text-muted)',
          }}
        >
          {overrideCount > 0
            ? `${overrideCount} field${overrideCount === 1 ? '' : 's'} overridden`
            : 'using channel defaults'}
        </span>
      </button>
    );
  }

  // ─── Expanded form ──────────────────────────────────────────────────

  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(255,255,255,0.02)',
        borderRadius: 8,
        padding: 16,
      }}
      className="space-y-4"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
            Override visual brand kit (this video only)
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Leave any field blank to use the channel default. Saves on change.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="btn-secondary"
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          ▴ Collapse
        </button>
      </div>

      <FontOverrideRow
        label="Body font"
        channelDefault={channelKit?.fontFamily}
        value={override.fontFamily ?? ''}
        onChange={(v) => patch('fontFamily', v || undefined)}
      />
      <FontOverrideRow
        label="Title font"
        channelDefault={channelKit?.titleFontFamily}
        value={override.titleFontFamily ?? ''}
        onChange={(v) => patch('titleFontFamily', v || undefined)}
      />

      <div className="space-y-3">
        {COLOR_FIELDS.map((f) => (
          <ColorOverrideRow
            key={f.key}
            label={f.label}
            channelDefault={channelKit?.[f.key]}
            value={override[f.key] ?? ''}
            onChange={(v) => {
              if (v === '' || HEX_RE.test(v)) {
                patch(f.key as ColorFieldKey, v || undefined);
              }
            }}
          />
        ))}
      </div>

      <LogoDropzone
        logoUrl={override.logoUrl ?? channelKit?.logoUrl ?? ''}
        uploading={logoUploading}
        error={logoError}
        onPick={(file) => void uploadLogo(file)}
        onRemove={() => patch('logoUrl', undefined)}
        hint={
          override.logoUrl
            ? 'Override active — uploading replaces the per-video logo. Use Remove to fall back to the channel logo.'
            : 'Currently using the channel logo. Drop a file to override for this video.'
        }
      />

      <Field
        label="Channel display name (override)"
        hint={`Channel default: "${channelKit?.channelName || '(none — uses YouTube channel name)'}"`}
      >
        <input
          className="input-field"
          maxLength={80}
          value={override.channelName ?? ''}
          onChange={(e) => patch('channelName', e.target.value.trim() || undefined)}
          placeholder="leave blank to use channel default"
        />
      </Field>

      {overrideCount > 0 && (
        <button
          type="button"
          onClick={() => onChange({ v: 1 })}
          className="btn-secondary"
          style={{ fontSize: 12, padding: '6px 12px' }}
        >
          Clear all overrides
        </button>
      )}
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function FontOverrideRow({
  label,
  channelDefault,
  value,
  onChange,
}: {
  label: string;
  channelDefault: FontFamilyName | undefined;
  value: FontFamilyName | '';
  onChange: (v: FontFamilyName | '') => void;
}) {
  const placeholderFamily = channelDefault
    ? FONT_REGISTRY[channelDefault].fallback
    : 'Inter, system-ui, sans-serif';
  const placeholderLabel = channelDefault
    ? `Channel default: ${channelDefault}`
    : 'Channel default: Inter';

  return (
    <Field label={label} hint={placeholderLabel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <select
          className="input-field"
          value={value}
          onChange={(e) => onChange(e.target.value as FontFamilyName | '')}
          style={{ flex: 1, fontFamily: value ? FONT_REGISTRY[value].fallback : placeholderFamily }}
        >
          <option value="">(use channel default)</option>
          {ALLOWED_FONT_FAMILIES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
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

function ColorOverrideRow({
  label,
  channelDefault,
  value,
  onChange,
}: {
  label: string;
  channelDefault: string | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field
      label={label}
      hint={`Channel default: ${channelDefault ?? '(none — uses Remotion default)'}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="color"
          value={value || channelDefault || '#000000'}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 36,
            height: 30,
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6,
            padding: 0,
            background: 'transparent',
            cursor: 'pointer',
          }}
        />
        <input
          className="input-field"
          placeholder={channelDefault ?? '#RRGGBB or blank'}
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function countOverrideFields(override: ChannelVisualBrandKit): number {
  let n = 0;
  if (override.fontFamily) n++;
  if (override.titleFontFamily) n++;
  if (override.primaryColor) n++;
  if (override.secondaryColor) n++;
  if (override.backgroundColor) n++;
  if (override.textColor) n++;
  if (override.titleColor) n++;
  if (override.logoUrl) n++;
  if (override.channelName) n++;
  return n;
}
