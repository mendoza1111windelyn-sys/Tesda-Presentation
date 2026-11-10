import { useState } from "react";
import { Logo, Splash, Tagline } from "./Brand";
import { emptyState, Flipbook, usePdf, type SharedState } from "./PdfView";
import { useSocket } from "./socket";

export function Guest() {
  const [state, setState] = useState<SharedState>(emptyState);
  const { connected } = useSocket("role=guest", {
    onMessage: (incoming) => {
      if (incoming.type === "state") setState(incoming.state);
    },
  });

  const live = state.started && !!state.currentId;
  const { doc, error } = usePdf(live ? `/api/files/${state.currentId}` : null);

  if (!live) return <Splash status={connected ? undefined : "Connecting…"} />;

  const total = doc?.numPages || state.pages;
  const percent = total ? Math.min(100, (state.page / total) * 100) : 0;

  return (
    <div className="guest">
      <header className="topbar">
        <Logo className="topbar-logo" />
        <h1 className="topbar-title">{state.title}</h1>
        <span className="spacer" />
        {!connected && <span className="pill warn">Reconnecting…</span>}
        {total > 0 && <span className="pill">Slide {Math.min(state.page, total)} / {total}</span>}
        <a className="button" href={`/api/files/${state.currentId}?download=1`} download>Download PDF</a>
      </header>

      <div className="guest-stage">
        {doc ? <Flipbook doc={doc} page={state.page} /> : <p className="muted">{error || "Loading slides…"}</p>}
      </div>

      <footer className="guest-footer">
        <div className="progress"><div style={{ width: `${percent}%` }} /></div>
        <Tagline className="footer-tagline" />
      </footer>
    </div>
  );
}
