'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FontFamilyName } from '@/remotion/fonts';
import type { ChannelVisualBrandKit } from '@/lib/channel-visual-brand-kit';
import {
  FontPicker,
  ColorField,
  LogoDropzone,
  Field,
  COLOR_FIELDS,
  HEX_RE,
  type ColorFieldKey,
} from '@/components/visual-brand-kit/VisualBrandKitFields';

export default function ChannelVisualBrandKitPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [channelName, setChannelName] = useState<string>('');

  // Form state — every field is the value as it should be persisted, or
  // empty string for "fall back to default."
  const [fontFamily, setFontFamily] = useState<FontFamilyName | ''>('');
  const [titleFontFamily, setTitleFontFamily] = useState<FontFamilyName | ''>('');
  const [colors, setColors] = useState<Record<ColorFieldKey, string>>({
    primaryColor: '',
    secondaryColor: '',
    backgroundColor: '',
    textColor: '',
    titleColor: '',
  });
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [chanRes, kitRes] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax -- GET, read
          fetch('/api/channels'),
          // eslint-disable-next-line no-restricted-syntax -- GET, read
          fetch(`/api/channels/${id}/visual-brand-kit`),
        ]);
        if (cancelled) return;
        if (chanRes.ok) {
          const data = await chanRes.json();
          const ch = (data.channels || []).find((c: { id: string }) => c.id === id);
          if (ch) setChannelName(ch.name);
        }
        if (!kitRes.ok) {
          const d = await kitRes.json().catch(() => ({}));
          throw new Error(d.error || 'Failed to load visual brand kit');
        }
        const { visual_brand_kit } = (await kitRes.json()) as {
          visual_brand_kit: ChannelVisualBrandKit;
        };
        setFontFamily(visual_brand_kit.fontFamily ?? '');
        setTitleFontFamily(visual_brand_kit.titleFontFamily ?? '');
        setColors({
          primaryColor: visual_brand_kit.primaryColor ?? '',
          secondaryColor: visual_brand_kit.secondaryColor ?? '',
          backgroundColor: visual_brand_kit.backgroundColor ?? '',
          textColor: visual_brand_kit.textColor ?? '',
          titleColor: visual_brand_kit.titleColor ?? '',
        });
        setLogoUrl(visual_brand_kit.logoUrl ?? '');
        setDisplayName(visual_brand_kit.channelName ?? '');
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // ─── Logo upload ────────────────────────────────────────────────────────
  //
  // Two-step flow mirroring the production-doc thumbnail upload: POST the
  // metadata to get a presigned R2 PUT URL + the public download URL, then
  // browser → R2 directly. The PUT is unsigned-by-method (R2 enforces the
  // signature inside the URL).

  async function uploadLogo(file: File) {
    setLogoError(null);
    setLogoUploading(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const presignRes = await fetch(`/api/channels/${id}/visual-brand-kit/logo`, {
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
      if (!putRes.ok) {
        throw new Error(`R2 upload failed (HTTP ${putRes.status})`);
      }
      setLogoUrl(downloadUrl);
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : 'Logo upload failed');
    } finally {
      setLogoUploading(false);
    }
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();

    // Client-side validate hex so the user sees an inline error before the
    // server silently drops the bad value through parseVisualBrandKit.
    const badColor = (Object.entries(colors) as [ColorFieldKey, string][]).find(
      ([, v]) => v !== '' && !HEX_RE.test(v),
    );
    if (badColor) {
      setError(`${COLOR_FIELDS.find((f) => f.key === badColor[0])?.label}: must be a #RRGGBB hex color.`);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const body: Partial<ChannelVisualBrandKit> = {
        v: 1,
        fontFamily: (fontFamily || undefined) as FontFamilyName | undefined,
        titleFontFamily: (titleFontFamily || undefined) as FontFamilyName | undefined,
        primaryColor: colors.primaryColor || undefined,
        secondaryColor: colors.secondaryColor || undefined,
        backgroundColor: colors.backgroundColor || undefined,
        textColor: colors.textColor || undefined,
        titleColor: colors.titleColor || undefined,
        logoUrl: logoUrl || undefined,
        channelName: displayName.trim() || undefined,
      };
      // eslint-disable-next-line no-restricted-syntax -- awaited PUT RPC - awaits and uses response
      const res = await fetch(`/api/channels/${id}/visual-brand-kit`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Save failed');
      }
      setSavedAt(Date.now());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded && !error) {
    return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 920, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <Link
          href="/channel"
          style={{ fontSize: 13, color: 'var(--text-muted)', textDecoration: 'none' }}
          className="hover:underline"
        >
          ← All channels
        </Link>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', marginTop: 6 }}>
          Visual brand kit{channelName ? ` — ${channelName}` : ''}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>
          Fonts, colors, and logo the Remotion renderer uses for every video on this channel. Production docs can override per-video.
        </p>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          Looking for voice and tone? See the{' '}
          <Link href={`/channel/${id}/brand-kit`} className="hover:underline" style={{ color: 'var(--text-secondary)' }}>
            script brand kit
          </Link>{' '}
          (separate setting).
        </div>
      </div>

      {error && (
        <div
          style={{
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#ef4444',
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={onSave} className="space-y-5">
        <Section title="Fonts">
          <FontPicker
            label="Body font"
            hint="Lower-third text, captions, body content. Falls back to Inter."
            value={fontFamily}
            onChange={setFontFamily}
          />
          <FontPicker
            label="Title font"
            hint="Bold titles + section-divider stripe (the white-on-grey overlay above each scene)."
            value={titleFontFamily}
            onChange={setTitleFontFamily}
          />
        </Section>

        <Section title="Colors">
          {COLOR_FIELDS.map((f) => (
            <ColorField
              key={f.key}
              label={f.label}
              hint={f.hint}
              value={colors[f.key]}
              onChange={(v) => setColors((prev) => ({ ...prev, [f.key]: v }))}
            />
          ))}
        </Section>

        <Section title="Logo + channel name">
          <LogoDropzone
            logoUrl={logoUrl}
            uploading={logoUploading}
            error={logoError}
            onPick={(file) => void uploadLogo(file)}
            onRemove={() => setLogoUrl('')}
          />

          <Field
            label="Channel display name"
            hint={`Shown in the outro card. Leave blank to use the channel name from YouTube ("${channelName || 'unconnected'}").`}
          >
            <input
              className="input-field"
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
        </Section>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 24 }}>
          <button type="submit" disabled={saving || logoUploading} className="btn-primary">
            {saving ? 'Saving…' : 'Save visual brand kit'}
          </button>
          {savedAt && Date.now() - savedAt < 3000 && (
            <span style={{ fontSize: 13, color: '#10b981' }}>Saved ✓</span>
          )}
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        padding: 20,
      }}
      className="space-y-4"
    >
      <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</h2>
      {children}
    </section>
  );
}
