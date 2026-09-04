// wa-bridge/server.js
// =============================================================================
// JARVIS – bridge HTTP locale per WhatsApp via whatsapp-web.js.
// Esposto su http://127.0.0.1:8765 (override con env WA_PORT / WA_HOST).
//
// PATCH 2026-01 (JARVIS fix v2):
//   * Fuzzy matching sui nomi chat (token-set + Levenshtein normalizzato) con
//     normalizzazione accenti/case, per non fallire piu' su "mamma", "noemy"...
//   * Endpoint /resolveContact -> top-N candidati con score, cosi' JARVIS
//     puo' chiedere conferma vocale se il match esatto non esiste.
//   * Cache in-memory della chat list (refresh ogni 3 min, invalidata dopo
//     un messaggio in ingresso).
//   * Debounce sui messaggi entranti (2 s) per evitare letture doppie quando
//     WhatsApp consegna piu' eventi ravvicinati per la stessa chat.
//   * Blocco della telemetria "dit.whatsapp.net/deidentified_telemetry"
//     (che causa loop CORS + CPU alta nel Chromium headless).
//   * Args puppeteer con WebGL/canvas hw disabilitati -> niente
//     "Too many active WebGL contexts" e meno CPU.
//   * Log dettagliato dello stato quando la risoluzione contatti fallisce.
//
// Endpoint:
//   GET  /status                       -> { ready, qr, online, error }
//   GET  /chats                        -> { chats: [{id,name,isGroup}] }
//   GET  /resolveContact?name=&topN=3  -> { exact, matches:[{name,id,score}] }
//   GET  /unread                       -> { messages:[{id,from,body}] }
//   POST /send   { to|name, text }
//   POST /reply  { name, text, quoteMsgId? }
//   GET  /lastFrom/:name?limit=1
// =============================================================================

const express = require("express");
const qrcode  = require("qrcode-terminal");
const fs      = require("fs");
const path    = require("path");

// --- puppeteer-extra + stealth (whatsapp-web.js require('puppeteer') hook) ---
const puppeteerExtra = require("puppeteer-extra");
const StealthPlugin  = require("puppeteer-extra-plugin-stealth");
puppeteerExtra.use(StealthPlugin());
const realPuppeteerPath = require.resolve("puppeteer");
require.cache[realPuppeteerPath] = {
  id: realPuppeteerPath,
  filename: realPuppeteerPath,
  loaded: true,
  exports: puppeteerExtra,
};

const { Client, LocalAuth } = require("whatsapp-web.js");

const HOST = process.env.WA_HOST || "127.0.0.1";
const PORT = parseInt(process.env.WA_PORT || "8765", 10);

function findSystemBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [];
  if (process.platform === "win32") {
    const PF   = process.env["ProgramFiles"]        || "C:\\Program Files";
    const PFX  = process.env["ProgramFiles(x86)"]   || "C:\\Program Files (x86)";
    const LAD  = process.env["LOCALAPPDATA"]        || "";
    candidates.push(
      path.join(PF,  "Google\\Chrome\\Application\\chrome.exe"),
      path.join(PFX, "Google\\Chrome\\Application\\chrome.exe"),
      LAD && path.join(LAD, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(PF,  "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(PFX, "Microsoft\\Edge\\Application\\msedge.exe"),
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }
  for (const p of candidates.filter(Boolean)) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

const SYS_BROWSER = findSystemBrowser();
if (SYS_BROWSER) {
  console.log(`[wa-bridge] usero' il browser di sistema: ${SYS_BROWSER}`);
} else {
  console.warn("[wa-bridge] Chrome/Edge non trovato: usero' il Chromium bundled.");
}

// -----------------------------------------------------------------------------
// Fuzzy matching (nessuna nuova dipendenza)
// -----------------------------------------------------------------------------
function normalize(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // rimuove accenti
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const v0 = new Array(bl + 1);
  const v1 = new Array(bl + 1);
  for (let i = 0; i <= bl; i++) v0[i] = i;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= bl; j++) v0[j] = v1[j];
  }
  return v1[bl];
}

// token_set_ratio simile a rapidfuzz: 0..100
function tokenSetRatio(a, b) {
  const A = normalize(a), B = normalize(b);
  if (!A || !B) return 0;
  const ta = new Set(A.split(" "));
  const tb = new Set(B.split(" "));
  const inter = [...ta].filter((x) => tb.has(x)).sort().join(" ");
  const restA = [...ta].filter((x) => !tb.has(x)).sort().join(" ");
  const restB = [...tb].filter((x) => !ta.has(x)).sort().join(" ");
  const t0 = inter;
  const t1 = (inter + " " + restA).trim();
  const t2 = (inter + " " + restB).trim();
  const combos = [
    [t0, t1], [t0, t2], [t1, t2],
    [A, B],
  ];
  let best = 0;
  for (const [x, y] of combos) {
    const len = Math.max(x.length, y.length);
    if (!len) continue;
    const dist = levenshtein(x, y);
    const score = Math.round((1 - dist / len) * 100);
    if (score > best) best = score;
  }
  // bonus se una stringa contiene l'altra
  if (A.includes(B) || B.includes(A)) best = Math.max(best, 85);
  return best;
}

// -----------------------------------------------------------------------------
// App state
// -----------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

let lastQR    = null;
let isReady   = false;
let initError = null;
const unread  = [];
const seenIds = new Set();

// cache chat list
let _chatCache = { at: 0, list: [] };
const CHAT_CACHE_TTL_MS = 3 * 60 * 1000;
function invalidateChatCache() { _chatCache.at = 0; }

// debounce per notifiche duplicate stessa chat/testo
const _recentNotifs = new Map(); // key -> lastTs
const NOTIF_DEBOUNCE_MS = 2000;

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const puppeteerOpts = {
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-webgl",
    "--disable-webgl2",
    "--disable-accelerated-2d-canvas",
    "--disable-features=WebGL,WebGL2,Accelerated2dCanvas",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
  ],
};
if (SYS_BROWSER) puppeteerOpts.executablePath = SYS_BROWSER;

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "jarvis" }),
  puppeteer: puppeteerOpts,
  userAgent: DESKTOP_UA,
});

// --- Blocco telemetria WhatsApp (dit.whatsapp.net/deidentified_telemetry) ---
// Whatsapp-web.js espone `client.pupPage` dopo il ready. Attacchiamo un
// requestInterception che aborta la telemetria: risparmia CPU/rete e ferma
// il loop di errori CORS visibile nei log.
async function installRequestInterceptor() {
  try {
    const page = client.pupPage;
    if (!page) return;
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      try {
        const url = req.url() || "";
        if (
          url.includes("dit.whatsapp.net") ||
          url.includes("deidentified_telemetry") ||
          url.includes("/telemetry")
        ) {
          return req.abort();
        }
        req.continue();
      } catch (_) {
        try { req.continue(); } catch (_2) {}
      }
    });
    console.log("[wa-bridge] telemetry interceptor attivo.");
  } catch (e) {
    console.warn("[wa-bridge] interceptor non installato:", e.message);
  }
}

client.on("qr", (qr) => {
  lastQR = qr;
  console.log("\n[wa-bridge] Scansiona QR (WhatsApp > Dispositivi collegati):\n");
  qrcode.generate(qr, { small: true });
});
client.on("ready", () => {
  isReady = true; lastQR = null; initError = null;
  console.log("[wa-bridge] WhatsApp pronto.");
  installRequestInterceptor();
});
client.on("auth_failure", (m) => { initError = "auth_failure: " + m; console.error(initError); });
client.on("disconnected", (r) => { isReady = false; console.warn("[wa-bridge] disconnesso", r); });

