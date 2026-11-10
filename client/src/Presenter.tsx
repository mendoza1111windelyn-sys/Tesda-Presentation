import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "./Brand";
import { emptyState, Flipbook, usePdf, type SharedState } from "./PdfView";
import { useSocket } from "./socket";

type LibraryItem = {
  id: string;
  title: string;
  size: number;
  uploadedAt: string;
  pptName?: string;
};

export function Presenter() {
  const [token, setToken] = useState(() => sessionStorage.getItem("presenter-token") || "");
  if (!token) {
    return (
      <Login
        onLogin={(value) => {
          sessionStorage.setItem("presenter-token", value);
          setToken(value);
        }}
      />
    );
  }
  return (
    <Console
      token={token}
      onSignOut={() => {
        sessionStorage.removeItem("presenter-token");
        setToken("");
      }}
    />
  );
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Sign-in failed.");
      onLogin(body.token);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="splash">
      <Logo className="splash-logo small" />
      <form className="card" onSubmit={submit}>
        <h1>Presenter sign-in</h1>
        <label>
          Passcode
          <input type="password" autoFocus value={passcode} onChange={(event) => setPasscode(event.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="button" disabled={busy || !passcode}>Sign in</button>
      </form>
    </main>
  );
}

function Console({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [state, setState] = useState<SharedState>(emptyState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [guestCount, setGuestCount] = useState(0);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [title, setTitle] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pptFile, setPptFile] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);
  const stageRef = useRef<HTMLElement>(null);
  const guestLink = `${window.location.origin}/watch`;

  const authHeaders = { Authorization: `Bearer ${token}` };

  const { connected, send } = useSocket(`role=presenter&token=${encodeURIComponent(token)}`, {
    onMessage: (incoming) => {
      if (incoming.type === "state") setState(incoming.state);
      else if (incoming.type === "guests") setGuestCount(incoming.count);
    },
  });

  const patch = useCallback(
    (changes: Partial<SharedState>) => {
      stateRef.current = { ...stateRef.current, ...changes };
      setState(stateRef.current);
      send({ type: "state", patch: changes });
    },
    [send],
  );

  const current = library.find((item) => item.id === state.currentId);
  const { doc, error: pdfError } = usePdf(current ? `/api/files/${current.id}` : null, token);

  // The server needs the page count to keep guests within the deck.
  useEffect(() => {
    if (doc && connected) patch({ pages: doc.numPages });
  }, [doc, connected, patch]);

  async function loadLibrary() {
    const response = await fetch("/api/library", { headers: authHeaders });
    if (response.status === 401) return onSignOut();
    setLibrary(await response.json());
  }

  useEffect(() => {
    loadLibrary();
  }, []);

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!pdfFile) return;
    setUploading(true);
    setMessage("");
    const form = new FormData();
    form.append("title", title);
    form.append("pdf", pdfFile);
    if (pptFile) form.append("ppt", pptFile);
    try {
      const response = await fetch("/api/library", { method: "POST", headers: authHeaders, body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Upload failed.");
      setTitle("");
      setPdfFile(null);
      setPptFile(null);
      setFormKey((value) => value + 1);
      await loadLibrary();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function remove(item: LibraryItem) {
    if (!window.confirm(`Delete "${item.title}"?`)) return;
    await fetch(`/api/library/${item.id}`, { method: "DELETE", headers: authHeaders });
    await loadLibrary();
  }

  async function downloadPpt(item: LibraryItem) {
    const response = await fetch(`/api/files/${item.id}/ppt`, { headers: authHeaders });
    if (!response.ok) return setMessage("Could not download the PowerPoint file.");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = item.pptName || `${item.title}.pptx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function choose(item: LibraryItem) {
    if (item.id === stateRef.current.currentId) return;
    patch({ currentId: item.id, title: item.title, page: 1, pages: 0, started: false });
  }

  const go = useCallback(
    (page: number) => {
      const { pages } = stateRef.current;
      const next = Math.min(Math.max(page, 1), pages || 1);
      if (next !== stateRef.current.page) patch({ page: next });
    },
    [patch],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "BUTTON") return;
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        go(stateRef.current.page + 1);
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        go(stateRef.current.page - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const ready = !!doc && state.pages > 0;

  return (
    <div className="console">
      <header className="topbar">
        <Logo className="topbar-logo" />
        <strong className="topbar-title">Presenter</strong>
        <span className={connected ? "pill ok" : "pill warn"}>{connected ? "Connected" : "Reconnecting…"}</span>
        <span className="pill">{guestCount} guest{guestCount === 1 ? "" : "s"} online</span>
        <span className="spacer" />
        <code className="link">{guestLink}</code>
        <button className="button quiet" onClick={() => navigator.clipboard.writeText(guestLink)}>Copy guest link</button>
        <button className="button quiet" onClick={onSignOut}>Sign out</button>
      </header>

      <div className="console-body">
        <aside className="library">
          <h2>Presentations</h2>
          <form className="upload" onSubmit={upload} key={formKey}>
            <label>
              Title (optional)
              <input type="text" value={title} maxLength={150} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              PDF version <span className="req">required · shown to guests</span>
              <input type="file" accept="application/pdf,.pdf" onChange={(event) => setPdfFile(event.target.files?.[0] ?? null)} />
            </label>
            <label>
              PowerPoint <span className="req">optional · kept for you</span>
              <input type="file" accept=".pptx,.ppt,.ppsx,.pps" onChange={(event) => setPptFile(event.target.files?.[0] ?? null)} />
            </label>
            <button className="button" disabled={uploading || !pdfFile}>{uploading ? "Uploading…" : "Upload presentation"}</button>
          </form>
          {message && <p className="error">{message}</p>}
          <ul>
            {library.map((item) => (
              <li key={item.id} className={item.id === state.currentId ? "active" : ""}>
                <button className="link-button" onClick={() => choose(item)}>{item.title}</button>
                {item.pptName && <button className="icon" title="Download PowerPoint" aria-label={`Download PowerPoint of ${item.title}`} onClick={() => downloadPpt(item)}>⬇ PPT</button>}
                <button className="icon" aria-label={`Delete ${item.title}`} onClick={() => remove(item)}>✕</button>
              </li>
            ))}
            {library.length === 0 && <li className="muted">No presentations yet. Upload the PDF export of your PowerPoint (and the PowerPoint itself, if you like).</li>}
          </ul>
        </aside>

        <section className="stage" ref={stageRef}>
          {current ? (
            <>
              <div className="controls">
                <button className="button" onClick={() => go(state.page - 1)} disabled={state.page <= 1}>◀ Prev</button>
                <span>
                  Slide
                  <input
                    className="page-input"
                    type="number"
                    min={1}
                    max={state.pages || 1}
                    value={state.page}
                    onChange={(event) => go(Number(event.target.value) || 1)}
                  />
                  / {state.pages || "…"}
                </span>
                <button className="button" onClick={() => go(state.page + 1)} disabled={state.page >= state.pages}>Next ▶</button>
                <span className="spacer" />
                <button className="button quiet" onClick={() => stageRef.current?.requestFullscreen?.()}>Full screen</button>
                <button className={state.started ? "button danger" : "button go"} onClick={() => patch({ started: !state.started })} disabled={!state.started && !ready}>
                  {state.started ? "End presentation" : "Start presentation"}
                </button>
              </div>
              <p className="muted">
                {state.started
                  ? "Guests are watching. Their pages turn when you change slides (← → keys, clicker, or buttons)."
                  : "Guests see “Getting ready to present” until you press Start presentation."}
              </p>
              <div className="preview">
                {doc ? <Flipbook doc={doc} page={state.page} /> : <p className="muted">{pdfError || "Loading slides…"}</p>}
              </div>
            </>
          ) : (
            <p className="muted">Choose or upload a presentation to begin. Guests currently see “Getting ready to present”.</p>
          )}
        </section>
      </div>
    </div>
  );
}
