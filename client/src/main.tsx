import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Guest } from "./Guest";
import { Presenter } from "./Presenter";
import "./style.css";

const path = window.location.pathname.replace(/\/+$/, "");

function Landing() {
  return (
    <main className="center-screen">
      <h1>TESDA Presentation</h1>
      <p>Guests: use the link the presenter gave you.</p>
      <a className="button" href="/present">Presenter sign-in</a>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{path === "/present" ? <Presenter /> : path === "/watch" ? <Guest /> : <Landing />}</StrictMode>,
);
