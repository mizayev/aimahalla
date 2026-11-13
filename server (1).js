// Mahalla — virtual neighbourhood map. Zero-dependency Node.js server.
// Run: node server.js   (Node 18+)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const COOLDOWN_MS = Math.max(0, +(process.env.BUILD_COOLDOWN_MIN ?? 60)) * 60000;
const MAX_FLOORS = Math.max(5, +process.env.MAX_FLOORS || 100);
const STEP = 5;
const SESSION_DAYS = 180;
// index.html can live in ./public/ or right next to server.js
const HAS_PUBLIC = fs.existsSync(path.join(__dirname, "public", "index.html"));
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOT_INDEX = path.join(__dirname, "index.html");

/* ---------------- storage ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "db.json");
let db = { config: { title: "", tagline: "" }, nextSlot: 0, users: [], sessions: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); }
catch (e) { if (e.code !== "ENOENT") { console.error("db.json o'qilmadi:", e.message); process.exit(1); } }
const byKey = new Map(db.users.map(u => [u.key, u]));
const byId = new Map(db.users.map(u => [u.id, u]));

let saveTimer = null;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 400); }
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { flush(); } catch (e) {} process.exit(0); });

/* ---------------- helpers ---------------- */
const NAME_RE = /^[\p{L}\p{N}_.\-]{2,24}$/u;
const PIN_RE = /^\d{4,8}$/;
const keyOf = n => String(n).trim().replace(/^@/, "").toLowerCase();
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const pub = u => ({ id: u.id, name: u.name, floors: u.floors, color: u.color, slot: u.slot, joined: u.joined });
function hashPin(pin, salt) { return crypto.scryptSync(pin, salt, 32).toString("hex"); }
function checkPin(pin, u) {
  const a = Buffer.from(hashPin(pin, u.salt), "hex"), b = Buffer.from(u.pinHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newSession(data) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.sessions[sha(token)] = { ...data, exp: Date.now() + SESSION_DAYS * 864e5 };
  save();
  return token;
}
function session(req, header) {
  let tok = req.headers[header] || "";
  if (header === "authorization") tok = tok.replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const s = db.sessions[sha(tok)];
  if (!s || s.exp < Date.now()) return null;
  return s;
}
function pruneSessions() {
  const now = Date.now();
  for (const k in db.sessions) if (db.sessions[k].exp < now || (db.sessions[k].uid && !byId.has(db.sessions[k].uid))) delete db.sessions[k];
  save();
}
setInterval(pruneSessions, 6 * 3600e3).unref();

const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60e3).unref();
const ipOf = req => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
const fail = (res, code, error, extra) => send(res, code, { error, ...extra });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", c => { size += c.length; if (size > 16 * 1024) { reject(new Error("too_big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(new Error("bad_json")); } });
    req.on("error", reject);
  });
}

/* ---------------- live updates (SSE) ---------------- */
const clients = new Set();
function broadcast(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of clients) c.write(line);
}
let onlineTimer = null;
function announceOnline() {
  if (onlineTimer) return;
  onlineTimer = setTimeout(() => { onlineTimer = null; broadcast({ type: "online", n: clients.size }); }, 1500);
}
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 25e3).unref();

const meInfo = u => ({ me: pub(u), nextBuildAt: (u.lastBuild || 0) + COOLDOWN_MS, step: STEP, maxFloors: MAX_FLOORS });

