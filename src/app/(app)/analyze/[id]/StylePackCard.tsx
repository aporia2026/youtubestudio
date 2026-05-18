'use client';

/**
 * One style pack rendered as a card. The card has two states:
 *
 *   collapsed (default) — shows the pack's identity (label, scene
 *     count, overall_look) plus a "Save as preset" button. Most
 *     operators just glance at this and either save or move on.
 *
 *   editing — the save form expands inline beneath the card with the
 *     fields pre-filled from the pack. POST /api/production-doc/styles
 *     creates the row; on 201 we close the form and toast.
 *
 * Inline expansion beats a modal here because the operator usually
 * wants to compare pack values to what the form is about to write —
 * a modal would either steal the screen or float over the data.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import type { StylePack } from '@/lib/analyzer/types';

interface Props {
  pack: StylePack;
  sourceVideo: {
    videoId: string;
    title: string | null;
    channel: string | null;
  };
}

export function StylePackCard({ pack, sourceVideo }: Props): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const defaultName = buildDefaultPresetName(pack, sourceVideo);
  const defaultDescription = buildDefaultDescription(pack, sourceVideo);
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState(defaultDescription);
  const [suffix, setSuffix] = useState(pack.suggested_ai_image_suffix);
  const [mixing, setMixing] = useState(pack.suggested_mixing_rules);
  const [allowOverlay, setAllowOverlay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAs, setSavedAs] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    if (!suffix.trim()) {
      toast.error('AI image suffix is required');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/production-doc/styles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          ai_image_suffix: suffix.trim(),
          mixing_rules: mixing.trim() || null,
          allow_overlay_stock: allowOverlay,
        }),
      });
      const data = (await res.json()) as { style?: { id: string; name: string }; error?: string };
      if (!res.ok) {
        toast.error(data.error || `Save failed (${res.status})`);
        return;
      }
      setSavedAs(data.style?.name ?? name.trim());
      setEditing(false);
      toast.success(`Saved "${data.style?.name ?? name.trim()}" as a style preset`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <article
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-bright)',
        borderRadius: 12,
        padding: 20,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>
              {pack.label}
            </h3>
            <span
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                color: 'var(--text-tertiary)',
                padding: '1px 6px',
                borderRadius: 4,
                background: 'rgba(255,255,255,0.04)',
              }}
            >
              {pack.id}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {Math.round(pack.occupies_seconds)}s · {pack.scene_count} scene{pack.scene_count === 1 ? '' : 's'}
            {pack.pacing?.cut_style ? ` · ${pack.pacing.cut_style}` : ''}
          </div>
        </div>
        {savedAs ? (
          <span
            style={{
              fontSize: 12,
              color: '#86efac',
              padding: '4px 10px',
              borderRadius: 6,
              background: 'rgba(34,197,94,0.10)',
              border: '1px solid rgba(34,197,94,0.30)',
            }}
          >
            Saved as &ldquo;{savedAs}&rdquo;
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: editing ? 'var(--bg-input)' : '#7c3aed',
              color: editing ? 'var(--text-secondary)' : '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {editing ? 'Cancel' : 'Save as preset'}
          </button>
        )}
      </header>

      <p style={{ marginTop: 12, marginBottom: 0, color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.55 }}>
        {pack.overall_look}
      </p>

      <dl style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 14px', fontSize: 13 }}>
        <Row k="Lighting" v={pack.lighting} />
        <Row k="Camera" v={pack.camera_grammar} />
        <Row k="Typography" v={pack.typography_and_overlays} />
        <Row k="Pacing" v={`${pack.pacing.avg_scene_seconds.toFixed(1)}s avg · ${pack.pacing.cut_style}`} />
        <Row k="Palette" v={<PaletteRow colors={pack.color_palette} />} />
        {pack.voice_style && (
          <Row
            k="Voice"
            v={`${pack.voice_style.pace} pace · ${pack.voice_style.energy} energy · ${pack.voice_style.register}`}
          />
        )}
        <Row k="Music/SFX" v={pack.music_and_sfx} />
      </dl>

      <details style={{ marginTop: 14 }}>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--text-tertiary)',
            userSelect: 'none',
          }}
        >
          Preview the prompt suffix
        </summary>
        <pre
          style={{
            marginTop: 8,
            padding: 12,
            borderRadius: 6,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid var(--border-bright)',
            color: 'var(--text-secondary)',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          }}
        >
          {pack.suggested_ai_image_suffix}
        </pre>
      </details>

      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 10,
            background: 'rgba(124,58,237,0.06)',
            border: '1px solid rgba(124,58,237,0.30)',
            display: 'grid',
            gap: 12,
          }}
        >
          <Field
            label="Preset name"
            hint="Shown in the style picker on production docs."
            value={name}
            onChange={setName}
            maxLength={80}
          />
          <Field
            label="Description (optional)"
            value={description}
            onChange={setDescription}
            maxLength={240}
            textarea
          />
          <Field
            label="AI image suffix"
            hint="Appended to image generation prompts. Be concrete and prompt-ready."
            value={suffix}
            onChange={setSuffix}
            maxLength={1200}
            textarea
          />
          <Field
            label="Mixing rules (optional)"
            hint="When to mix AI generation with stock footage for this style."
            value={mixing}
            onChange={setMixing}
            maxLength={8000}
            textarea
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={allowOverlay} onChange={(e) => setAllowOverlay(e.target.checked)} />
            Allow overlay stock terms in the editor
          </label>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              style={{
                padding: '8px 14px',
                borderRadius: 6,
                border: '1px solid var(--border-bright)',
                background: 'transparent',
                color: 'var(--text-secondary)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: '8px 16px',
                borderRadius: 6,
                border: 'none',
                background: saving ? 'var(--bg-input)' : '#7c3aed',
                color: saving ? 'var(--text-secondary)' : '#fff',
                fontSize: 13,
                fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Save preset'}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }): React.ReactElement {
  return (
    <>
      <dt style={{ color: 'var(--text-tertiary)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', paddingTop: 2 }}>
        {k}
      </dt>
      <dd style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{v}</dd>
    </>
  );
}

function PaletteRow({ colors }: { colors: string[] }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {colors.map((c, i) => {
        const isHex = /^#?[0-9a-f]{6}$/i.test(c.trim());
        return (
          <span
            key={`${c}-${i}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 8px 2px 4px',
              borderRadius: 4,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border-bright)',
              fontSize: 12,
              color: 'var(--text-secondary)',
            }}
          >
            {isHex && (
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  background: c.trim().startsWith('#') ? c.trim() : `#${c.trim()}`,
                  border: '1px solid rgba(255,255,255,0.10)',
                }}
              />
            )}
            {c}
          </span>
        );
      })}
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  maxLength,
  textarea,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (s: string) => void;
  maxLength: number;
  textarea?: boolean;
}): React.ReactElement {
  const sharedStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid var(--border-bright)',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
  };
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
        {label}
        {hint && <span style={{ marginLeft: 8, color: 'var(--text-tertiary)', fontWeight: 400 }}>{hint}</span>}
      </label>
      {textarea ? (
        <textarea
          value={value}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
          rows={Math.min(8, Math.max(2, Math.ceil(value.length / 80)))}
          style={{ ...sharedStyle, resize: 'vertical' }}
        />
      ) : (
        <input
          type="text"
          value={value}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
          style={sharedStyle}
        />
      )}
      <div style={{ marginTop: 2, fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'right' }}>
        {value.length} / {maxLength}
      </div>
    </div>
  );
}

function buildDefaultPresetName(pack: StylePack, src: { title: string | null; channel: string | null }): string {
  const channel = src.channel?.trim();
  if (channel) {
    return truncate(`${channel} · ${pack.label}`, 80);
  }
  if (src.title) {
    return truncate(`${src.title} · ${pack.label}`, 80);
  }
  return truncate(pack.label, 80);
}

function buildDefaultDescription(pack: StylePack, src: { videoId: string; channel: string | null }): string {
  const parts = [
    `Extracted from ${src.channel || 'a YouTube video'}.`,
    pack.overall_look,
  ].filter(Boolean);
  return truncate(parts.join(' '), 240);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
