import { useCallback, useEffect, useRef, useState } from "react";
import { emptyState, PdfView, type SharedState } from "./PdfView";
import { rtcConfig, useSocket } from "./socket";

type LibraryItem = { id: string; title: string; size: number; uploadedAt: string };

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
    <main className="center-screen">
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
  const [sharing, setSharing] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, RTCPeerConnection>());
  const previewRef = useRef<HTMLVideoElement>(null);
  const guestLink = `${window.location.origin}/watch`;

  const authHeaders = { Authorization: `Bearer ${token}` };

  const { connected, send } = useSocket(`role=presenter&token=${encodeURIComponent(token)}`, {
    onMessage: async (incoming) => {
      if (incoming.type === "state") setState(incoming.state);
      else if (incoming.type === "guests") setGuestCount(incoming.count);
      else if (incoming.type === "request-stream") await offerTo(incoming.from);
      else if (incoming.type === "signal") await handleSignal(incoming.from, incoming.data);
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

  async function offerTo(guestId: string) {
    const stream = streamRef.current;
    if (!stream) return;
    peers.current.get(guestId)?.close();
    const peer = new RTCPeerConnection(rtcConfig);
    peers.current.set(guestId, peer);
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.onicecandidate = (event) => {
      if (event.candidate) send({ type: "signal", to: guestId, data: { candidate: event.candidate } });
    };
    peer.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(peer.connectionState)) peers.current.delete(guestId);
    };
    await peer.setLocalDescription(await peer.createOffer());
    send({ type: "signal", to: guestId, data: { description: peer.localDescription } });
  }

  async function handleSignal(guestId: string, data: any) {
    const peer = peers.current.get(guestId);
    if (!peer) return;
    if (data.description) await peer.setRemoteDescription(data.description);
    else if (data.candidate) await peer.addIceCandidate(data.candidate).catch(() => {});
  }

  async function startShare() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      streamRef.current = stream;
      stream.getVideoTracks()[0].onended = () => stopShare();
      if (previewRef.current) previewRef.current.srcObject = stream;
      setSharing(true);
      patch({ live: true });
    } catch {
      setMessage("Screen sharing was cancelled or is not supported on this device.");
    }
  }

  function stopShare() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    peers.current.forEach((peer) => peer.close());
    peers.current.clear();
    if (previewRef.current) previewRef.current.srcObject = null;
    setSharing(false);
    patch({ live: false });
  }

  // After a reconnect the server clears `live`; restore it if the capture is still running.
  useEffect(() => {
    if (connected && streamRef.current) send({ type: "state", patch: { live: true } });
  }, [connected, send]);

  useEffect(() => {
    if (sharing && previewRef.current && streamRef.current) previewRef.current.srcObject = streamRef.current;
  }, [sharing]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      peers.current.forEach((peer) => peer.close());
    };
  }, []);

  async function loadLibrary() {
    const response = await fetch("/api/library", { headers: authHeaders });
    if (response.status === 401) return onSignOut();
    setLibrary(await response.json());
  }

  useEffect(() => {
    loadLibrary();
  }, []);

  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setMessage("");
    const form = new FormData();
    form.append("file", file);
    try {
      const response = await fetch("/api/library", { method: "POST", headers: authHeaders, body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Upload failed.");
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
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      if (["ArrowRight", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        go(stateRef.current.page + 1);
      } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        go(stateRef.current.page - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const current = library.find((item) => item.id === state.currentId);

  return (
    <div className="console">
      <header className="topbar">
        <strong>Presenter</strong>
        <span className={connected ? "pill ok" : "pill"}>{connected ? "Connected" : "Reconnecting…"}</span>
        <span className="pill">{guestCount} guest{guestCount === 1 ? "" : "s"} waiting/watching</span>
        <button className="button quiet" onClick={() => navigator.clipboard.writeText(guestLink)}>Copy guest link</button>
        <code className="link">{guestLink}</code>
        <button className="button quiet" onClick={onSignOut}>Sign out</button>
      </header>

      <div className="console-body">
        <aside className="library">
          <h2>Presentations</h2>
          <label className="button upload">
            {uploading ? "Uploading…" : "Upload PDF"}
            <input type="file" accept="application/pdf,.pdf" hidden disabled={uploading} onChange={(event) => { upload(event.target.files?.[0]); event.target.value = ""; }} />
          </label>
          {message && <p className="error">{message}</p>}
          <ul>
            {library.map((item) => (
              <li key={item.id} className={item.id === state.currentId ? "active" : ""}>
                <button className="link-button" onClick={() => choose(item)}>{item.title}</button>
                <button className="icon" aria-label={`Delete ${item.title}`} onClick={() => remove(item)}>✕</button>
              </li>
            ))}
            {library.length === 0 && <li className="muted">No presentations yet. Export your PowerPoint as PDF and upload it.</li>}
          </ul>
        </aside>

        <section className="stage">
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
                <button className={state.started ? "button danger" : "button"} onClick={() => patch({ started: !state.started })}>
                  {state.started ? "End broadcast" : "Start broadcast"}
                </button>
                <button className={sharing ? "button danger" : "button"} onClick={sharing ? stopShare : startShare} disabled={!state.started}>
                  {sharing ? "Stop screen share" : "Share screen (live)"}
                </button>
              </div>
              <p className="muted">
                {state.started
                  ? "Guests can now see your slides. Use ← → keys to change slides. Share your screen to show animations live."
                  : "Guests see a waiting screen until you start the broadcast."}
              </p>
              <div className="preview">
                <PdfView url={`/api/files/${current.id}`} token={token} page={state.page} onLoaded={(pages) => patch({ pages })} />
                {sharing && <video ref={previewRef} className="self-view" autoPlay muted playsInline />}
              </div>
            </>
          ) : (
            <p className="muted">Choose or upload a presentation to begin.</p>
          )}
        </section>
      </div>
    </div>
  );
}
