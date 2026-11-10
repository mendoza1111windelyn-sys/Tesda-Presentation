import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "./Brand";
import { emptyState, Flipbook, usePdf, type SharedState } from "./PdfView";
import { useSocket } from "./socket";
import { apiUrl, guestUrl } from "./config";

type LibraryItem = {
  id: string;
  title: string;
  size: number;
  uploadedAt: string;
  pptName?: string;
};

export function Presenter() {
  const [token, setToken] = useState(() => sessionStorage.getItem("presenter-token") || "");
  const setPresenterToken = (value: string) => {
    sessionStorage.setItem("presenter-token", value);
    setToken(value);
  };
  if (!token) {
    return <Login onLogin={setPresenterToken} />;
  }
  return (
    <Console
      token={token}
      onTokenChanged={setPresenterToken}
      onSignOut={() => {
        sessionStorage.removeItem("presenter-token");
        setToken("");
      }}
    />
  );
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [passcode, setPasscode] = useState("");
  const [bootstrapPasscode, setBootstrapPasscode] = useState("");
  const [newPasscode, setNewPasscode] = useState("");
  const [confirmPasscode, setConfirmPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(apiUrl("/api/auth/status"));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not check presenter setup.");
      if (typeof body.configured !== "boolean") throw new Error("Presenter setup status was invalid.");
      setConfigured(body.configured);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not check presenter setup.");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!configured && newPasscode !== confirmPasscode) throw new Error("The new passcodes do not match.");
      const response = await fetch(apiUrl(configured ? "/api/login" : "/api/auth/setup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          configured
            ? { passcode }
            : { bootstrapPasscode, newPasscode },
        ),
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
        {configured === null ? (
          <h1>{error ? "Could not connect to presenter service" : "Loading presenter access…"}</h1>
        ) : configured ? (
          <>
            <h1>Presenter sign-in</h1>
            <label>
              Passcode
              <input type="password" autoFocus value={passcode} onChange={(event) => setPasscode(event.target.value)} />
            </label>
          </>
        ) : (
          <>
            <h1>Set up presenter passcode</h1>
            <p className="muted">Use the one-time setup passcode from Render, then choose a new passcode with at least 12 characters. You can change it later in Presenter settings.</p>
            <label>
              One-time setup passcode
              <input type="password" autoFocus value={bootstrapPasscode} onChange={(event) => setBootstrapPasscode(event.target.value)} />
            </label>
            <label>
              New presenter passcode
              <input type="password" minLength={12} autoComplete="new-password" value={newPasscode} onChange={(event) => setNewPasscode(event.target.value)} />
            </label>
            <label>
              Confirm new passcode
              <input type="password" minLength={12} autoComplete="new-password" value={confirmPasscode} onChange={(event) => setConfirmPasscode(event.target.value)} />
            </label>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button
          className="button"
          type={configured === null ? "button" : "submit"}
          onClick={configured === null ? () => void loadStatus() : undefined}
          disabled={busy || (configured === null && !error) || (configured ? !passcode : !bootstrapPasscode || !newPasscode || !confirmPasscode)}
        >
          {configured === null ? (error ? "Try again" : "Loading…") : configured ? "Sign in" : "Set passcode"}
        </button>
      </form>
    </main>
  );
}

function Console({ token, onSignOut, onTokenChanged }: { token: string; onSignOut: () => void; onTokenChanged: (token: string) => void }) {
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
  const [showPasscodeSettings, setShowPasscodeSettings] = useState(false);
  const [currentPasscode, setCurrentPasscode] = useState("");
  const [newPasscode, setNewPasscode] = useState("");
  const [confirmPasscode, setConfirmPasscode] = useState("");
  const [savingPasscode, setSavingPasscode] = useState(false);
  const [passcodeMessage, setPasscodeMessage] = useState("");
  const stageRef = useRef<HTMLElement>(null);
  const guestLink = guestUrl;

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
  const { doc, error: pdfError } = usePdf(current ? apiUrl(`/api/files/${current.id}`) : null, token);
  const authHeaders = { Authorization: `Bearer ${token}` };

  // The server needs the page count to keep guests within the deck.
  useEffect(() => {
    if (doc && connected) patch({ pages: doc.numPages });
  }, [doc, connected, patch]);

  async function loadLibrary() {
    const response = await fetch(apiUrl("/api/library"), { headers: authHeaders });
    if (response.status === 401) return onSignOut();
    setLibrary(await response.json());
  }

  useEffect(() => {
    loadLibrary();
  }, []);

  async function changePasscode(event: React.FormEvent) {
    event.preventDefault();
    setPasscodeMessage("");
    if (newPasscode !== confirmPasscode) return setPasscodeMessage("The new passcodes do not match.");
    setSavingPasscode(true);
    try {
      const response = await fetch(apiUrl("/api/auth/change-passcode"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ currentPasscode, newPasscode }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not change passcode.");
      onTokenChanged(body.token);
      setCurrentPasscode("");
      setNewPasscode("");
      setConfirmPasscode("");
      setPasscodeMessage("Passcode changed.");
    } catch (caught) {
      setPasscodeMessage(caught instanceof Error ? caught.message : "Could not change passcode.");
    } finally {
      setSavingPasscode(false);
    }
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!pdfFile) return;
    const maxFileSize = 50 * 1024 * 1024;
    if (pdfFile.size > maxFileSize || (pptFile && pptFile.size > maxFileSize)) {
      setMessage("Each file must be 50 MiB or smaller.");
      return;
    }
    setUploading(true);
    setMessage("");
    const form = new FormData();
    form.append("title", title);
    form.append("pdf", pdfFile);
    if (pptFile) form.append("ppt", pptFile);
    try {
      const response = await fetch(apiUrl("/api/library"), { method: "POST", headers: authHeaders, body: form });
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
    await fetch(apiUrl(`/api/library/${item.id}`), { method: "DELETE", headers: authHeaders });
    await loadLibrary();
  }

  async function downloadPpt(item: LibraryItem) {
    const response = await fetch(apiUrl(`/api/files/${item.id}/ppt`), { headers: authHeaders });
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
        <button className="button quiet" onClick={() => setShowPasscodeSettings((value) => !value)}>Presenter settings</button>
        <button className="button quiet" onClick={onSignOut}>Sign out</button>
      </header>

      <div className="console-body">
        <aside className="library">
          {showPasscodeSettings && (
            <form className="upload" onSubmit={changePasscode}>
              <h2>Change presenter passcode</h2>
              <label>
                Current passcode
                <input type="password" autoComplete="current-password" value={currentPasscode} onChange={(event) => setCurrentPasscode(event.target.value)} />
              </label>
              <label>
                New passcode <span className="req">at least 12 characters</span>
                <input type="password" minLength={12} autoComplete="new-password" value={newPasscode} onChange={(event) => setNewPasscode(event.target.value)} />
              </label>
              <label>
                Confirm new passcode
                <input type="password" minLength={12} autoComplete="new-password" value={confirmPasscode} onChange={(event) => setConfirmPasscode(event.target.value)} />
              </label>
              {passcodeMessage && <p className={passcodeMessage === "Passcode changed." ? "muted" : "error"}>{passcodeMessage}</p>}
              <button className="button" disabled={savingPasscode || !currentPasscode || !newPasscode || !confirmPasscode}>
                {savingPasscode ? "Saving…" : "Change passcode"}
              </button>
            </form>
          )}
          <h2>Presentations</h2>
          <form className="upload" onSubmit={upload} key={formKey}>
            <label>
              Title (optional)
              <input type="text" value={title} maxLength={150} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              PDF version <span className="req">required · shown to guests · max 50 MiB</span>
              <input type="file" accept="application/pdf,.pdf" onChange={(event) => setPdfFile(event.target.files?.[0] ?? null)} />
            </label>
            <label>
              PowerPoint <span className="req">optional · kept for you · max 50 MiB</span>
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
