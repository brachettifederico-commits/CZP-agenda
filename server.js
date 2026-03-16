import express from "express";
import cors from "cors";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DATA_DIR = process.env.VERCEL ? "/tmp" : __dirname;
const DB_PATH = join(DATA_DIR, "data.json");

function readDB() {
  try { if (existsSync(DB_PATH)) return JSON.parse(readFileSync(DB_PATH, "utf8")); } catch(e){}
  return { tasks: [], clients: [] };
}
function writeDB(data) {
  try { writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch(e){ console.error("writeDB:", e.message); }
}

let msTokens = null;
const MS_AUTH_URL = "https://login.microsoftonline.com";
const MS_SCOPES = ["openid","offline_access","profile","Calendars.ReadWrite","Tasks.ReadWrite"].join(" ");

app.get("/auth/login", (req, res) => {
  const params = new URLSearchParams({ client_id: process.env.AZURE_CLIENT_ID||"", response_type:"code", redirect_uri: process.env.AZURE_REDIRECT_URI||"", response_mode:"query", scope: MS_SCOPES, state:"czp-agenda" });
  res.redirect(`${MS_AUTH_URL}/${process.env.AZURE_TENANT_ID||"common"}/oauth2/v2.0/authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`Auth error: ${error}`);
  const body = new URLSearchParams({ client_id: process.env.AZURE_CLIENT_ID||"", client_secret: process.env.AZURE_CLIENT_SECRET||"", code, redirect_uri: process.env.AZURE_REDIRECT_URI||"", grant_type:"authorization_code", scope: MS_SCOPES });
  try {
    const resp = await fetch(`${MS_AUTH_URL}/${process.env.AZURE_TENANT_ID||"common"}/oauth2/v2.0/token`, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body });
    const tokens = await resp.json();
    if (tokens.error) return res.send(`Token error: ${tokens.error_description}`);
    msTokens = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000 };
    res.redirect("/?connected=1");
  } catch(e) { res.send("Auth error: " + e.message); }
});

async function getAccessToken() {
  if (!msTokens) return null;
  if (Date.now() < msTokens.expires_at - 60000) return msTokens.access_token;
  const body = new URLSearchParams({ client_id: process.env.AZURE_CLIENT_ID||"", client_secret: process.env.AZURE_CLIENT_SECRET||"", refresh_token: msTokens.refresh_token, grant_type:"refresh_token", scope: MS_SCOPES });
  const resp = await fetch(`${MS_AUTH_URL}/${process.env.AZURE_TENANT_ID||"common"}/oauth2/v2.0/token`, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body });
  const tokens = await resp.json();
  if (!tokens.error) { msTokens.access_token = tokens.access_token; msTokens.expires_at = Date.now() + tokens.expires_in * 1000; if (tokens.refresh_token) msTokens.refresh_token = tokens.refresh_token; }
  return msTokens.access_token;
}

app.get("/auth/status", (req, res) => res.json({ connected: !!msTokens }));
app.get("/auth/logout", (req, res) => { msTokens = null; res.json({ ok: true }); });

app.get("/api/tasks", (req, res) => res.json(readDB()));

app.post("/api/tasks", (req, res) => {
  const db = readDB();
  const task = { id: `t_${Date.now()}_${Math.random().toString(36).substr(2,5)}`, ...req.body, done: false, outlookEventId: null, outlookTaskId: null, createdAt: new Date().toISOString() };
  db.tasks.push(task);
  const clientName = task.client || "Generale";
  if (!db.clients.find(c => c.name.toLowerCase() === clientName.toLowerCase())) {
    const colors = ["#1a6bcc","#0e8a7a","#7a3db8","#cc6a1a","#1a8a3a","#cc1a5a","#6a7acc"];
    db.clients.push({ name: clientName, color: colors[db.clients.length % colors.length] });
  }
  writeDB(db);
  res.json(task);
});

app.patch("/api/tasks/:id", (req, res) => {
  const db = readDB();
  const idx = db.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error:"not found" });
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

app.post("/api/outlook/event", async (req, res) => {
  const token = await getAccessToken();
  if (!token) return res.status(401).json({ error:"Not connected to Outlook" });
  const { title, client, date, priority, tag } = req.body;
  try {
    const resp = await fetch("https://graph.microsoft.com/v1.0/me/events", { method:"POST", headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, body: JSON.stringify({ subject:`[${client}] ${title}`, body:{ contentType:"Text", content:`Priorità: ${priority||"media"}\nTag: ${tag||""}` }, start:{ dateTime:`${date}T09:00:00`, timeZone:"Europe/Rome" }, end:{ dateTime:`${date}T09:30:00`, timeZone:"Europe/Rome" } }) });
    const data = await resp.json();
    if (data.error) return res.status(400).json(data.error);
    res.json({ outlookEventId: data.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function getCZPListId(token) {
  const resp = await fetch("https://graph.microsoft.com/v1.0/me/todo/lists", { headers:{ Authorization:`Bearer ${token}` } });
  const data = await resp.json();
  const existing = (data.value||[]).find(l => l.displayName === "CZP Agenda");
  if (existing) return existing.id;
  const create = await fetch("https://graph.microsoft.com/v1.0/me/todo/lists", { method:"POST", headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, body: JSON.stringify({ displayName:"CZP Agenda" }) });
  return (await create.json()).id;
}

app.post("/api/outlook/todo", async (req, res) => {
  const token = await getAccessToken();
  if (!token) return res.status(401).json({ error:"Not connected to Outlook" });
  const { title, client, date, priority } = req.body;
  try {
    const listId = await getCZPListId(token);
    const resp = await fetch(`https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks`, { method:"POST", headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, body: JSON.stringify({ title:`[${client}] ${title}`, importance: priority==="alta"?"high":priority==="bassa"?"low":"normal", dueDateTime:{ dateTime:`${date}T23:59:59`, timeZone:"Europe/Rome" }, status:"notStarted" }) });
    const data = await resp.json();
    if (data.error) return res.status(400).json(data.error);
    res.json({ outlookTaskId: data.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function addDays(d,n){ const r=new Date(d); r.setDate(r.getDate()+n); return r; }
function fmtDate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function nextDow(dow){ const t=new Date(); const diff=(dow-t.getDay()+7)%7||7; return fmtDate(addDays(t,diff)); }
const DAYS=['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error:"missing message" });
  const db = readDB();
  const now = new Date();
  const td = fmtDate(now);
  const systemPrompt = `Sei un assistente agenda professionale per Fede, associate presso CZP&Co. (public affairs).
Oggi è ${td} (${DAYS[now.getDay()]}).
CLIENTI: ${db.clients.map(c=>c.name).join(", ")||"nessuno"}
TASK RECENTI: ${JSON.stringify(db.tasks.slice(-15).map(t=>({id:t.id,title:t.title,client:t.client,date:t.date,done:t.done})))}
Rispondi SOLO con JSON valido (nessun testo fuori, nessun markdown):
{"action":"add|update|delete|complete|info","tasks":[{"title":"","client":"","date":"YYYY-MM-DD","priority":"alta|media|bassa","tag":"call|meeting|brief|report|deadline|email|draft"}],"taskIds":[],"updates":{},"syncOutlook":true,"message":"risposta breve in italiano"}
DATE: oggi=${td}, domani=${fmtDate(addDays(now,1))}, dopodomani=${fmtDate(addDays(now,2))}, lunedì=${nextDow(1)}, martedì=${nextDow(2)}, mercoledì=${nextDow(3)}, giovedì=${nextDow(4)}, venerdì=${nextDow(5)}
Se manca data usa domani. Se manca cliente usa "Generale". Se manca priorità usa "media".`;
  try {
    const resp = await anthropic.messages.create({ model:"claude-opus-4-5-20251101", max_tokens:1024, system:systemPrompt, messages:[...(history||[]).slice(-6),{role:"user",content:message}] });
    const raw = resp.content[0].text.replace(/```json|```/g,"").trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { action:"info", message:"Non ho capito, puoi riformulare?" }; }
    res.json(parsed);
  } catch(err) {
    console.error("AI error:", err.message);
    res.status(500).json({ action:"info", message:"Errore AI. Riprova." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CZP Agenda running on port ${PORT}`));
export default app;