client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;
    if (seenIds.has(msg.id._serialized)) return;
    seenIds.add(msg.id._serialized);
    if (seenIds.size > 1000) {
      const arr = Array.from(seenIds).slice(-500);
      seenIds.clear();
      arr.forEach((x) => seenIds.add(x));
    }

    let from = msg.from;
    try {
      const c = await msg.getChat();
      from = (c && c.name) ? c.name : from;
    } catch (_) {}

    // Debounce 2s per stessa chat+body: evita letture doppie.
    const dkey = (from || "?") + "|" + ((msg.body || "").slice(0, 60));
    const now = Date.now();
    const prev = _recentNotifs.get(dkey) || 0;
    if (now - prev < NOTIF_DEBOUNCE_MS) return;
    _recentNotifs.set(dkey, now);
    if (_recentNotifs.size > 200) {
      // GC leggero
      for (const [k, ts] of _recentNotifs) {
        if (now - ts > 60_000) _recentNotifs.delete(k);
      }
    }

    unread.push({ id: msg.id._serialized, from, body: msg.body || "" });
    if (unread.length > 500) unread.splice(0, unread.length - 250);
    invalidateChatCache();
  } catch (e) {
    console.error("[wa-bridge] err msg", e);
  }
});

client.initialize().catch((e) => {
  initError = String(e && e.message || e);
  console.error("[wa-bridge] init err", e);
});

// ---------------- API ----------------
app.get("/status", (_req, res) =>
  res.json({ ready: isReady, qr: lastQR, online: true, error: initError })
);

async function getChatsCached() {
  if (!isReady) return [];
  const now = Date.now();
  if (_chatCache.list.length && now - _chatCache.at < CHAT_CACHE_TTL_MS) {
    return _chatCache.list;
  }
  const chats = await client.getChats();
  const mapped = chats.map((c) => ({
    _raw: c,
    id:   c.id && c.id._serialized ? c.id._serialized : String(c.id || ""),
    name: c.name || (c.formattedTitle) || (c.id && c.id.user) || "(chat)",
    isGroup: !!c.isGroup,
  }));
  _chatCache = { at: now, list: mapped };
  return mapped;
}

