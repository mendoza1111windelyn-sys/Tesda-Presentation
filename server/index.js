import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 3001;
const PASSCODE = process.env.PRESENTER_PASSCODE;
if (!PASSCODE) {
  console.error("Set the PRESENTER_PASSCODE environment variable (see .env.example).");
  process.exit(1);
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, "data"));
const filesDir = path.join(dataDir, "files");
const libraryFile = path.join(dataDir, "library.json");
fs.mkdirSync(filesDir, { recursive: true });

// ---- library of uploaded PDFs ----
let library = [];
try {
  library = JSON.parse(fs.readFileSync(libraryFile, "utf8"));
} catch {
  library = [];
}
const saveLibrary = () => fs.writeFileSync(libraryFile, JSON.stringify(library, null, 2));

// ---- auth ----
const tokens = new Set();
const loginAttempts = new Map();

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function bearer(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

function requirePresenter(req, res, next) {
  if (!tokens.has(bearer(req))) return res.status(401).json({ error: "Presenter sign-in required." });
  next();
}

// ---- live presentation state (one room) ----
const state = { started: false, currentId: null, title: "", page: 1, pages: 0, live: false };

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

app.post("/api/login", (req, res) => {
  const ip = req.ip;
  const entry = loginAttempts.get(ip) || { count: 0, since: Date.now() };
  if (Date.now() - entry.since > 15 * 60_000) Object.assign(entry, { count: 0, since: Date.now() });
  if (entry.count >= 10) return res.status(429).json({ error: "Too many attempts. Try again later." });
  if (!safeEqual(req.body?.passcode ?? "", PASSCODE)) {
    entry.count += 1;
    loginAttempts.set(ip, entry);
    return res.status(401).json({ error: "Wrong passcode." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  tokens.add(token);
  res.json({ token });
});

app.get("/api/library", requirePresenter, (_req, res) => res.json(library));

const upload = multer({
  storage: multer.diskStorage({
    destination: filesDir,
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.pdf`),
  }),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    cb(isPdf ? null : new Error("Only PDF files can be uploaded."), isPdf);
  },
});

app.post("/api/library", requirePresenter, (req, res) => {
  upload.single("file")(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.message });
    if (!req.file) return res.status(400).json({ error: "Choose a PDF file." });
    const header = Buffer.alloc(5);
    const fd = fs.openSync(req.file.path, "r");
    fs.readSync(fd, header, 0, 5, 0);
    fs.closeSync(fd);
    if (header.toString("latin1") !== "%PDF-") {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ error: "That file is not a valid PDF." });
    }
    const id = path.basename(req.file.filename, ".pdf");
    const title = String(req.body?.title || "").trim() || path.basename(req.file.originalname, path.extname(req.file.originalname));
    const entry = { id, title: title.slice(0, 150), size: req.file.size, uploadedAt: new Date().toISOString() };
    library.unshift(entry);
    saveLibrary();
    res.status(201).json(entry);
  });
});

app.delete("/api/library/:id", requirePresenter, (req, res) => {
  const index = library.findIndex((entry) => entry.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Presentation not found." });
  const [removed] = library.splice(index, 1);
  fs.rmSync(path.join(filesDir, `${removed.id}.pdf`), { force: true });
  saveLibrary();
  if (state.currentId === removed.id) {
    Object.assign(state, { started: false, currentId: null, title: "", page: 1, pages: 0, live: false });
    broadcastState();
  }
  res.json({ ok: true });
});

// Presenter can read any file; guests only the one being presented once it has started.
app.get("/api/files/:id", (req, res) => {
  const id = req.params.id;
  const allowed = tokens.has(bearer(req)) || (state.started && state.currentId === id);
  if (!allowed) return res.status(403).json({ error: "Not available." });
  if (!library.some((entry) => entry.id === id)) return res.status(404).json({ error: "Not found." });
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(path.join(filesDir, `${id}.pdf`));
});

const clientDist = path.join(rootDir, "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

// ---- websocket: state sync + WebRTC signalling ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
let presenter = null;
const guests = new Map();

const send = (socket, message) => {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
};
const publicState = () => ({ ...state });
function broadcastState() {
  for (const guest of guests.values()) send(guest, { type: "state", state: publicState() });
  send(presenter, { type: "state", state: publicState() });
}
const sendCounts = () => send(presenter, { type: "guests", count: guests.size });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws") return socket.destroy();
  const wantsPresenter = url.searchParams.get("role") === "presenter";
  if (wantsPresenter && !tokens.has(url.searchParams.get("token") || "")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, wantsPresenter));
});

wss.on("connection", (ws, isPresenter) => {
  const id = crypto.randomBytes(6).toString("hex");
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  if (isPresenter) {
    if (presenter && presenter !== ws) presenter.close(4000, "Replaced by a new presenter session");
    presenter = ws;
    send(ws, { type: "state", state: publicState() });
    sendCounts();
  } else {
    guests.set(id, ws);
    send(ws, { type: "state", state: publicState() });
    sendCounts();
  }

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (isPresenter) {
      if (message.type === "state" && message.patch && typeof message.patch === "object") {
        const patch = message.patch;
        if (typeof patch.started === "boolean") state.started = patch.started;
        if (typeof patch.live === "boolean") state.live = patch.live;
        if (Number.isInteger(patch.page) && patch.page >= 1) state.page = patch.page;
        if (Number.isInteger(patch.pages) && patch.pages >= 0) state.pages = patch.pages;
        if ("currentId" in patch) {
          const entry = library.find((item) => item.id === patch.currentId);
          state.currentId = entry ? entry.id : null;
          state.title = entry ? entry.title : "";
        }
        broadcastState();
      } else if (message.type === "signal" && guests.has(message.to)) {
        send(guests.get(message.to), { type: "signal", data: message.data });
      }
    } else if (message.type === "request-stream") {
      send(presenter, { type: "request-stream", from: id });
    } else if (message.type === "signal") {
      send(presenter, { type: "signal", from: id, data: message.data });
    }
  });

  ws.on("close", () => {
    if (isPresenter) {
      if (presenter === ws) presenter = null;
      // Without a presenter, a live video stream can no longer exist.
      if (state.live) {
        state.live = false;
        broadcastState();
      }
    } else {
      guests.delete(id);
      sendCounts();
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.listen(PORT, () => console.log(`Presentation server running on http://localhost:${PORT}`));
