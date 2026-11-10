import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Logo, Tagline } from "./Brand";
import { Guest } from "./Guest";
import { Presenter } from "./Presenter";
import { appRole } from "./config";
import "./style.css";

const path = window.location.pathname.replace(/\/+$/, "");

function Landing() {
  return (
    <main className="splash">
      <Logo className="splash-logo" />
      <Tagline className="splash-tagline" />
      <p className="splash-message">Join the presentation</p>
      <div className="row">
        <a className="button" href="/watch">Watch the presentation</a>
        <a className="button quiet" href="/present">Presenter sign-in</a>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {appRole
      ? appRole === "presenter" ? <Presenter /> : <Guest />
      : path === "/present" ? <Presenter /> : path === "/watch" ? <Guest /> : <Landing />}
  </StrictMode>,
);
