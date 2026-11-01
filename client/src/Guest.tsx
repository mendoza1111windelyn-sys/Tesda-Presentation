import { useEffect, useRef, useState } from "react";
import { emptyState, PdfView, type SharedState } from "./PdfView";
import { rtcConfig, useSocket } from "./socket";

type View = "live" | "slides";

export function Guest() {
  const [state, setState] = useState<SharedState>(emptyState);
  const [view, setView] = useState<View>("slides");
  const [freeBrowse, setFreeBrowse] = useState(false);
  const [ownPage, setOwnPage] = useState(1);
  const [hasVideo, setHasVideo] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const prevLive = useRef(false);

  const { connected, send } = useSocket("role=guest", {
    onMessage: async (incoming) => {
      if (incoming.type === "state") setState(incoming.state);
      else if (incoming.type === "signal") await handleSignal(incoming.data);
    },
  });

  function closePeer() {
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current = null;
    setHasVideo(false);
  }

  async function handleSignal(data: any) {
    if (data.description) {
      closePeer();
      const peer = new RTCPeerConnection(rtcConfig);
      peerRef.current = peer;
      peer.onicecandidate = (event) => {
        if (event.candidate) send({ type: "signal", data: { candidate: event.candidate } });
      };
      peer.ontrack = (event) => {
        streamRef.current = event.streams[0];
        setHasVideo(true);
      };
      await peer.setRemoteDescription(data.description);
      await peer.setLocalDescription(await peer.createAnswer());
      send({ type: "signal", data: { description: peer.localDescription } });
    } else if (data.candidate) {
      await peerRef.current?.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  // Ask for the live stream whenever the presenter goes live (or we reconnect while live).
  useEffect(() => {
    if (connected && state.started && state.live) {
      send({ type: "request-stream" });
      if (!prevLive.current) setView("live");
    } else {
      closePeer();
      if (prevLive.current && !state.live) setView("slides");
    }
    prevLive.current = state.live;
  }, [connected, state.started, state.live]);

  useEffect(() => {
    if (hasVideo && videoRef.current && streamRef.current) videoRef.current.srcObject = streamRef.current;
  }, [hasVideo, view]);

  useEffect(() => () => closePeer(), []);

  // Leaving "browse freely" snaps back to the presenter's slide.
  useEffect(() => {
    if (!freeBrowse) setOwnPage(state.page);
  }, [state.page, freeBrowse]);

  if (!state.started || !state.currentId) {
    return (
      <main className="center-screen">
        <div className="card">
          <h1>Waiting for the presentation to start…</h1>
          <p className="muted">{connected ? "You're connected. This page will update by itself." : "Connecting…"}</p>
        </div>
      </main>
    );
  }

  const page = freeBrowse ? ownPage : state.page;
  const showLive = state.live && view === "live";

  return (
    <div className="guest">
      <header className="topbar">
        <strong>{state.title}</strong>
        <span className="spacer" />
        {state.live && (
          <div className="tabs">
            <button className={view === "live" ? "active" : ""} onClick={() => setView("live")}>Live</button>
            <button className={view === "slides" ? "active" : ""} onClick={() => setView("slides")}>Slides (PDF)</button>
          </div>
        )}
        {!connected && <span className="pill">Reconnecting…</span>}
      </header>

      <div className="guest-stage">
        {showLive ? (
          hasVideo ? (
            <video ref={videoRef} className="live-video" autoPlay playsInline controls />
          ) : (
            <p className="muted">Connecting to the live presentation…</p>
          )
        ) : (
          <PdfView url={`/api/files/${state.currentId}`} page={page} />
        )}
      </div>

      {!showLive && (
        <footer className="guest-controls">
          {freeBrowse && (
            <>
              <button className="button" onClick={() => setOwnPage((value) => Math.max(1, value - 1))} disabled={ownPage <= 1}>◀</button>
              <span>{ownPage} / {state.pages}</span>
              <button className="button" onClick={() => setOwnPage((value) => Math.min(state.pages, value + 1))} disabled={ownPage >= state.pages}>▶</button>
            </>
          )}
          {!freeBrowse && <span>Slide {state.page} / {state.pages}</span>}
          <label className="check">
            <input
              type="checkbox"
              checked={freeBrowse}
              onChange={(event) => {
                setOwnPage(state.page);
                setFreeBrowse(event.target.checked);
              }}
            />
            Browse on my own
          </label>
        </footer>
      )}
    </div>
  );
}
