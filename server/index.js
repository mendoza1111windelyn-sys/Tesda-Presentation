import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 3001;
const INITIAL_PASSCODE = process.env.PRESENTER_PASSCODE;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, "data"));
const filesDir = path.join(dataDir, "files");
const libraryFile = path.join(dataDir, "library.json");
const credentialFile = path.join(dataDir, "presenter-credential.json");
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const allowedOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const isAllowedOrigin = (origin) =>
  allowedOrigins.has(origin) ||
  (!process.env.CORS_ALLOWED_ORIGINS && /^https?:\/\/localhost(?::\d+)?$/.test(origin));
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseBucket = process.env.SUPABASE_BUCKET || "presentations";
if (!!supabaseUrl !== !!supabaseServiceRoleKey) {
  console.error("Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or leave both unset for local storage.");
  process.exit(1);
}
const supabase = supabaseUrl
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;
fs.mkdirSync(filesDir, { recursive: true });

// ---- library of uploaded presentations (PDF for guests, PowerPoint kept for the presenter) ----
let library = [];
function entryFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    size: Number(row.size),
    uploadedAt: row.uploaded_at,
    ...(row.ppt_name && { pptName: row.ppt_name, pptExt: row.ppt_ext, pptSize: Number(row.ppt_size) }),
  };
}
function rowFromEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    size: entry.size,
    uploaded_at: entry.uploadedAt,
    ppt_name: entry.pptName || null,
    ppt_ext: entry.pptExt || null,
    ppt_size: entry.pptSize || null,
  };
}
async function loadLibrary() {
  if (supabase) {
    const [{ data, error }, { data: credentials, error: credentialError }] = await Promise.all([
      supabase.from("presentations").select("*").order("uploaded_at", { ascending: false }),
      supabase.from("presenter_credentials").select("salt, password_hash").eq("id", 1).maybeSingle(),
    ]);
    if (error) throw new Error(`Could not load the presentation library from Supabase: ${error.message}`);
    if (credentialError) throw new Error(`Could not load presenter credentials from Supabase: ${credentialError.message}`);
    library = data.map(entryFromRow);
    presenterCredential = credentials;
    return;
  }
  if (fs.existsSync(libraryFile)) library = JSON.parse(fs.readFileSync(libraryFile, "utf8"));
  if (fs.existsSync(credentialFile)) presenterCredential = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
}
const saveLibrary = () => fs.writeFileSync(libraryFile, JSON.stringify(library, null, 2));
const pdfPath = (id) => path.join(filesDir, `${id}.pdf`);
const pptPath = (entry) => path.join(filesDir, `${entry.id}${entry.pptExt}`);
const pdfObject = (id) => `${id}.pdf`;
const pptObject = (entry) => `${entry.id}${entry.pptExt}`;

async function storeFile(name, file) {
  if (!supabase) {
    fs.writeFileSync(path.join(filesDir, name), file.buffer, { flag: "wx" });
    return;
  }
  const { error } = await supabase.storage.from(supabaseBucket).upload(name, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  });
  if (error) throw new Error(`Could not upload a presentation file to Supabase: ${error.message}`);
}

async function removeStoredFiles(names) {
  if (!names.length) return;
  if (!supabase) {
    for (const name of names) fs.rmSync(path.join(filesDir, name), { force: true });
    return;
  }
  const { error } = await supabase.storage.from(supabaseBucket).remove(names);
  if (error) throw new Error(`Could not remove presentation files from Supabase: ${error.message}`);
}

// ---- auth ----
const tokens = new Set();
const loginAttempts = new Map();
let presenterCredential = null;
let credentialSetupInProgress = false;
const derivePasscodeHash = promisify(crypto.scrypt);
const MIN_PASSCODE_LENGTH = 12;

async function hashPasscode(passcode) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await derivePasscodeHash(passcode, salt, 64);
  return { salt, password_hash: hash.toString("hex") };
}

async function verifyPasscode(passcode, credential) {
  if (!credential) return false;
  const expected = Buffer.from(credential.password_hash, "hex");
  if (expected.length !== 64) return false;
  const actual = await derivePasscodeHash(passcode, credential.salt, 64);
  return crypto.timingSafeEqual(actual, expected);
}

async function savePresenterCredential(credential, insert) {
  if (supabase) {
    const query = supabase.from("presenter_credentials");
    const result = insert
      ? await query.insert({ id: 1, ...credential })
      : await query.update(credential).eq("id", 1);
    if (result.error) {
      if (insert && result.error.code === "23505") return false;
      throw new Error(`Could not save presenter credentials: ${result.error.message}`);
    }
  } else {
    fs.writeFileSync(credentialFile, JSON.stringify(credential), { flag: insert ? "wx" : "w" });
  }
  presenterCredential = credential;
  return true;
}

function checkPasscodeRateLimit(req, res) {
  const entry = loginAttempts.get(req.ip) || { count: 0, since: Date.now() };
  if (Date.now() - entry.since > 15 * 60_000) Object.assign(entry, { count: 0, since: Date.now() });
  if (entry.count >= 10) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return false;
  }
  loginAttempts.set(req.ip, entry);
  return true;
}