app.get("/chats", async (_req, res) => {
  if (!isReady) return res.json({ chats: [], ready: false, error: initError });
  try {
    const chats = await getChatsCached();
    res.json({
      chats: chats.map((c) => ({ id: c.id, name: c.name, isGroup: c.isGroup })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/unread", (_req, res) => {
  const out = unread.splice(0, unread.length);
  res.json({ messages: out });
});

// ---- Risoluzione contatti con top-N fuzzy match ----------------------------
async function resolveContactTopN(needleRaw, topN = 3, threshold = 65) {
  const needle = normalize(needleRaw);
  if (!needle) return { exact: null, matches: [] };
  const chats = await getChatsCached();

  // 1) exact (normalizzato)
  let exact = chats.find((c) => normalize(c.name) === needle);

  // 2) score fuzzy per tutti
  const scored = chats
    .map((c) => ({
      name: c.name,
      id: c.id,
      isGroup: c.isGroup,
      _raw: c._raw,
      score: tokenSetRatio(needle, c.name),
    }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score);

  if (!exact && scored.length && scored[0].score >= 92) {
    exact = scored[0];
  }

  const top = scored.slice(0, topN);
  return { exact, matches: top };
}

async function resolveChatByName(needleRaw) {
  const { exact, matches } = await resolveContactTopN(needleRaw, 1, 60);
  const pick = exact || matches[0] || null;
  if (!pick) {
    // Log dettagliato per debug: quali nomi ha visto il bridge?
    try {
      const chats = await getChatsCached();
      const preview = chats.slice(0, 15).map((c) => c.name).join(" | ");
      console.warn(
        `[wa-bridge] chat NON risolta per "${needleRaw}". Chat viste (` +
        `${chats.length}): ${preview}${chats.length > 15 ? " ..." : ""}`
      );
    } catch (_) {}
    return null;
  }
  return pick._raw || pick;
}

app.get("/resolveContact", async (req, res) => {
  if (!isReady) return res.status(503).json({ ready: false, error: initError });
  try {
    const name  = (req.query.name || "").toString();
    const topN  = Math.max(1, Math.min(10, parseInt(req.query.topN || "3", 10)));
    const thr   = Math.max(0, Math.min(100, parseInt(req.query.threshold || "65", 10)));
    const { exact, matches } = await resolveContactTopN(name, topN, thr);
    res.json({
      query: name,
      threshold: thr,
      exact: exact ? { name: exact.name, id: exact.id, isGroup: !!exact.isGroup, score: 100 } : null,
      matches: matches.map((m) => ({ name: m.name, id: m.id, isGroup: !!m.isGroup, score: m.score })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/send", async (req, res) => {
  if (!isReady) return res.status(503).json({ ok: false, error: "WhatsApp non pronto, scansiona il QR." });
  const { to, name, text } = req.body || {};
  const message = (text || "").toString();
  if (!message) return res.status(400).json({ ok: false, error: "text mancante" });
  try {
    let target = (to || "").toString();
    let chatObj = null;
    if (!target.includes("@")) {
      chatObj = await resolveChatByName(name || to);
      if (!chatObj) {
        // Ritorna anche i top candidati cosi' il chiamante puo' chiedere
        // conferma vocale senza fare una seconda round-trip.
        const { matches } = await resolveContactTopN(name || to, 3, 60);
        return res.status(404).json({
          ok: false,
          error: "chat non trovata",
          suggestions: matches.map((m) => ({ name: m.name, id: m.id, score: m.score })),
        });
      }
      target = chatObj.id._serialized || chatObj.id;
    }
    await client.sendMessage(target, message);
    res.json({ ok: true, to: (chatObj && chatObj.name) || target });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/lastFrom/:name", async (req, res) => {
  if (!isReady) return res.status(503).json({ messages: [], error: "WhatsApp non pronto." });
  const rawName = decodeURIComponent(req.params.name || "");
  const limit = Math.max(1, Math.min(20, parseInt(req.query.limit || "1", 10)));
  try {
    const chat = await resolveChatByName(rawName);
    if (!chat) {
      const { matches } = await resolveContactTopN(rawName, 3, 60);
      return res.status(404).json({
        messages: [],
        error: "chat non trovata",
        suggestions: matches.map((m) => ({ name: m.name, id: m.id, score: m.score })),
      });
    }
    const raw = await chat.fetchMessages({ limit: limit + 20 });
    const incoming = raw.filter((m) => !m.fromMe).slice(-limit).reverse();
    res.json({
      chat: chat.name || (chat.id && chat.id._serialized) || "",
      messages: incoming.map((m) => ({
        id:   m.id && m.id._serialized ? m.id._serialized : String(m.id || ""),
        from: chat.name || (m.author || m.from || ""),
        body: m.body || "",
        type: m.type || "chat",
        timestamp: m.timestamp || 0,
      })),
    });
  } catch (e) {
    res.status(500).json({ messages: [], error: String(e) });
  }
});

app.post("/reply", async (req, res) => {
  if (!isReady) return res.status(503).json({ ok: false, error: "WhatsApp non pronto." });
  const { name, text, quoteMsgId } = req.body || {};
  const message = (text || "").toString();
  if (!message) return res.status(400).json({ ok: false, error: "text mancante" });
  try {
    const chat = await resolveChatByName(name);
    if (!chat) {
      const { matches } = await resolveContactTopN(name, 3, 60);
      return res.status(404).json({
        ok: false, error: "chat non trovata",
        suggestions: matches.map((m) => ({ name: m.name, id: m.id, score: m.score })),
      });
    }

    let quoted = null;
    if (quoteMsgId) {
      try {
        const hist = await chat.fetchMessages({ limit: 50 });
        quoted = hist.find((m) => m.id && m.id._serialized === quoteMsgId) || null;
      } catch (_) { quoted = null; }
    }

    if (quoted) {
      await chat.sendMessage(message, { quotedMessageId: quoted.id._serialized });
    } else {
      await chat.sendMessage(message);
    }
    res.json({ ok: true, quoted: !!quoted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Voice addon (sendVoice + /media/:msgId) ---
try {
  require("./voice_addon")(app, client);
  console.log("[wa-bridge] voice_addon attivo (POST /sendVoice, GET /media/:id)");
} catch (e) {
  console.warn("[wa-bridge] voice_addon non caricato:", e.message);
}

app.listen(PORT, HOST, () => {
  console.log(`[wa-bridge] listening on http://${HOST}:${PORT}`);
});
