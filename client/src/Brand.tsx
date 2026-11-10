export function Logo({ className = "" }: { className?: string }) {
  return <img className={`logo ${className}`} src="/tesda-logo.png" alt="TESDA" />;
}

export function Tagline({ className = "" }: { className?: string }) {
  return <img className={`tagline ${className}`} src="/kayang-kaya.png" alt="Sa TESDA, Kayang Kaya" />;
}

// Shown to guests whenever the presenter has not started a presentation (e.g. while choosing one).
export function Splash({ status }: { status?: string }) {
  return (
    <main className="splash">
      <Logo className="splash-logo" />
      <Tagline className="splash-tagline" />
      <p className="splash-message">
        Getting ready to present<span className="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
      </p>
      {status && <p className="splash-status">{status}</p>}
    </main>
  );
}