function recordFailedPasscode(req) {
  const entry = loginAttempts.get(req.ip);
  if (entry) entry.count += 1;
}

function createPresenterToken() {
  const token = crypto.randomBytes(24).toString("hex");
  tokens.add(token);
  return token;
}

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

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// ---- presentation state (one room) ----
const freshState = () => ({ started: false, currentId: null, title: "", page: 1, pages: 0 });
const state = freshState();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (!isAllowedOrigin(origin)) return res.status(403).json({ error: "This website is not allowed to use the presentation service." });
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, Content-Disposition");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "10kb" }));

app.get("/api/auth/status", (_req, res) => {
  res.json({ configured: !!presenterCredential });
});

app.post("/api/auth/setup", asyncRoute(async (req, res) => {
  if (presenterCredential) return res.status(409).json({ error: "Presenter passcode is already set. Sign in instead." });
  if (credentialSetupInProgress) return res.status(409).json({ error: "Presenter setup is already in progress. Try again shortly." });
  if (!checkPasscodeRateLimit(req, res)) return;
  const bootstrapPasscode = String(req.body?.bootstrapPasscode ?? "");
  const newPasscode = String(req.body?.newPasscode ?? "");
  if (!INITIAL_PASSCODE || !safeEqual(bootstrapPasscode, INITIAL_PASSCODE)) {
    recordFailedPasscode(req);
    return res.status(401).json({ error: "Wrong one-time setup passcode." });
  }
  if (newPasscode.length < MIN_PASSCODE_LENGTH) {
    return res.status(400).json({ error: `Choose a passcode with at least ${MIN_PASSCODE_LENGTH} characters.` });
  }
  credentialSetupInProgress = true;
  try {
    const credential = await hashPasscode(newPasscode);
    if (!(await savePresenterCredential(credential, true))) {
      return res.status(409).json({ error: "Presenter passcode was already set. Sign in instead." });
    }
    loginAttempts.delete(req.ip);
    res.status(201).json({ token: createPresenterToken() });
  } finally {
    credentialSetupInProgress = false;
  }
}));

app.post("/api/login", asyncRoute(async (req, res) => {
  if (!presenterCredential) return res.status(409).json({ error: "Set up your presenter passcode first." });
  if (!checkPasscodeRateLimit(req, res)) return;
  if (!(await verifyPasscode(String(req.body?.passcode ?? ""), presenterCredential))) {
    recordFailedPasscode(req);
    return res.status(401).json({ error: "Wrong passcode." });
  }
  loginAttempts.delete(req.ip);
  res.json({ token: createPresenterToken() });
}));

app.post("/api/auth/change-passcode", requirePresenter, asyncRoute(async (req, res) => {
  const currentPasscode = String(req.body?.currentPasscode ?? "");
  const newPasscode = String(req.body?.newPasscode ?? "");
  if (!(await verifyPasscode(currentPasscode, presenterCredential))) {
    return res.status(401).json({ error: "Current passcode is incorrect." });
  }
  if (newPasscode.length < MIN_PASSCODE_LENGTH) {
    return res.status(400).json({ error: `Choose a passcode with at least ${MIN_PASSCODE_LENGTH} characters.` });
  }
  const credential = await hashPasscode(newPasscode);
  await savePresenterCredential(credential, false);
  tokens.clear();
  res.json({ token: createPresenterToken() });
}));

app.get("/api/library", requirePresenter, (_req, res) => res.json(library));

const PPT_EXTENSIONS = [".pptx", ".ppt", ".ppsx", ".pps"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 2, fields: 1, fieldSize: 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = file.fieldname === "pdf" ? ext === ".pdf" : file.fieldname === "ppt" && PPT_EXTENSIONS.includes(ext);
    if (ok) return cb(null, true);
    const error = new Error(file.fieldname === "pdf" ? "The slides must be a PDF file." : "The PowerPoint must be .pptx, .ppt, .ppsx or .pps.");
    error.status = 400;
    cb(error);
  },
});

const startsWith = (buffer, bytes) => buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));
const uploadFields = upload.fields([{ name: "pdf", maxCount: 1 }, { name: "ppt", maxCount: 1 }]);

