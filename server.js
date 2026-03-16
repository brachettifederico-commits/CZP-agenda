import express from "express";
import cors from "cors";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Simple file-based storage (swap with DB in production) ──────────────────
const DB_PATH = join(__dirname, "data.json");
function readDB() {
  if (!existsSync(DB_PATH)) return { tasks: [], clients: [] };
  return JSON.parse(readFileSync(DB_PATH, "utf8"));
}
function writeDB(data) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ── Token store (in-memory; replace with session/DB for multi-user) ─────────
let msTokens = null; // { access_token, refresh_token, expires_at }

// ────────────────────────────────────────────────────────────────────────────
// MICROSOFT OAUTH
// ────────────────────────────────────────────────────────────────────────────
const MS_AUTH_URL = "https://login.microsoftonline.com";
const MS_SCOPES = [
  "openid", "offline_access", "profile",
  "Calendars.ReadWrite",
  "Tasks.ReadWrite",
].join(" ");

// Step 1 — redirect user to Microsoft login
app.get("/auth/login", (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.AZURE_REDIRECT_URI,
    response_mode: "query",
    scope: MS_SCOPES,
    state: "czp-agenda",
  });
  res.redirect(
    `${MS_AUTH_URL}/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/authorize?${params}`
  );
});

// Step 2 — handle callback, exchange code for tokens
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`Auth error: ${error}`);

  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    code,
    redirect_uri: process.env.AZURE_REDIRECT_URI,
    grant_type: "authorization_code",
    scope: MS_SCOPES,
  });

  const resp = await fetch(
    `${MS_AUTH_URL}/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }
  );
  const tokens = await resp.json();
  if (tokens.error) return res.send(`Token error: ${tokens.error_description}`);

  msTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  };

  res.redirect("/?connected=1");
});

// Check / refresh token
async function getAccessToken() {
  if (!msTokens) return null;
  if (Date.now() < msTokens.expires_at - 60000) return msTokens.access_token;

  // Refresh
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    refresh_token: msTokens.refresh_token,
    grant_type: "refresh_token",
    scope: MS_SCOPES,
  });
  const resp = await fetch(
    `${MS_AUTH_URL}/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }
  );
  const tokens = await resp.json();
  if (!tokens.error) {
    msTokens.access_token = tokens.access_token;
    msTokens.expires_at = Date.now() + tokens.expires_in * 1000;
    if (tokens.refresh_token) msTokens.refresh_token = tokens.refresh_token;
  }
  return msTokens.access_token;
}

app.get("/auth/status", (req, res) => {
  res.json({ connected: !!msTokens });
});

