export default function NarratorNotFound() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Invalid dashboard link</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Ask the project owner to send you a fresh link.</p>
      </div>
    </div>
  );
}
