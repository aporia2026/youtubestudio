'use client';

/**
 * Global language + region picker for the niche-finder hub.
 *
 * Renders two compact selects at the top of the page. Initial values
 * are loaded from `/api/user/settings/niche-finder-locale` on mount;
 * changes write back to the same endpoint and call `onChange` so the
 * parent can re-run any in-flight queries against the new locale.
 *
 * Defaults to 'en' / 'US' when the user has nothing saved. Persists
 * across sessions because the underlying field lives on the encrypted
 * user-settings blob.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ALLOWED_LANGUAGES,
  ALLOWED_REGIONS,
  DEFAULT_LANGUAGE,
  DEFAULT_REGION,
} from '@/lib/niche-finder/locales';

export interface NicheFinderLocale {
  language: string;
  region: string;
}

interface Props {
  /** Latest known values — controlled by the parent so it can also
   *  reflect the result of an in-flight load. */
  value: NicheFinderLocale;
  /** Fired when either select changes. The parent should update its
   *  own state AND trigger any pending re-search. The PUT to the
   *  settings endpoint is handled internally by this component. */
  onChange: (next: NicheFinderLocale) => void;
}

export function NicheFinderLocalePicker({ value, onChange }: Props): React.ReactElement {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useCallback(async (next: NicheFinderLocale) => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/user/settings/niche-finder-locale', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setSaveError(body?.error ?? `Save failed (${res.status})`);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  }, []);

  const onLanguage = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = { language: e.target.value, region: value.region };
      onChange(next);
      void save(next);
    },
    [onChange, save, value.region],
  );

  const onRegion = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = { language: value.language, region: e.target.value };
      onChange(next);
      void save(next);
    },
    [onChange, save, value.language],
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '10px 14px',
        marginBottom: 12,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 10,
      }}
    >
      <div style={{ fontSize: 12, color: '#94a3b8' }}>
        Searches use:
      </div>
      <label style={labelStyle}>
        <span style={labelTextStyle}>Language</span>
        <select value={value.language} onChange={onLanguage} disabled={saving} style={selectStyle}>
          {ALLOWED_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label style={labelStyle}>
        <span style={labelTextStyle}>Region</span>
        <select value={value.region} onChange={onRegion} disabled={saving} style={selectStyle}>
          {ALLOWED_REGIONS.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <div style={{ fontSize: 11, color: '#64748b', flex: 1, minWidth: 0 }}>
        Applies to every tab + deep-dive. Saved to your profile.
      </div>
      {saving && <span style={{ fontSize: 11, color: '#64748b' }}>Saving…</span>}
      {saveError && (
        <span style={{ fontSize: 11, color: '#fca5a5' }} title={saveError}>
          Save failed
        </span>
      )}
    </div>
  );
}

/** Initial-state hook used by the page so the picker shows the saved
 *  values on first render rather than flashing the hard-coded
 *  defaults. Returns `[locale, setLocale, ready]` — `ready` flips to
 *  true once the GET has resolved (or failed), giving the caller a
 *  signal to suppress re-fetches that depend on the picker. */
export function useNicheFinderLocale(): {
  locale: NicheFinderLocale;
  setLocale: (next: NicheFinderLocale) => void;
  ready: boolean;
} {
  const [locale, setLocale] = useState<NicheFinderLocale>({
    language: DEFAULT_LANGUAGE,
    region: DEFAULT_REGION,
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/user/settings/niche-finder-locale');
        if (!res.ok || cancelled) {
          if (!cancelled) setReady(true);
          return;
        }
        const body = (await res.json()) as { language?: unknown; region?: unknown };
        if (cancelled) return;
        setLocale({
          language: typeof body.language === 'string' ? body.language : DEFAULT_LANGUAGE,
          region: typeof body.region === 'string' ? body.region : DEFAULT_REGION,
        });
      } catch {
        // Network blip — keep the hard-coded defaults.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { locale, setLocale, ready };
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: '#cbd5e1',
};
const labelTextStyle: React.CSSProperties = {
  color: '#64748b',
};
const selectStyle: React.CSSProperties = {
  padding: '4px 8px',
  background: '#0d0d14',
  color: '#e2e8f0',
  border: '1px solid #334155',
  borderRadius: 6,
  fontSize: 12,
  cursor: 'pointer',
};
