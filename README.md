# TESDA Presentation

Present a PDF deck to guests who watch on their own devices. Guests can't control anything.

- **Presenter** opens `/present`, signs in with the passcode, uploads PDFs (export your PowerPoint as PDF), picks one and presses **Start broadcast**. Slides change with the ← → keys or the buttons, and guests follow along instantly.
- **Guests** open `/watch` and wait on a waiting screen until the broadcast starts. They see the presenter's slide; they can tick *Browse on my own* to read ahead.
- **Animations:** PDFs can't hold animations, so the presenter can press **Share screen (live)** and share the PowerPoint window. Guests then get a **Live** tab (video) next to **Slides (PDF)**.

## Run locally

```
npm install
npm run build          # installs and builds the client
copy .env.example .env # then set PRESENTER_PASSCODE
npm start              # http://localhost:3001
```

For development run `npm run dev:server` and `npm run dev:client` in two terminals (client on http://localhost:5173).

## Deploy (Render / Railway)

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Environment: `PRESENTER_PASSCODE` (required), optional `DATA_DIR` pointing at a persistent disk. Without a persistent disk, uploaded PDFs are lost when the service restarts.
- HTTPS is required for screen sharing (Render/Railway provide it).

## Notes

- Live video uses WebRTC straight from the presenter's browser to each guest, so it suits small to medium groups (roughly 20 guests or fewer). Guests on strict corporate networks may need a TURN server; add one to `iceServers` in `client/src/socket.ts`.
- Screen sharing works from a desktop browser; phones generally can't share their screen.
- Guests can only download the PDF that is currently being presented, and only after the broadcast starts.