/* ---------------- routes ---------------- */
async function api(req, res, route) {
  const ip = ipOf(req);
  if (req.method === "GET" && route === "state") {
    return send(res, 200, { config: db.config, residents: db.users.map(pub), online: clients.size, step: STEP, maxFloors: MAX_FLOORS, cooldownMin: COOLDOWN_MS / 60000 });
  }
  if (req.method === "GET" && route === "events") {
    if (clients.size >= 5000) return fail(res, 503, "busy");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 4000\n\n");
    clients.add(res); announceOnline();
    req.on("close", () => { clients.delete(res); announceOnline(); });
    return;
  }
  if (req.method === "GET" && route === "me") {
    const s = session(req, "authorization"); const u = s && byId.get(s.uid);
    return u ? send(res, 200, meInfo(u)) : fail(res, 401, "auth");
  }
  if (req.method !== "POST") return fail(res, 404, "not_found");

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "bad_request"); }

  switch (route) {
    case "join": {
      if (limited("join:" + ip, 5, 3600e3)) return fail(res, 429, "rate");
      const name = String(body.name || "").trim().replace(/^@/, "");
      const pin = String(body.pin || "");
      if (!NAME_RE.test(name)) return fail(res, 400, "name_invalid");
      if (!PIN_RE.test(pin)) return fail(res, 400, "pin_invalid");
      const key = keyOf(name);
      if (byKey.has(key)) return fail(res, 409, "name_taken");
      const salt = crypto.randomBytes(16).toString("hex");
      const color = Number.isInteger(body.color) && body.color >= 0 && body.color < 8 ? body.color : crypto.randomInt(8);
      const u = { id: crypto.randomBytes(8).toString("hex"), name, key, salt, pinHash: hashPin(pin, salt), floors: 1, color, slot: db.nextSlot++, joined: Date.now(), lastBuild: 0 };
      db.users.push(u); byKey.set(key, u); byId.set(u.id, u); save();
      broadcast({ type: "upsert", r: pub(u), isNew: true });
      return send(res, 200, { token: newSession({ uid: u.id }), ...meInfo(u) });
    }
    case "login": {
      const key = keyOf(body.name || "");
      if (limited("login:" + ip, 20, 600e3) || limited("loginname:" + key, 8, 600e3)) return fail(res, 429, "rate");
      const u = byKey.get(key);
      if (!u || !checkPin(String(body.pin || ""), u)) return fail(res, 401, "bad_login");
      return send(res, 200, { token: newSession({ uid: u.id }), ...meInfo(u) });
    }
    case "logout": {
      const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (tok) { delete db.sessions[sha(tok)]; save(); }
      return send(res, 200, { ok: true });
    }
    case "build": {
      const s = session(req, "authorization"); const u = s && byId.get(s.uid);
      if (!u) return fail(res, 401, "auth");
      const now = Date.now();
      if (u.floors >= MAX_FLOORS) return fail(res, 400, "max", meInfo(u));
      if (now < (u.lastBuild || 0) + COOLDOWN_MS) return fail(res, 429, "cooldown", meInfo(u));
      u.floors = u.floors <= 1 ? STEP : Math.min(MAX_FLOORS, u.floors + STEP);
      u.lastBuild = now; save();
      broadcast({ type: "upsert", r: pub(u) });
      return send(res, 200, meInfo(u));
    }
    case "color": {
      const s = session(req, "authorization"); const u = s && byId.get(s.uid);
      if (!u) return fail(res, 401, "auth");
      if (!(Number.isInteger(body.color) && body.color >= 0 && body.color < 8)) return fail(res, 400, "bad_request");
      u.color = body.color; save();
      broadcast({ type: "upsert", r: pub(u) });
      return send(res, 200, meInfo(u));
    }
    case "admin/login": {
      if (limited("admin:" + ip, 6, 900e3)) return fail(res, 429, "rate");
      const p = String(body.password || "");
      const ok = ADMIN_PASSWORD.length >= 6 && p.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(ADMIN_PASSWORD));
      if (!ok) return fail(res, 401, "bad_login");
      return send(res, 200, { adminToken: newSession({ admin: true }) });
    }
  }

  if (route.startsWith("admin/")) {
    const s = session(req, "x-admin-token");
    if (!s || !s.admin) return fail(res, 401, "auth");
    switch (route) {
      case "admin/check": return send(res, 200, { ok: true });
      case "admin/config": {
        db.config = { title: String(body.title || "").trim().slice(0, 40), tagline: String(body.tagline || "").trim().slice(0, 60) };
        save(); broadcast({ type: "config", config: db.config });
        return send(res, 200, { ok: true });
      }
      case "admin/floors": {
        const u = byId.get(String(body.id || "")); if (!u) return fail(res, 404, "not_found");
        u.floors = Math.max(1, Math.min(MAX_FLOORS, Math.round(+body.floors || 1))); save();
        broadcast({ type: "upsert", r: pub(u) });
        return send(res, 200, { ok: true });
      }
      case "admin/remove": {
        const u = byId.get(String(body.id || "")); if (!u) return fail(res, 404, "not_found");
        db.users = db.users.filter(x => x !== u); byId.delete(u.id); byKey.delete(u.key);
        for (const k in db.sessions) if (db.sessions[k].uid === u.id) delete db.sessions[k];
        save(); broadcast({ type: "remove", id: u.id });
        return send(res, 200, { ok: true });
      }
    }
  }
  return fail(res, 404, "not_found");
}

/* ---------------- static ---------------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };
function serveStatic(req, res, pathname) {
  if (!HAS_PUBLIC) {
    // only ever serve index.html from the project root, never other files
    return fs.readFile(ROOT_INDEX, (e, buf) => {
      if (e) { res.writeHead(404); return res.end("index.html topilmadi"); }
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  }
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) file = path.join(PUBLIC_DIR, "index.html");
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end("Not found"); }
      const ext = path.extname(file);
      res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600" });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  let url;
  try { url = new URL(req.url, "http://x"); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith("/api/")) {
    try { await api(req, res, url.pathname.slice(5).replace(/\/+$/, "")); }
    catch (e) { console.error(e); if (!res.headersSent) fail(res, 500, "server"); }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url.pathname);
});
server.listen(PORT, () => {
  console.log(`Mahalla ishga tushdi: http://localhost:${PORT}`);
  console.log(`Aholi: ${db.users.length}. Ma'lumotlar: ${DB_FILE}`);
  if (!ADMIN_PASSWORD) console.log("Eslatma: ADMIN_PASSWORD o'rnatilmagan, boshqaruv o'chiq.");
});
