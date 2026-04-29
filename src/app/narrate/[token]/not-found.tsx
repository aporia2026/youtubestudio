export default function NarrateNotFound() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Link Invalid</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>This narrator portal link is no longer active.</p>
      </div>
    </div>
  );
}
