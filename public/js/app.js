// CZP Agenda — Frontend
const API = ""; // empty = same origin

const MONTHS = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const DAYS = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];

let tasks = [];
let clients = [];
let activeClient = 'all';
let activeFilter = 'all';
let calMonth = new Date().getMonth();
let calYear = new Date().getFullYear();
let chatHistory = [];
let busy = false;
let outlookConnected = false;

// ── Utils ────────────────────────────────────────────────────────────────────
const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today = () => fmtDate(new Date());

// ── API calls ────────────────────────────────────────────────────────────────
async function apiGet(path) {
  const r = await fetch(API + path);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function apiPatch(path, body) {
  const r = await fetch(API + path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function apiDelete(path) {
  const r = await fetch(API + path, { method: 'DELETE' });
  return r.json();
}

// ── Load data ────────────────────────────────────────────────────────────────
async function loadAll() {
  const db = await apiGet('/api/tasks');
  tasks = db.tasks || [];
  clients = db.clients || [];
  const status = await apiGet('/auth/status');
  outlookConnected = status.connected;
  updateOutlookUI();
  renderAll();
}

// ── Outlook UI ───────────────────────────────────────────────────────────────
function updateOutlookUI() {
  const btn = document.getElementById('btn-outlook');
  const dot = document.getElementById('outlook-dot');
  const lbl = document.getElementById('outlook-label');
  if (outlookConnected) {
    btn.classList.add('connected');
    dot.classList.add('connected');
    lbl.textContent = 'Outlook ✓';
  } else {
    btn.classList.remove('connected');
    dot.classList.remove('connected');
    lbl.textContent = 'Outlook';
  }
}

document.getElementById('btn-outlook').addEventListener('click', () => {
  if (!outlookConnected) window.location.href = '/auth/login';
  else if (confirm('Disconnettere Outlook?')) {
    apiGet('/auth/logout').then(() => { outlookConnected = false; updateOutlookUI(); });
  }
});

// ── Render ───────────────────────────────────────────────────────────────────
function renderAll() {
  renderClients();
  renderAgenda();
  renderCalendar();
}

function renderClients() {
  const list = document.getElementById('client-list');
  const total = tasks.filter(t => !t.done).length;
  list.innerHTML = `
    <div class="client-item ${activeClient === 'all' ? 'active' : ''}" data-c="all">
      <div class="cdot" style="background:var(--border-2)"></div>
      <span class="c-name">Tutti i clienti</span>
      <span class="c-count">${total}</span>
    </div>
  `;
  clients.forEach(c => {
    const cnt = tasks.filter(t => t.client?.toLowerCase() === c.name.toLowerCase() && !t.done).length;
    const div = document.createElement('div');
    div.className = 'client-item' + (activeClient === c.name ? ' active' : '');
    div.dataset.c = c.name;
    div.innerHTML = `<div class="cdot" style="background:${c.color}"></div><span class="c-name">${c.name}</span><span class="c-count">${cnt}</span>`;
    list.appendChild(div);
  });
  list.querySelectorAll('.client-item').forEach(el => el.addEventListener('click', () => {
    activeClient = el.dataset.c;
    renderAll();
  }));
}

function renderAgenda() {
  const scroll = document.getElementById('agenda-scroll');
  const filtered = tasks.filter(t => {
    if (activeClient !== 'all' && t.client?.toLowerCase() !== activeClient.toLowerCase()) return false;
    if (activeFilter === 'pending' && t.done) return false;
    if (activeFilter === 'done' && !t.done) return false;
    if (activeFilter === 'alta' && t.priority !== 'alta') return false;
    return true;
  });

  if (!filtered.length) {
    scroll.innerHTML = `<div class="empty-state"><div class="empty-icon">✦</div><p>Nessun task.</p><p class="empty-sub">Usa il chatbot!</p></div>`;
    return;
  }

  const groups = {};
  filtered.forEach(t => { (groups[t.date] = groups[t.date] || []).push(t); });
  const td = today();
  scroll.innerHTML = '';

  Object.keys(groups).sort().forEach(dk => {
    const [y, m, d] = dk.split('-').map(Number);
    const dt = new Date(y, m-1, d);
    const isToday = dk === td;
    const isPast = dk < td;
    const g = document.createElement('div');
    g.className = 'day-group';
    g.innerHTML = `
      <div class="day-hdr">
        <div class="day-num" style="${isPast && !isToday ? 'opacity:.5' : ''}">${d}</div>
        <div class="day-info">
          <div class="day-name">${DAYS[dt.getDay()]}</div>
          <div class="day-month">${MONTHS[m-1]} ${y}</div>
        </div>
        ${isToday ? '<span class="today-badge">Oggi</span>' : ''}
        ${isPast && !isToday ? '<span class="past-badge">passato</span>' : ''}
      </div>
      <div class="task-list" id="tl-${dk}"></div>
    `;
    scroll.appendChild(g);

    const tl = document.getElementById(`tl-${dk}`);
    groups[dk].forEach(t => {
      const cl = clients.find(x => x.name.toLowerCase() === t.client?.toLowerCase());
      const col = cl?.color || '#1a6bcc';
      const card = document.createElement('div');
      card.className = 'task-card' + (t.done ? ' done' : '');
      card.style.borderLeftColor = col;
      card.innerHTML = `
        <div class="task-chk">${t.done ? '✓' : ''}</div>
        <div class="task-body">
          <div class="task-client" style="color:${col}">${t.client || 'Generale'}</div>
          <div class="task-title">${t.title}</div>
          <div class="task-meta">
            ${t.tag ? `<span class="tag">${t.tag}</span>` : ''}
            <span class="prio ${t.priority || 'media'}">${t.priority || 'media'}</span>
            ${t.outlookEventId ? '<span class="outlook-sync-badge">📅 Outlook</span>' : ''}
            ${t.outlookTaskId ? '<span class="outlook-sync-badge">✓ To-Do</span>' : ''}
          </div>
        </div>
        <div class="task-actions">
          <button class="task-action-btn" title="Completa">✓</button>
          <button class="task-action-btn del" title="Elimina">✕</button>
        </div>
      `;
      card.querySelector('.task-chk').addEventListener('click', () => toggleTask(t.id, t.done));
      card.querySelectorAll('.task-action-btn')[0].addEventListener('click', () => toggleTask(t.id, t.done));
      card.querySelectorAll('.task-action-btn')[1].addEventListener('click', () => deleteTask(t.id));
      tl.appendChild(card);
    });
  });
}

function renderCalendar() {
  document.getElementById('cal-lbl').textContent = `${MONTHS[calMonth].substring(0,3).toUpperCase()} ${calYear}`;
  const grid = document.getElementById('cal-grid');
  const dls = ['L','M','M','G','V','S','D'];
  let html = dls.map(d => `<div class="cal-dl">${d}</div>`).join('');
  let firstDow = new Date(calYear, calMonth, 1).getDay();
  firstDow = firstDow === 0 ? 6 : firstDow - 1;
  const dim = new Date(calYear, calMonth + 1, 0).getDate();
  const td = today();
  const tDates = new Set(tasks.map(t => t.date));
  for (let i = 0; i < firstDow; i++) html += '<div></div>';
  for (let d = 1; d <= dim; d++) {
    const dk = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const cls = ['cal-day', dk === td ? 'today' : '', tDates.has(dk) ? 'has-task' : ''].filter(Boolean).join(' ');
    html += `<div class="${cls}" data-dk="${dk}">${d}</div>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.cal-day').forEach(el => el.addEventListener('click', () => {
    const target = document.getElementById(`tl-${el.dataset.dk}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

// ── Task actions ─────────────────────────────────────────────────────────────
async function toggleTask(id, wasDone) {
  await apiPatch(`/api/tasks/${id}`, { done: !wasDone });
  const t = tasks.find(x => x.id === id);
  if (t) t.done = !wasDone;
  renderAll();
}

async function deleteTask(id) {
  await apiDelete(`/api/tasks/${id}`);
  tasks = tasks.filter(t => t.id !== id);
  renderAll();
}

// ── Outlook sync ─────────────────────────────────────────────────────────────
async function syncTaskToOutlook(task) {
  if (!outlookConnected) return;
  try {
    const [evResp, todoResp] = await Promise.all([
      apiPost('/api/outlook/event', task),
      apiPost('/api/outlook/todo', task),
    ]);
    const updates = {};
    if (evResp.outlookEventId) updates.outlookEventId = evResp.outlookEventId;
    if (todoResp.outlookTaskId) updates.outlookTaskId = todoResp.outlookTaskId;
    if (Object.keys(updates).length) {
      await apiPatch(`/api/tasks/${task.id}`, updates);
      Object.assign(task, updates);
    }
  } catch (e) {
    console.warn('Outlook sync failed:', e);
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────
function addMsg(role, html) {
  const msgs = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="msg-content">${html}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function showTyping() {
  const msgs = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = 'msg ai'; div.id = 'typing';
  div.innerHTML = `<div class="msg-content"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function hideTyping() {
  document.getElementById('typing')?.remove();
}

async function sendMsg() {
  const ta = document.getElementById('chat-ta');
  const text = ta.value.trim();
  if (!text || busy) return;
  busy = true;
  ta.value = ''; ta.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
  document.getElementById('chat-sub').textContent = 'elaborando…';

  addMsg('user', text);
  showTyping();

  chatHistory.push({ role: 'user', content: text });

  try {
    const parsed = await apiPost('/api/chat', { message: text, history: chatHistory });
    hideTyping();

    // Handle actions
    if (parsed.action === 'add' && parsed.tasks?.length) {
      const newTasks = [];
      for (const t of parsed.tasks) {
        const created = await apiPost('/api/tasks', t);
        tasks.push(created);
        // update clients
        if (!clients.find(c => c.name.toLowerCase() === created.client?.toLowerCase())) {
          const db = await apiGet('/api/tasks');
          clients = db.clients;
        }
        newTasks.push(created);
        if (parsed.syncOutlook) await syncTaskToOutlook(created);
      }
      addMsg('sys', `✓ ${newTasks.length} task aggiunto${newTasks.length > 1 ? 'i' : ''}${outlookConnected && parsed.syncOutlook ? ' + Outlook sincronizzato' : ''}`);
    }

    if (parsed.action === 'delete' && parsed.taskIds?.length) {
      for (const id of parsed.taskIds) await deleteTask(id);
      addMsg('sys', '✓ Task eliminato');
    }

    if (parsed.action === 'complete' && parsed.taskIds?.length) {
      for (const id of parsed.taskIds) {
        await apiPatch(`/api/tasks/${id}`, { done: true });
        const t = tasks.find(x => x.id === id);
        if (t) t.done = true;
      }
      addMsg('sys', '✓ Task completato');
    }

    if (parsed.action === 'update' && parsed.taskIds?.length && parsed.updates) {
      for (const id of parsed.taskIds) {
        await apiPatch(`/api/tasks/${id}`, parsed.updates);
        const t = tasks.find(x => x.id === id);
        if (t) Object.assign(t, parsed.updates);
      }
      addMsg('sys', '✓ Task aggiornato');
    }

    if (parsed.message) {
      addMsg('ai', parsed.message);
      chatHistory.push({ role: 'assistant', content: parsed.message });
    }

    renderAll();

  } catch (err) {
    hideTyping();
    addMsg('ai', 'Errore di connessione al server. Verifica che il server sia avviato.');
    console.error(err);
  }

  busy = false;
  document.getElementById('send-btn').disabled = false;
  document.getElementById('chat-sub').textContent = 'pronto';
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.getElementById('send-btn').addEventListener('click', sendMsg);
document.getElementById('chat-ta').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
document.getElementById('chat-ta').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 100) + 'px';
});
document.querySelectorAll('.hint').forEach(h => h.addEventListener('click', () => {
  const ta = document.getElementById('chat-ta');
  ta.value = h.dataset.h; ta.focus();
}));
document.querySelectorAll('.pill').forEach(b => b.addEventListener('click', () => {
  activeFilter = b.dataset.f;
  document.querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  renderAgenda();
}));
document.getElementById('cal-prev').addEventListener('click', () => {
  calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar();
});
document.getElementById('cal-next').addEventListener('click', () => {
  calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar();
});

// Mobile FAB
const fab = document.getElementById('fab');
const chatPanel = document.getElementById('chat-panel');
fab.addEventListener('click', () => { chatPanel.classList.toggle('open'); });
document.getElementById('btn-chat-close')?.addEventListener('click', () => { chatPanel.classList.remove('open'); });

// Check outlook connection param
if (new URLSearchParams(location.search).get('connected')) {
  addMsg('sys', '✓ Outlook connesso con successo!');
  history.replaceState({}, '', '/');
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadAll();