app.get("/auth/logout", (req, res) => {
  msTokens = null;
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// TASKS API
// ────────────────────────────────────────────────────────────────────────────
app.get("/api/tasks", (req, res) => res.json(readDB()));

app.post("/api/tasks", (req, res) => {
  const db = readDB();
  const task = {
    id: `t_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    ...req.body,
    done: false,
    outlookEventId: null,
    outlookTaskId: null,
    createdAt: new Date().toISOString(),
  };
  db.tasks.push(task);
  // ensure client exists
  if (task.client && !db.clients.find(c => c.name.toLowerCase() === task.client.toLowerCase())) {
    const colors = ["#1a6bcc","#0e8a7a","#7a3db8","#cc6a1a","#1a8a3a","#cc1a5a","#6a7acc"];
    db.clients.push({ name: task.client, color: colors[db.clients.length % colors.length] });
  }
  writeDB(db);
  res.json(task);
});

app.patch("/api/tasks/:id", (req, res) => {
  const db = readDB();
  const idx = db.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  Object.assign(db.tasks[idx], req.body);
  writeDB(db);
  res.json(db.tasks[idx]);
});

app.delete("/api/tasks/:id", (req, res) => {
  const db = readDB();
  db.tasks = db.tasks.filter(t => t.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// OUTLOOK — CREATE CALENDAR EVENT
// ────────────────────────────────────────────────────────────────────────────
app.post("/api/outlook/event", async (req, res) => {
  const token = await getAccessToken();
  if (!token) return res.status(401).json({ error: "Not connected to Outlook" });

  const { title, client, date, priority, tag } = req.body;
  const startDt = new Date(`${date}T09:00:00`);
  const endDt = new Date(`${date}T09:30:00`);

  const event = {
    subject: `[${client}] ${title}`,
    body: { contentType: "Text", content: `Priorità: ${priority || "media"}\nTag: ${tag || ""}` },
    start: { dateTime: startDt.toISOString(), timeZone: "Europe/Rome" },
    end: { dateTime: endDt.toISOString(), timeZone: "Europe/Rome" },
    categories: priority === "alta" ? ["Red category"] : [],
  };

  const resp = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  const data = await resp.json();
  if (data.error) return res.status(400).json(data.error);
  res.json({ outlookEventId: data.id });
});

// ────────────────────────────────────────────────────────────────────────────
// OUTLOOK — CREATE TO-DO TASK
// ────────────────────────────────────────────────────────────────────────────

// Get or create "CZP Agenda" task list
async function getCZPListId(token) {
  const resp = await fetch("https://graph.microsoft.com/v1.0/me/todo/lists", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  const existing = (data.value || []).find(l => l.displayName === "CZP Agenda");
  if (existing) return existing.id;

  const create = await fetch("https://graph.microsoft.com/v1.0/me/todo/lists", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "CZP Agenda" }),
  });
  const list = await create.json();
  return list.id;
}

app.post("/api/outlook/todo", async (req, res) => {
  const token = await getAccessToken();
  if (!token) return res.status(401).json({ error: "Not connected to Outlook" });

  const { title, client, date, priority } = req.body;
  const listId = await getCZPListId(token);

  const todoTask = {
    title: `[${client}] ${title}`,
    importance: priority === "alta" ? "high" : priority === "bassa" ? "low" : "normal",
    dueDateTime: { dateTime: `${date}T23:59:59`, timeZone: "Europe/Rome" },
    status: "notStarted",
  };

  const resp = await fetch(`https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(todoTask),
  });
  const data = await resp.json();
  if (data.error) return res.status(400).json(data.error);
  res.json({ outlookTaskId: data.id });
});

// ────────────────────────────────────────────────────────────────────────────
// AI CHAT
// ────────────────────────────────────────────────────────────────────────────
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function fmtDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function nextDow(dow) { const t = new Date(); const diff = (dow - t.getDay() + 7) % 7 || 7; return fmtDate(addDays(t, diff)); }
const DAYS = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;
  const db = readDB();
  const now = new Date();
  const td = fmtDate(now);

  const systemPrompt = `Sei un assistente agenda professionale per Fede, associate presso CZP&Co. (public affairs).
Oggi è ${td} (${DAYS[now.getDay()]}).

CLIENTI ESISTENTI: ${db.clients.map(c => c.name).join(", ") || "nessuno"}
TASK RECENTI: ${JSON.stringify(db.tasks.slice(-20).map(t => ({ id: t.id, title: t.title, client: t.client, date: t.date, done: t.done })))}

Rispondi SOLO con JSON valido (nessun markdown, nessun testo fuori):
{
  "action": "add" | "update" | "delete" | "complete" | "info",
  "tasks": [{ "title": "...", "client": "...", "date": "YYYY-MM-DD", "priority": "alta|media|bassa", "tag": "call|meeting|brief|report|deadline|email|draft" }],
  "taskIds": [],
  "updates": {},
  "syncOutlook": true,
  "message": "risposta breve in italiano"
}

Quando l'utente vuole aggiungere task imposta syncOutlook: true automaticamente.

DATE (usa queste esatte):
oggi=${td}
domani=${fmtDate(addDays(now,1))}
dopodomani=${fmtDate(addDays(now,2))}
lunedì=${nextDow(1)}
martedì=${nextDow(2)}
mercoledì=${nextDow(3)}
giovedì=${nextDow(4)}
venerdì=${nextDow(5)}
Se data mancante usa domani. Se cliente mancante usa "Generale". Se priorità mancante usa "media".`;

  const messages = [
    ...(history || []).slice(-6),
    { role: "user", content: message },
  ];

  try {
    const resp = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    const raw = resp.content[0].text.replace(/```json|```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { action: "info", message: "Non ho capito, puoi riformulare?" }; }
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ action: "info", message: "Errore AI. Riprova." });
  }
});

// ────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CZP Agenda running on http://localhost:${PORT}`));
