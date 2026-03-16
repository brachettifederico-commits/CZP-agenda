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
  const clientName = task.