app.post(
  "/api/library",
  requirePresenter,
  uploadFields,
  asyncRoute(async (req, res) => {
    const pdf = req.files?.pdf?.[0];
    const ppt = req.files?.ppt?.[0];
    if (!pdf) return res.status(400).json({ error: "Choose the PDF version of the presentation." });
    if (!startsWith(pdf.buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
      return res.status(400).json({ error: "That file is not a valid PDF." });
    }
    if (ppt && !(startsWith(ppt.buffer, [0x50, 0x4b]) || startsWith(ppt.buffer, [0xd0, 0xcf, 0x11, 0xe0]))) {
      return res.status(400).json({ error: "That file is not a valid PowerPoint presentation." });
    }

    const id = crypto.randomUUID();
    const title = String(req.body?.title || "").trim() || path.basename(pdf.originalname, path.extname(pdf.originalname));
    const entry = {
      id,
      title: title.slice(0, 150),
      size: pdf.size,
      uploadedAt: new Date().toISOString(),
      ...(ppt && {
        pptName: path.basename(ppt.originalname).slice(0, 200),
        pptExt: path.extname(ppt.originalname).toLowerCase(),
        pptSize: ppt.size,
      }),
    };
    const storedNames = [];
    try {
      await storeFile(pdfObject(id), pdf);
      storedNames.push(pdfObject(id));
      if (ppt) {
        await storeFile(pptObject(entry), ppt);
        storedNames.push(pptObject(entry));
      }
      if (supabase) {
        const { error } = await supabase.from("presentations").insert(rowFromEntry(entry));
        if (error) throw new Error(`Could not save presentation details to Supabase: ${error.message}`);
        library.unshift(entry);
      } else {
        library.unshift(entry);
        saveLibrary();
      }
      res.status(201).json(entry);
    } catch (error) {
      if (!supabase) library = library.filter((item) => item.id !== id);
      try {
        await removeStoredFiles(storedNames);
      } catch (cleanupError) {
        console.error("Could not clean up an incomplete presentation upload:", cleanupError);
      }
      throw error;
    }
  }),
);

app.delete("/api/library/:id", requirePresenter, asyncRoute(async (req, res) => {
  const index = library.findIndex((entry) => entry.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Presentation not found." });
  const removed = library[index];
  if (supabase) {
    const { error } = await supabase.from("presentations").delete().eq("id", removed.id);
    if (error) throw new Error(`Could not delete presentation details from Supabase: ${error.message}`);
    library.splice(index, 1);
    if (state.currentId === removed.id) {
      Object.assign(state, freshState());
      broadcastState();
    }
    await removeStoredFiles([pdfObject(removed.id), ...(removed.pptExt ? [pptObject(removed)] : [])]);
  } else {
    await removeStoredFiles([pdfObject(removed.id), ...(removed.pptExt ? [pptObject(removed)] : [])]);
    library.splice(index, 1);
    saveLibrary();
    if (state.currentId === removed.id) {
      Object.assign(state, freshState());
      broadcastState();
    }
  }
  res.json({ ok: true });
}));

function attachmentName(title, ext) {
  const safe = title.replace(/[^\w\-. ]+/g, "_").trim() || "presentation";
  return `${safe}${ext}`;
}

// Guests can read/download only the PDF being presented, and only while the presentation is on.
async function sendStoredFile(req, res, name, localPath, downloadName, forceDownload = false) {
  res.setHeader("Cache-Control", "private, no-store");
  if ((forceDownload || req.query.download) && downloadName) res.attachment(downloadName);
  if (!supabase) return res.sendFile(localPath);

  const { data: signedFile, error: signingError } = await supabase.storage
    .from(supabaseBucket)
    .createSignedUrl(name, 60);
  if (signingError) throw new Error(`Could not create a private presentation link: ${signingError.message}`);
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetch(signedFile.signedUrl, { headers });
  if (!upstream.ok) {
    const detail = await upstream.text();
    console.error(`Supabase file request failed (${upstream.status}): ${detail}`);
    return res.status(502).json({ error: "Could not retrieve the presentation file." });
  }
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  res.status(upstream.status);
  if (!upstream.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (!res.destroyed) console.error("Could not stream a presentation file:", error);
  }
}

app.get("/api/files/:id", asyncRoute(async (req, res) => {
  const id = req.params.id;
  const allowed = tokens.has(bearer(req)) || (state.started && state.currentId === id);
  if (!allowed) return res.status(403).json({ error: "Not available." });
  const entry = library.find((item) => item.id === id);
  if (!entry) return res.status(404).json({ error: "Not found." });
  await sendStoredFile(req, res, pdfObject(id), pdfPath(id), attachmentName(entry.title, ".pdf"));
}));

// The PowerPoint original is for the presenter only.
app.get("/api/files/:id/ppt", requirePresenter, asyncRoute(async (req, res) => {
  const entry = library.find((item) => item.id === req.params.id);
  if (!entry?.pptExt) return res.status(404).json({ error: "No PowerPoint was uploaded for this presentation." });
  res.setHeader("Cache-Control", "private, no-store");
  if (!supabase) return res.download(pptPath(entry), attachmentName(entry.title, entry.pptExt));
  await sendStoredFile(
    req,
    res,
    pptObject(entry),
    pptPath(entry),
    attachmentName(entry.title, entry.pptExt),
    true,
  );
}));

app.use((error, _req, res, next) => {
  console.error("Request failed:", error);
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Each file must be 50 MiB or smaller."
      : error.message;
    return res.status(status).json({ error: message });
  }
  if (error.status === 400) return res.status(400).json({ error: error.message });
  res.status(500).json({ error: "The request could not be completed." });
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
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) return socket.destroy();
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

loadLibrary()
  .then(() => {
    server.listen(PORT, () => console.log(`Presentation server running on http://localhost:${PORT}`));
  })
  .catch((error) => {
    console.error("Could not initialize the presentation library:", error);
    process.exit(1);
  });
