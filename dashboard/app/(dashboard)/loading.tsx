// Route-level loading fallback for the dashboard.
// Renders a token-styled skeleton while server data (Supabase, etc.) resolves,
// instead of a blank screen or the Next.js default.
export default function DashboardLoading() {
  return (
    <div className="page view-fade" aria-busy="true">
      <div className="page-h">
        <div>
          <h1>Loading…</h1>
          <div className="sub">Fetching the latest from the fleet.</div>
        </div>
      </div>

      <div className="kpis">
        {[0, 1, 2, 3].map((i) => (
          <div className="kpi tone-muted skeleton-kpi" key={i}>
            <div className="kpi-h">
              <span className="skel-line" style={{ width: 90, height: 12 }} />
            </div>
            <div className="skel-line" style={{ width: 64, height: 26, marginTop: 4 }} />
          </div>
        ))}
      </div>

      <div className="card pad">
        <div className="sec-h">
          <span className="skel-line" style={{ width: 140, height: 13 }} />
        </div>
        <div className="col" style={{ gap: 10 }}>
          {[0, 1, 2, 3].map((i) => (
            <span className="skel-line" style={{ width: `${90 - i * 12}%`, height: 14 }} key={i} />
          ))}
        </div>
      </div>

      <style>{`
        .skel-line {
          display: block;
          background: var(--bg-2);
          border: 1px solid var(--line);
          border-radius: 0;
        }
        .skeleton-kpi { opacity: .8; }
        [aria-busy="true"] .skel-line { animation: skel-pulse 1.3s ease-in-out infinite; }
        @keyframes skel-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
      `}</style>
    </div>
  );
}
