export default function ReviewNotFound() {
  return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <div className="text-center">
        <div className="text-6xl mb-4 opacity-20">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto" style={{ color: 'var(--text-muted)' }}>
            <circle cx="12" cy="12" r="10" />
            <path d="M15 9l-6 6M9 9l6 6" />
          </svg>
        </div>
        <h1 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
          Link Expired or Invalid
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          This review link is no longer active. Ask the project owner for a new link.
        </p>
      </div>
    </div>
  );
}
