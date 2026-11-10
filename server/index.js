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

// ---- library of uploaded presentations (PDF for guests, PowerPoint kept for the presenter) ----
let library = [];
try {
  library = JSON.parse(fs.readFileSync(libraryFile, "utf8"));
} catch {
  library = [];
}
const saveLibrary = () => fs.writeFileSync(libraryFile, JSON.stringify(library, null, 2));
const pdfPath = (id) => path.join(filesDir, `${id}.pdf`);
const pptPath = (entry) => path.join(filesDir, `${entry.id}${entry.pptExt}`);

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

// ---- presentation state (one room) ----
const freshState = () => ({ started: false, currentId: null, title: "", page: 1, pages: 0 });
const state = freshState();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
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

const PPT_EXTENSIONS = [".pptx", ".ppt", ".ppsx", ".pps"];

const upload = multer({
  storage: multer.diskStorage({
    destination: filesDir,
    filename: (req, file, cb) => {
      if (file.fieldname === "pdf") return cb(null, `${req.uploadId}.pdf`);
      cb(null, `${req.uploadId}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = file.fieldname === "pdf" ? ext === ".pdf" : file.fieldname === "ppt" && PPT_EXTENSIONS.includes(ext);
    cb(ok ? null : new Error(file.fieldname === "pdf" ? "The slides must be a PDF file." : "The PowerPoint must be .pptx, .ppt, .ppsx or .pps."), ok);
  },
});

function startsWith(file, bytes) {
  const header = Buffer.alloc(bytes.length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, header, 0, bytes.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return header.equals(Buffer.from(bytes));
}

app.post(
  "/api/library",
  requirePresenter,
  (req, _res, next) => {
    req.uploadId = crypto.randomUUID();
    next();
  },
  (req, res) => {
    upload.fields([{ name: "pdf", maxCount: 1 }, { name: "ppt", maxCount: 1 }])(req, res, (error) => {
      const pdf = req.files?.pdf?.[0];
      const ppt = req.files?.ppt?.[0];
      const discard = () => [pdf, ppt].forEach((file) => file && fs.rmSync(file.path, { force: true }));
      if (error) {
        discard();
        return res.status(400).json({ error: error.message });
      }
      if (!pdf) {
        discard();
        return res.status(400).json({ error: "Choose the PDF version of the presentation." });
      }
      if (!startsWith(pdf.path, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
        discard();
        return res.status(400).json({ error: "That file is not a valid PDF." });
      }
      if (ppt && !(startsWith(ppt.path, [0x50, 0x4b]) || startsWith(ppt.path, [0xd0, 0xcf, 0x11, 0xe0]))) {
        discard();
        return res.status(400).json({ error: "That file is not a valid PowerPoint presentation." });
      }
      const title =
        String(req.body?.title || "").trim() || path.basename(pdf.originalname, path.extname(pdf.originalname));
      const entry = {
        id: req.uploadId,
        title: title.slice(0, 150),
        size: pdf.size,
        uploadedAt: new Date().toISOString(),
        ...(ppt && { pptName: path.basename(ppt.originalname).slice(0, 200), pptExt: path.extname(ppt.originalname).toLowerCase(), pptSize: ppt.size }),
      };
      library.unshift(entry);
      saveLibrary();
      res.status(201).json(entry);
    });
  },
);

app.delete("/api/library/:id", requirePresenter, (req, res) => {
  const index = library.findIndex((entry) => entry.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Presentation not found." });
  const [removed] = library.splice(index, 1);
  fs.rmSync(pdfPath(removed.id), { force: true });
  if (removed.pptExt) fs.rmSync(pptPath(removed), { force: true });
  saveLibrary();
  if (state.currentId === removed.id) {
    Object.assign(state, freshState());
    broadcastState();
  }
  res.json({ ok: true });
});

function attachmentName(title, ext) {
  const safe = title.replace(/[^\w\-. ]+/g, "_").trim() || "presentation";
  return `${safe}${ext}`;
}

// Guests can read/download only the PDF being presented, and only while the presentation is on.
app.get("/api/files/:id", (req, res) => {
  const id = req.params.id;
  const allowed = tokens.has(bearer(req)) || (state.started && state.currentId === id);
  if (!allowed) return res.status(403).json({ error: "Not available." });
  const entry = library.find((item) => item.id === id);
  if (!entry) return res.status(404).json({ error: "Not found." });
  res.setHeader("Cache-Control", "private, no-store");
  if (req.query.download) res.attachment(attachmentName(entry.title, ".pdf"));
  res.sendFile(pdfPath(id));
});

// The PowerPoint original is for the presenter only.
app.get("/api/files/:id/ppt", requirePresenter, (req, res) => {
  const entry = library.find((item) => item.id === req.params.id);
  if (!entry?.pptExt) return res.status(404).json({ error: "No PowerPoint was uploaded for this presentation." });
  res.setHeader("Cache-Control", "private, no-store");
  res.download(pptPath(entry), attachmentName(entry.title, entry.pptExt));
});

const clientDist = path.join(rootDir, "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

// ---- websocket: state sync ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
let presenter = null;
const guests = new Set();

const send = (socket, message) => {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
};
// Guests learn nothing about the chosen presentation until the broadcast has started.
const guestState = () => (state.started && state.currentId ? { ...state } : freshState());
function broadcastState() {
  const forGuests = JSON.stringify({ type: "state", state: guestState() });
  for (const guest of guests) if (guest.readyState === 1) guest.send(forGuests);
  send(presenter, { type: "state", state });
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
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  if (isPresenter) {
    if (presenter && presenter !== ws) presenter.close(4000, "Replaced by a new presenter session");
    presenter = ws;
    send(ws, { type: "state", state });
  } else {
    guests.add(ws);
    send(ws, { type: "state", state: guestState() });
  }
  sendCounts();

  ws.on("message", (raw) => {
    if (!isPresenter) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === "state" && message.patch && typeof message.patch === "object") {
      const patch = message.patch;
      if ("currentId" in patch) {
        const entry = library.find((item) => item.id === patch.currentId);
        state.currentId = entry ? entry.id : null;
        state.title = entry ? entry.title : "";
        state.page = 1;
        state.pages = 0;
        state.started = false;
      }
      if (Number.isInteger(patch.pages) && patch.pages >= 0) state.pages = patch.pages;
      if (Number.isInteger(patch.page) && patch.page >= 1) state.page = state.pages ? Math.min(patch.page, state.pages) : patch.page;
      if (typeof patch.started === "boolean") state.started = patch.started && !!state.currentId;
      broadcastState();
    }
  });

  ws.on("close", () => {
    if (isPresenter) {
      if (presenter === ws) presenter = null;
    } else {
      guests.delete(ws);
    }
    sendCounts();
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
