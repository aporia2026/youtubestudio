/**
 * Editor route loading state — Next.js App Router auto-renders this
 * during the Suspense boundary while `page.tsx`'s `loadProject` is
 * resolving against Postgres.
 *
 * Mimics the editor chrome's grid shape so the layout doesn't jump
 * when the real component takes over. Pure CSS — no client hooks
 * needed (this is a Server Component by default; `editor-skeleton`
 * is a CSS class scoped to `.editor-root` in editor-theme.css).
 *
 * Final piece of the Phase 7 loading-skeleton polish.
 */

import './editor-theme.css';

export default function EditorLoading() {
  return (
    <div className="editor-root">
      <div className="editor-grid">
        {/* Header skeleton — single bar approximating title + actions. */}
        <header className="editor-area-header editor-panel-flat" style={{ display: 'flex', alignItems: 'center', padding: '0 12px', gap: 12 }}>
          <span className="editor-skeleton" style={{ width: 220, height: 14, borderRadius: 4 }} aria-hidden />
          <span className="editor-skeleton" style={{ width: 140, height: 10, borderRadius: 4 }} aria-hidden />
          <span style={{ flex: 1 }} />
          <span className="editor-skeleton" style={{ width: 60, height: 24, borderRadius: 6 }} aria-hidden />
          <span className="editor-skeleton" style={{ width: 60, height: 24, borderRadius: 6 }} aria-hidden />
          <span className="editor-skeleton" style={{ width: 80, height: 24, borderRadius: 6 }} aria-hidden />
        </header>

        {/* Left rail skeleton — six icon-shaped blocks. */}
        <aside className="editor-area-rail editor-panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '10px 0' }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="editor-skeleton" style={{ width: 32, height: 32, borderRadius: 8 }} aria-hidden />
          ))}
        </aside>

        {/* Preview slot — single big block for the player. */}
        <main className="editor-area-preview">
          <div className="editor-panel" style={{ flex: 1, minHeight: 0, padding: 12 }}>
            <span
              className="editor-skeleton"
              style={{ display: 'block', width: '100%', height: '100%', borderRadius: 8 }}
              aria-hidden
            />
          </div>
        </main>

        {/* Inspector skeleton — tab strip + card placeholders. */}
        <aside className="editor-area-inspector editor-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="editor-skeleton" style={{ width: 50, height: 18, borderRadius: 4 }} aria-hidden />
            <span className="editor-skeleton" style={{ width: 50, height: 18, borderRadius: 4 }} aria-hidden />
            <span className="editor-skeleton" style={{ width: 60, height: 18, borderRadius: 4 }} aria-hidden />
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="editor-skeleton" style={{ width: '100%', height: 14, borderRadius: 4 }} aria-hidden />
          ))}
        </aside>

        {/* Timeline skeleton — ruler + four lane rows. */}
        <section className="editor-area-timeline editor-panel" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="editor-skeleton" style={{ width: '100%', height: 16, borderRadius: 4 }} aria-hidden />
          <span className="editor-skeleton" style={{ width: '100%', height: 64, borderRadius: 4 }} aria-hidden />
          <span className="editor-skeleton" style={{ width: '100%', height: 56, borderRadius: 4 }} aria-hidden />
          <span className="editor-skeleton" style={{ width: '100%', height: 32, borderRadius: 4 }} aria-hidden />
          <span className="editor-skeleton" style={{ width: '100%', height: 28, borderRadius: 4 }} aria-hidden />
        </section>
      </div>
    </div>
  );
}
