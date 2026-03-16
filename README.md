# CZP&Co. Agenda — Setup Guide

App web con AI chatbot + integrazione Outlook Calendar e To-Do.  
Deploy gratuito su Vercel, installabile come PWA su iPhone/Android.

---

## Struttura
```
czp-agenda/
├── server.js          ← backend Node.js (Express + AI + Microsoft Graph)
├── package.json
├── vercel.json        ← config per deploy Vercel
├── .env.example       ← variabili d'ambiente (copia in .env)
└── public/
    ├── index.html
    ├── manifest.json  ← PWA
    ├── css/app.css
    └── js/app.js
```

---

## STEP 1 — API Key Anthropic

1. Vai su https://console.anthropic.com
2. Crea un account (o accedi)
3. Menu → **API Keys** → **Create Key**
4. Copia la chiave (inizia con `sk-ant-...`)

---

## STEP 2 — Azure App Registration (per Outlook)

1. Vai su https://portal.azure.com
2. Cerca **"App registrations"** → **New registration**
3. Impostazioni:
   - **Name**: CZP Agenda
   - **Supported account types**: "Accounts in any organizational directory and personal Microsoft accounts"
   - **Redirect URI**: Web → `https://TUO-APP.vercel.app/auth/callback`
     (per test locale: `http://localhost:3000/auth/callback`)
4. Clicca **Register**
5. Dalla pagina dell'app prendi:
   - **Application (client) ID** → `AZURE_CLIENT_ID`
   - **Directory (tenant) ID** → `AZURE_TENANT_ID`
6. Vai su **Certificates & secrets** → **New client secret**
   - Copia il **Value** (non l'ID) → `AZURE_CLIENT_SECRET`
7. Vai su **API permissions** → **Add permission** → **Microsoft Graph** → **Delegated**:
   - `Calendars.ReadWrite`
   - `Tasks.ReadWrite`
   - `offline_access`
   - Clicca **Grant admin consent** (o lascia che ogni utente consenta al primo accesso)

---

## STEP 3 — Deploy su Vercel (gratuito)

### Prima volta
```bash
npm install -g vercel
cd czp-agenda
npm install
vercel
```
Segui il wizard: nome progetto, conferma impostazioni.

### Aggiungi le variabili d'ambiente
Sul sito Vercel → progetto → **Settings** → **Environment Variables**:

| Nome | Valore |
|------|--------|
| `ANTHROPIC_API_KEY` | sk-ant-... |
| `AZURE_CLIENT_ID` | (dall'App Registration) |
| `AZURE_CLIENT_SECRET` | (dal secret creato) |
| `AZURE_TENANT_ID` | `common` (oppure il tenant ID specifico) |
| `AZURE_REDIRECT_URI` | `https://czp-agenda.vercel.app/auth/callback` |
| `SESSION_SECRET` | stringa random di 32+ caratteri |

### Dopo aver aggiunto le variabili
```bash
vercel --prod
```

### Aggiorna l'Azure App Registration
Torna su Azure → App registrations → Redirect URIs:  
Aggiungi l'URL definitivo: `https://czp-agenda.vercel.app/auth/callback`

---

## STEP 4 — Test locale

```bash
cp .env.example .env
# modifica .env con le tue chiavi
npm install
node server.js
# → http://localhost:3000
```

Per il test Outlook in locale, imposta `AZURE_REDIRECT_URI=http://localhost:3000/auth/callback`  
e aggiungilo anche nelle Redirect URIs dell'app Azure.

---

## STEP 5 — Installare come app sul telefono

### iPhone (Safari)
1. Apri `https://czp-agenda.vercel.app` in Safari
2. Tasto condivisione (quadrato con freccia) → **"Aggiungi a schermata Home"**
3. L'app appare come app nativa, senza barra browser

### Android (Chrome)
1. Apri l'URL in Chrome
2. Menu (3 puntini) → **"Installa app"** o **"Aggiungi a schermata Home"**

---

## Uso del chatbot

Esempi di comandi:
- `"Aggiungi call con Fastweb giovedì alle 15, priorità alta"`
- `"Brief per Cisco entro venerdì, tag report"`
- `"Riunione Generative Bionics lunedì e deadline PNRR mercoledì, alta"`
- `"Completa il task Fastweb di ieri"`
- `"Sposta il meeting Cisco a martedì"`
- `"Mostra solo i task di Cisco"`

Quando aggiungi task con Outlook connesso, vengono creati automaticamente:
- **Evento** in Outlook Calendar (ore 9:00-9:30 sulla data indicata)
- **Task** in Outlook To-Do (lista "CZP Agenda")

---

## Note tecniche

- **Storage**: i dati sono salvati in `data.json` sul server. Per produzione multi-utente, sostituire con database (es. PostgreSQL su Vercel, oppure MongoDB Atlas gratuito).
- **Auth Outlook**: i token sono in-memory. Per persistenza tra restart del server, salvare in DB o variabile d'ambiente cifrata.
- **Vercel**: il piano gratuito include 100GB di bandwidth/mese e deploy illimitati. Sufficiente per uso personale.
