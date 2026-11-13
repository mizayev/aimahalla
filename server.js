// AI Mahalla — virtual neighbourhood map. Zero-dependency Node.js server (Node 18+).
// Run:  ADMIN_PASSWORD=maxfiyParol node server.js
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ---------------- settings ---------------- */
const num = (v, d) => { if (v === undefined || v === "") return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const PORT = num(process.env.PORT, 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();
const COOLDOWN_MS = Math.max(0, num(process.env.BUILD_COOLDOWN_MIN, 60)) * 60000;
const MAX_FLOORS = Math.max(5, Math.round(num(process.env.MAX_FLOORS, 100)));
const TZ_OFFSET_H = num(process.env.TZ_OFFSET_HOURS, 5); // Toshkent vaqti
const BANNED = String(process.env.BANNED_WORDS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const STEP = 5, START_COINS = 20, SKIP_COST = 15, LIKE_REWARD = 2, INVITE_COINS = 50;
const CHAT_KEEP = 300, CHAT_SEND = 120, SESSION_DAYS = 180;
const SHOP = {
  tree: { price: 20 }, car: { price: 30 }, pool: { price: 40 }, flag: { price: 25 },
  solar: { price: 50 }, heli: { price: 80, minFloors: 30 }, neon: { price: 120, minFloors: 50 },
};
const RESERVED = new Set(["admin", "administrator", "moderator", "system", "oqsoqol", "ai_oqsoqol", "aioqsoqol", "ai-oqsoqol", "ai.oqsoqol"]);
const PUBLIC_DIR = path.join(__dirname, "public");
const HAS_PUBLIC = fs.existsSync(path.join(PUBLIC_DIR, "index.html"));
const INDEX_FILE = HAS_PUBLIC ? path.join(PUBLIC_DIR, "index.html") : path.join(__dirname, "index.html");

/* ---------------- storage ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "db.json");
let db = { config: { title: "", tagline: "" }, nextSlot: 0, users: [], sessions: {}, chat: [], chatSeq: 0, secret: "" };
try { Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); }
catch (e) { if (e.code !== "ENOENT") { console.error("db.json o'qilmadi:", e.message); process.exit(1); } }

// Eski versiyalardagi ma'lumotlarni yangi formatga moslash (hech narsa o'chmaydi)
if (!db.config || typeof db.config !== "object") db.config = { title: "", tagline: "" };
if (!db.sessions || typeof db.sessions !== "object") db.sessions = {};
if (!Array.isArray(db.users)) db.users = [];
if (!Array.isArray(db.chat)) db.chat = [];
if (!db.secret) db.secret = crypto.randomBytes(16).toString("hex");
for (const u of db.users) {
  if (!Number.isFinite(u.coins)) u.coins = START_COINS;
  u.likes = u.likes | 0; u.invites = u.invites | 0; u.streak = u.streak | 0;
  if (!Array.isArray(u.liked)) u.liked = [];
  if (!Array.isArray(u.decor)) u.decor = [];
  if (typeof u.status !== "string") u.status = "";
  if (typeof u.lastGiftDay !== "string") u.lastGiftDay = "";
}
db.chatSeq = db.chat.reduce((m, x) => Math.max(m, x.id || 0), db.chatSeq || 0);
db.nextSlot = db.users.reduce((m, u) => Math.max(m, (u.slot | 0) + 1), db.nextSlot || 0);

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
flush();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { flush(); } catch (e) {} process.exit(0); });

/* ---------------- helpers ---------------- */
const NAME_RE = /^[\p{L}\p{N}_.\-]{2,24}$/u;
const PIN_RE = /^\d{4,8}$/;
const keyOf = n => String(n ?? "").trim().replace(/^@/, "").toLowerCase();
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const ipHash = ip => crypto.createHmac("sha256", db.secret).update(String(ip)).digest("hex").slice(0, 20);
const dayStr = ms => new Date(ms + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
const today = () => dayStr(Date.now());
const yesterday = () => dayStr(Date.now() - 864e5);
const activeStreak = u => (u.lastGiftDay === today() || u.lastGiftDay === yesterday()) ? u.streak : 0;
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

const pub = u => ({
  id: u.id, name: u.name, floors: u.floors, color: u.color, slot: u.slot, joined: u.joined,
  likes: u.likes, invites: u.invites, streak: activeStreak(u), decor: u.decor, status: u.status,
});
const meInfo = u => ({
  me: pub(u), coins: u.coins, nextBuildAt: (u.lastBuild || 0) + COOLDOWN_MS, giftReady: u.lastGiftDay !== today(),
  liked: u.liked, mutedUntil: u.mutedUntil || 0, step: STEP, maxFloors: MAX_FLOORS, skipCost: SKIP_COST,
});

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
  let tok = String(req.headers[header] || "");
  if (header === "authorization") tok = tok.replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const s = db.sessions[sha(tok)];
  return s && s.exp > Date.now() ? s : null;
}
const authUser = req => { const s = session(req, "authorization"); return s && s.uid ? byId.get(s.uid) || null : null; };
const isAdminReq = req => { const s = session(req, "x-admin-token"); return !!(s && s.admin); };
function touchIp(u, ip) { const h = ipHash(ip); if (u.ipHash !== h) { u.ipHash = h; save(); } }
function pruneSessions() {
  const now = Date.now();
  for (const k in db.sessions) { const s = db.sessions[k]; if (s.exp < now || (s.uid && !byId.has(s.uid))) delete db.sessions[k]; }
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
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
const fail = (res, code, error, extra) => send(res, code, { error, ...extra });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 16 * 1024) { reject(new Error("too_big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(new Error("bad_json")); } });
    req.on("error", reject);
  });
}
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BANNED_RE = BANNED.length ? new RegExp(BANNED.map(escRe).join("|"), "giu") : null;
// Boshqaruv belgilari, ko'rinmas va matn yo'nalishini buzadigan belgilarni olib tashlaydi
function cleanText(s, max) {
  s = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  if (BANNED_RE) s = s.replace(BANNED_RE, m => "*".repeat([...m].length));
  const cp = [...s];
  return (cp.length > max ? cp.slice(0, max) : cp).join("").trim();
}
const htmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

/* ---------------- chat & game helpers ---------------- */
function pushChat(m) {
  m.id = ++db.chatSeq; m.t = Date.now();
  db.chat.push(m);
  if (db.chat.length > CHAT_KEEP) db.chat.splice(0, db.chat.length - CHAT_KEEP);
  save(); broadcast({ type: "chat", m });
}
const sysMsg = (kind, data) => pushChat({ sys: true, kind, ...data });
function addFloors(u, n) {
  const before = u.floors;
  u.floors = Math.min(MAX_FLOORS, u.floors <= 1 ? n : u.floors + n);
  for (let m = 25; m <= MAX_FLOORS; m += 25) if (before < m && u.floors >= m) sysMsg("milestone", { name: u.name, uid: u.id, n: m });
  if (MAX_FLOORS % 25 && before < MAX_FLOORS && u.floors >= MAX_FLOORS) sysMsg("milestone", { name: u.name, uid: u.id, n: MAX_FLOORS });
}
function removeUser(u) {
  db.users = db.users.filter(x => x !== u); byId.delete(u.id); byKey.delete(u.key);
  for (const k in db.sessions) if (db.sessions[k].uid === u.id) delete db.sessions[k];
  const touched = [];
  for (const id of u.liked) { const tg = byId.get(id); if (tg) { tg.likes = Math.max(0, tg.likes - 1); touched.push(tg); } }
  for (const v of db.users) if (v.liked.includes(u.id)) v.liked = v.liked.filter(id => id !== u.id);
  const hadMsgs = db.chat.some(m => m.uid === u.id);
  db.chat = db.chat.filter(m => m.uid !== u.id);
  save();
  broadcast({ type: "remove", id: u.id });
  if (hadMsgs) broadcast({ type: "chat_purge", uid: u.id });
  for (const tg of touched) broadcast({ type: "upsert", r: pub(tg) });
}

/* ---------------- API ---------------- */
async function api(req, res, route) {
  const ip = ipOf(req);
  if (req.method === "GET") {
    switch (route) {
      case "state":
        return send(res, 200, {
          config: db.config, residents: db.users.map(pub), online: clients.size, step: STEP, maxFloors: MAX_FLOORS,
          cooldownMin: COOLDOWN_MS / 60000, shop: SHOP, skipCost: SKIP_COST, chatLast: db.chatSeq,
        });
      case "events": {
        if (clients.size >= 5000) return fail(res, 503, "busy");
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.on("error", () => {});
        res.write("retry: 4000\n\n");
        clients.add(res); announceOnline();
        req.on("close", () => { clients.delete(res); announceOnline(); });
        return;
      }
      case "me": {
        const u = authUser(req); if (!u) return fail(res, 401, "auth");
        touchIp(u, ip);
        return send(res, 200, meInfo(u));
      }
      case "chat": return send(res, 200, { messages: db.chat.slice(-CHAT_SEND) });
      case "admin/backup": {
        if (!isAdminReq(req)) return fail(res, 401, "auth");
        flush();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="aimahalla-zaxira-${today()}.json"`, "Cache-Control": "no-store" });
        return res.end(JSON.stringify(db));
      }
    }
    return fail(res, 404, "not_found");
  }
  if (req.method !== "POST") return fail(res, 405, "method");

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "bad_request"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};

  switch (route) {
    case "join": return join(res, ip, body);
    case "login": {
      const key = keyOf(body.name);
      if (limited("login:" + ip, 20, 600e3) || limited("loginname:" + key, 8, 600e3)) return fail(res, 429, "rate");
      const u = byKey.get(key);
      if (!u || !checkPin(String(body.pin || ""), u)) return fail(res, 401, "bad_login");
      touchIp(u, ip);
      return send(res, 200, { token: newSession({ uid: u.id }), ...meInfo(u) });
    }
    case "logout": {
      const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (tok) { delete db.sessions[sha(tok)]; save(); }
      return send(res, 200, { ok: true });
    }
    case "admin/login": {
      if (ADMIN_PASSWORD.length < 6) return fail(res, 403, "admin_off");
      if (limited("admin:" + ip, 6, 900e3)) return fail(res, 429, "rate");
      const a = Buffer.from(sha(String(body.password || "").trim())), b = Buffer.from(sha(ADMIN_PASSWORD));
      if (!crypto.timingSafeEqual(a, b)) return fail(res, 401, "bad_password");
      return send(res, 200, { adminToken: newSession({ admin: true }) });
    }
  }
  if (route.startsWith("admin/")) return adminApi(req, res, route, body);

  const u = authUser(req);
  if (!u) return fail(res, 401, "auth");
  const now = Date.now();
  switch (route) {
    case "build": {
      if (u.floors >= MAX_FLOORS) return fail(res, 400, "max", meInfo(u));
      if (now < (u.lastBuild || 0) + COOLDOWN_MS) {
        if (!body.fast) return fail(res, 429, "cooldown", meInfo(u));
        if (u.coins < SKIP_COST) return fail(res, 400, "no_coins", meInfo(u));
        u.coins -= SKIP_COST;
      }
      addFloors(u, STEP); u.lastBuild = now; save();
      broadcast({ type: "upsert", r: pub(u) });
      return send(res, 200, meInfo(u));
    }
    case "color": {
      if (!(Number.isInteger(body.color) && body.color >= 0 && body.color < 8)) return fail(res, 400, "bad_request");
      u.color = body.color; save();
      broadcast({ type: "upsert", r: pub(u) });
      return send(res, 200, meInfo(u));
    }
    case "gift": {
      const td = today();
      if (u.lastGiftDay === td) return fail(res, 429, "gift_taken", meInfo(u));
      u.streak = u.lastGiftDay === yesterday() ? u.streak + 1 : 1;
      const gift = 10 + 2 * Math.min(u.streak, 10);
      u.coins += gift; u.lastGiftDay = td; save();
      broadcast({ type: "upsert", r: pub(u) });
      return send(res, 200, { ...meInfo(u), gift });
    }
    case "like": {
      if (limited("like:" + u.id, 40, 600e3)) return fail(res, 429, "rate");
      const tg = byId.get(String(body.id || ""));
      if (!tg) return fail(res, 404, "not_found");
      if (tg === u) return fail(res, 400, "self");
      if (u.liked.includes(tg.id)) return fail(res, 409, "already", meInfo(u));
      u.liked.push(tg.id); tg.likes++;
      if (!(u.ipHash && u.ipHash === tg.ipHash)) tg.coins += LIKE_REWARD; // bitta qurilmadan o'ziga layk bosib tanga yig'ishning oldini oladi
      save();
      broadcast({ type: "upsert", r: pub(tg) });
      broadcast({ type: "like", to: tg.id, from: u.name });
      return send(res, 200, meInfo(u));
    }
    case "buy": {
      const item = String(body.item || "");
      if (!has(SHOP, item)) return fail(res, 400, "bad_request");
      const it = SHOP[item];
      if (u.decor.includes(item)) return fail(res, 409, "owned", meInfo(u));
      if (it.minFloors && u.floors < it.minFloors) return fail(res, 400, "need_floors", meInfo(u));
      if (u.coins < it.price) return fail(res, 400, "no_coins", meInfo(u));
      u.coins -= it.price; u.decor.push(item); save();
      broadcast({ type: "upsert", r: pub(u) });
      return send(res, 200, meInfo(u));
    }
    case "status": {
      if (limited("status:" + u.id, 10, 600e3)) return fail(res, 429, "rate");
      u.status = cleanText(body.text, 50); save();
      broadcast({ type: "upsert", r: pub(u) });
      return send(res, 200, meInfo(u));
    }
    case "chat": {
      if ((u.mutedUntil || 0) > now) return fail(res, 403, "muted");
      const text = cleanText(body.text, 200);
      if (!text) return fail(res, 400, "empty");
      if (text === u.lastMsg && now - (u.lastMsgAt || 0) < 120e3) return fail(res, 409, "dup");
      if (limited("chat1:" + u.id, 1, 2500) || limited("chatN:" + u.id, 15, 300e3)) return fail(res, 429, "rate");
      u.lastMsg = text; u.lastMsgAt = now;
      pushChat({ uid: u.id, name: u.name, color: u.color, text });
      return send(res, 200, { ok: true });
    }
  }
  return fail(res, 404, "not_found");
}

function join(res, ip, body) {
  const name = String(body.name || "").trim().replace(/^@/, "");
  const pin = String(body.pin || "");
  if (!NAME_RE.test(name)) return fail(res, 400, "name_invalid");
  if (!PIN_RE.test(pin)) return fail(res, 400, "pin_invalid");
  const key = keyOf(name);
  if (byKey.has(key) || RESERVED.has(key)) return fail(res, 409, "name_taken");
  if (limited("join:" + ip, 5, 3600e3)) return fail(res, 429, "rate");
  const salt = crypto.randomBytes(16).toString("hex");
  const color = Number.isInteger(body.color) && body.color >= 0 && body.color < 8 ? body.color : crypto.randomInt(8);
  const ih = ipHash(ip);
  const u = {
    id: crypto.randomBytes(8).toString("hex"), name, key, salt, pinHash: hashPin(pin, salt),
    floors: 1, color, slot: db.nextSlot++, joined: Date.now(), lastBuild: 0, coins: START_COINS,
    likes: 0, liked: [], invites: 0, streak: 0, lastGiftDay: "", decor: [], status: "", ipHash: ih,
  };
  db.users.push(u); byKey.set(key, u); byId.set(u.id, u);
  broadcast({ type: "upsert", r: pub(u), isNew: true });
  sysMsg("join", { name: u.name, uid: u.id, n: u.slot + 1 });
  // Taklif mukofoti: boshqa qurilmadan (boshqa IP) qo'shilgan do'st uchun
  const inviter = body.ref ? byKey.get(keyOf(body.ref)) : null;
  if (inviter && inviter !== u && inviter.ipHash !== ih) {
    inviter.invites++; inviter.coins += INVITE_COINS; u.invitedBy = inviter.id;
    addFloors(inviter, STEP);
    broadcast({ type: "upsert", r: pub(inviter) });
    sysMsg("invite", { name: inviter.name, uid: inviter.id, name2: u.name });
  }
  save();
  return send(res, 200, { token: newSession({ uid: u.id }), ...meInfo(u) });
}

function adminApi(req, res, route, body) {
  if (!isAdminReq(req)) return fail(res, 401, "auth");
  const u = body.id != null ? byId.get(String(body.id)) : null;
  const need = () => fail(res, 404, "not_found");
  switch (route) {
    case "admin/check": return send(res, 200, { ok: true });
    case "admin/config":
      db.config = { title: cleanText(body.title, 40), tagline: cleanText(body.tagline, 60) };
      save(); broadcast({ type: "config", config: db.config });
      return send(res, 200, { ok: true });
    case "admin/floors":
      if (!u) return need();
      u.floors = Math.max(1, Math.min(MAX_FLOORS, Math.round(+body.floors || 1))); save();
      broadcast({ type: "upsert", r: pub(u) });
      return send(res, 200, { ok: true });
    case "admin/coins":
      if (!u) return need();
      u.coins = Math.max(0, Math.round(u.coins + (+body.delta || 0))); save();
      broadcast({ type: "refresh_me", id: u.id });
      return send(res, 200, { ok: true });
    case "admin/status":
      if (!u) return need();
      u.status = ""; save();
      broadcast({ type: "upsert", r: pub(u) });
      return send(res, 200, { ok: true });
    case "admin/mute": {
      if (!u) return need();
      const hrs = Math.max(0, Math.min(24 * 30, +body.hours || 0));
      u.mutedUntil = hrs ? Date.now() + hrs * 3600e3 : 0; save();
      broadcast({ type: "refresh_me", id: u.id });
      return send(res, 200, { ok: true });
    }
    case "admin/remove":
      if (!u) return need();
      removeUser(u);
      return send(res, 200, { ok: true });
    case "admin/chat-del": {
      const mid = +body.mid, n = db.chat.length;
      db.chat = db.chat.filter(m => m.id !== mid);
      if (db.chat.length !== n) { save(); broadcast({ type: "chat_del", id: mid }); }
      return send(res, 200, { ok: true });
    }
  }
  return fail(res, 404, "not_found");
}

/* ---------------- pages ---------------- */
// Telegram va boshqa ilovalarda havola chiroyli ko'rinishi uchun sarlavha va tavsif qo'shiladi
let indexCache = { mtime: -1, html: "" };
function renderIndex(url) {
  const st = fs.statSync(INDEX_FILE);
  if (st.mtimeMs !== indexCache.mtime) indexCache = { mtime: st.mtimeMs, html: fs.readFileSync(INDEX_FILE, "utf8") };
  const title = db.config.title || "AI Mahalla";
  const tagline = db.config.tagline || "1 a'zo = 1 hovli";
  let ogTitle = title;
  let ogDesc = `${tagline} · ${db.users.length} aholi. Qo'shiling, hovli oling va osmono'par quring!`;
  const q = url.searchParams.get("u") || url.searchParams.get("ref");
  const r = q ? byKey.get(keyOf(q)) : null;
  if (r) {
    ogTitle = `${r.name} — ${title}`;
    ogDesc = `№${r.slot + 1} hovli · ${r.floors > 1 ? r.floors + " qavatli osmono'par" : "shinam hovli"} · ❤️ ${r.likes}. Qo'shni bo'ling!`;
  }
  const tags = [
    `<title>${htmlEsc(ogTitle)}</title>`,
    `<meta name="description" content="${htmlEsc(ogDesc)}">`,
    `<meta property="og:title" content="${htmlEsc(ogTitle)}">`,
    `<meta property="og:description" content="${htmlEsc(ogDesc)}">`,
    `<meta property="og:site_name" content="${htmlEsc(title)}">`,
    `<meta property="og:type" content="website">`,
    `<meta name="twitter:card" content="summary">`,
    `<script>window.__MAHALLA_SERVER__=1</script>`,
  ].join("\n");
  return indexCache.html.replace(/<!--OG-->[\s\S]*?<!--\/OG-->/, () => tags);
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };
function sendIndex(req, res, url) {
  let html;
  try { html = renderIndex(url); } catch (e) { res.writeHead(404); return res.end("index.html topilmadi"); }
  res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : html);
}
function serveStatic(req, res, url) {
  const p = url.pathname;
  if (!HAS_PUBLIC || p === "/" || p === "/index.html") return sendIndex(req, res, url);
  let file;
  try { file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(p))); } catch (e) { res.writeHead(400); return res.end(); }
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) return sendIndex(req, res, url);
    fs.readFile(file, (e, buf) => {
      if (e) return sendIndex(req, res, url);
      const ext = path.extname(file);
      res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "public, max-age=3600" });
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
  serveStatic(req, res, url);
});
server.on("error", e => { console.error("Server xatosi:", e.message); process.exit(1); });
server.listen(PORT, () => {
  console.log(`AI Mahalla ishga tushdi: http://localhost:${PORT}`);
  console.log(`Aholi: ${db.users.length}. Ma'lumotlar: ${DB_FILE}`);
  if (ADMIN_PASSWORD.length < 6) console.log("Eslatma: ADMIN_PASSWORD o'rnatilmagan yoki 6 belgidan qisqa, boshqaruv o'chiq.");
});
