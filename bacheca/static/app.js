import * as Store from "./store.js";
const { CONFIG, OWNER } = Store;


const COLORS = ["green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink", "black"];
const PRIORITIES = { 1: "Critica", 2: "Alta", 3: "Media", 4: "Bassa", 5: "Minima" };
const prio = (c) => (PRIORITIES[c.priority] ? Number(c.priority) : 0);
const COLOR_NAMES = {
  green: "verde", yellow: "giallo", orange: "arancione", red: "rosso", purple: "viola",
  blue: "blu", sky: "azzurro", lime: "lime", pink: "rosa", black: "grigio",
};
const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const DAY_MS = 86400000;

const S = {
  board: null,
  open: null,            // id della scheda aperta
  query: "",
  labels: new Set(),     // filtro per etichette
  archives: new Set(load("archivi", [])), // colonne con l'archivio aperto
  descDraft: null,       // {id, text, preview} mentre si modifica la descrizione
  infos: new Set(load("note-colonne", [])), // colonne con le note aperte
  noteDraft: null,       // {id, text} mentre si scrivono le note di una colonna
  commentDraft: {},      // testo non inviato per scheda
  descOpen: new Set(),   // schede con la descrizione lunga aperta (sul telefono)
  history: load("cronologia", false), // pannello dei tuoi commenti aperto
  drag: null,
};

/* ---------- Utilità ---------- */

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`bacheca.${key}`)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(`bacheca.${key}`, JSON.stringify(value)); } catch { /* niente */ }
}

const ICONS = {
  check: '<path d="m5 12 5 5 9-10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  list: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
  clip: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  desc: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  week: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  back: '<path d="M10 7 5 12l5 5M5 12h14"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  sub: '<path d="M6 4v8a3 3 0 0 0 3 3h10"/><path d="m15 11 4 4-4 4"/>',
  outdent: '<path d="M20 6H9M20 12h-8M20 18H9"/><path d="m7 9-3 3 3 3"/>',
  indent: '<path d="M20 6H9M20 12h-8M20 18H9"/><path d="m4 9 3 3-3 3"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M10 2h4"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
};
function icon(name, cls = "") {
  return `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${ICONS[name]}</svg>`;
}
const esc = Md.escape;

function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function toast(message) {
  const box = document.getElementById("toast");
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 3500);
}

async function api(method, path, body, raw) {
  try {
    return await Store.call(method, path, body, raw);
  } catch (error) {
    toast(error instanceof Store.HttpError ? error.message : failure(error));
    throw error;
  }
}

function failure(error) {
  if (error?.code === "permission-denied") return "Questo account non è abilitato.";
  if (error?.code === "unavailable") return "Connessione assente, riprova.";
  return "Qualcosa non è andato, riprova.";
}

const card = (id) => S.board.cards.find((c) => c.id === id);
const list = (id) => S.board.lists.find((l) => l.id === id);
const label = (id) => S.board.labels.find((l) => l.id === id);
const areas = () => S.board.lists.filter((l) => l.kind === "area");
const column = (id) => S.board.cards.filter((c) => c.list === id && !c.archived).sort((a, b) => a.pos - b.pos);
const archived = (id) => S.board.cards.filter((c) => c.area === id && c.archived).sort((a, b) => (b.archivedAt > a.archivedAt ? 1 : -1));

/* ---------- Date ---------- */

function parseDue(value) {
  if (!value) return null;
  const [d, t] = value.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t ? t.split(":").map(Number) : [23, 59];
  return new Date(y, m - 1, day, hh, mm);
}
function formatDue(value) {
  const date = parseDue(value);
  if (!date) return "";
  let s = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  if (date.getFullYear() !== new Date().getFullYear()) s += ` ${date.getFullYear()}`;
  if (value.includes("T")) s += ` ${value.slice(11, 16)}`;
  return s;
}
function dueClass(value, done) {
  if (done) return "due-done";
  const diff = parseDue(value) - Date.now();
  if (diff < 0) return "due-late";
  if (diff < 2 * DAY_MS) return "due-soon";
  return "due-later";
}
function ago(iso) {
  const date = new Date(iso);
  const diff = (Date.now() - date) / 1000;
  if (diff < 60) return "adesso";
  if (diff < 3600) return `${Math.floor(diff / 60)} min fa`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h fa`;
  const s = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  const time = date.toTimeString().slice(0, 5);
  return date.getFullYear() === new Date().getFullYear() ? `${s}, ${time}` : `${s} ${date.getFullYear()}`;
}
function minutes(m) {
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}`;
}
// Minuti di lavoro sulla scheda, scritti da Claude a ogni buongiorno con `jb.py tempo`.
function timeTotals(c) {
  const days = c.time || [];
  return { days, focus: days.reduce((s, d) => s + d.focus, 0), agents: days.reduce((s, d) => s + d.agents, 0) };
}
function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* ---------- Dati ---------- */

async function refresh(force = false) {
  S.board = Store.board();
  S.stale = false;
  // Un'etichetta eliminata (anche annullandone la creazione) non deve restare nel filtro: nasconderebbe tutto.
  for (const id of S.labels) if (!label(id)) S.labels.delete(id);
  updateUndo();
  renderFilters();
  renderBoard();
  renderModal({ force });
  renderHistory();
}

/* ---------- Annulla ----------
   Le modifiche della bacheca (schede, spostamenti, voci, commenti, descrizioni) si annullano per un'ora,
   dalla più recente, con il pulsante in alto o Ctrl+Z / Cmd+Z fuori dai campi di testo. Dentro un campo
   Ctrl+Z resta quello del browser, sul testo che si sta scrivendo. */
function updateUndo() {
  const label = Store.undoLabel();
  const b = document.getElementById("btn-annulla");
  b.hidden = !label;
  b.title = label ? `Annulla: ${label}` : "Annulla";
  b.setAttribute("aria-label", b.title);
}

async function undo() {
  if (S.drag) return;
  let label;
  try {
    label = Store.undo();
  } catch (error) {
    return toast(error instanceof Store.HttpError ? error.message : failure(error));
  }
  if (!label) return toast("Niente da annullare.");
  S.descDraft = null;
  closePop();
  await refresh(true);
  if (S.open && !card(S.open)) closeCard();
  toast(`Annullato: ${label}`);
}

document.getElementById("btn-annulla").addEventListener("click", undo);
// In un campo che non si è ancora toccato il browser non ha niente da annullare: allora vale per la bacheca.
const valueAtFocus = new WeakMap();
document.addEventListener("focusin", (e) => { if ("value" in e.target) valueAtFocus.set(e.target, e.target.value); });
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "z" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const t = document.activeElement;
  const field = t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable);
  if (field && (t.isContentEditable || t.value !== valueAtFocus.get(t))) return;
  e.preventDefault();
  undo();
});

// Modifiche arrivate da fuori (un altro dispositivo, Claude): si ridisegna, ma non durante un trascinamento.
function changed() {
  if (S.drag) { S.stale = true; return; }
  refresh();
}

// Ogni modifica scrive su Firestore, poi la bacheca si ridisegna dalla copia locale.
async function act(method, path, body, raw) {
  const result = await api(method, path, body, raw);
  await refresh(true);
  return result;
}

/* ---------- Bacheca ---------- */

function matches(c) {
  if (S.labels.size && !c.labels.some((id) => S.labels.has(id))) return false;
  if (!S.query) return true;
  const q = S.query.toLowerCase();
  const hay = [c.title, c.desc, ...c.checklists.flatMap((cl) => [cl.title, ...cl.items.map((i) => i.text)]),
    ...c.comments.map((m) => m.text)].join("\n").toLowerCase();
  return hay.includes(q);
}

// Il filtro per etichette sta nel popover del pulsante Etichette: il pulsante si accende e dice quante sono attive.
function renderFilters() {
  const b = document.getElementById("btn-etichette");
  const n = S.labels.size;
  b.classList.toggle("on", n > 0);
  b.querySelector(".n")?.remove();
  if (n) b.append(h(`<span class="n">${n}</span>`));
  b.title = n ? `Filtro: ${[...S.labels].map((id) => label(id)?.name).join(", ")}` : "Etichette e filtro";
  b.setAttribute("aria-label", b.title);
}

function renderBoard() {
  const root = document.getElementById("bacheca");
  const scroll = root.scrollLeft;
  const inner = new Map([...root.querySelectorAll(".cards")].map((el) => [el.dataset.list, el.scrollTop]));
  const composer = root.querySelector(".composer textarea");
  const composing = composer && { list: composer.closest(".col").dataset.list, text: composer.value, focus: document.activeElement === composer };
  const noteFocus = document.activeElement?.closest?.(".col-editor") && document.activeElement;
  const noteCaret = noteFocus && [noteFocus.selectionStart, noteFocus.selectionEnd, noteFocus.scrollTop];

  root.innerHTML = "";
  const week = S.board.lists.find((l) => l.kind === "week");
  if (week) {
    root.append(renderColumn(week));
    root.append(h('<div class="divider" role="separator"></div>'));
  }
  for (const area of areas()) root.append(renderColumn(area));
  root.append(h(`<button class="btn add-col" data-act="add-col">${icon("plus")} Aggiungi colonna</button>`));

  root.scrollLeft = scroll;
  // Il campo nuova scheda si riapre com'era, ma riprende il focus solo se l'aveva: con una scheda
  // aperta sopra, quello che si scrive nella scheda finiva qui dietro.
  if (composing) openComposer(composing.list, composing.text, composing.focus);
  for (const el of root.querySelectorAll(".cards")) el.scrollTop = inner.get(el.dataset.list) || 0;
  const ta = S.noteDraft && root.querySelector(`.col[data-list="${S.noteDraft.id}"] .col-editor textarea`);
  if (ta && (noteCaret || S.noteDraft.focus)) {
    ta.focus();
    if (noteCaret) { ta.setSelectionRange(noteCaret[0], noteCaret[1]); ta.scrollTop = noteCaret[2]; }
    S.noteDraft.focus = false;
  }
}

// Sottotitolo e note in Markdown della colonna: sotto il titolo, chiuse finché non le apri.
function colInfo(l) {
  const draft = S.noteDraft?.id === l.id ? S.noteDraft : null;
  if (!l.subtitle && !l.notes && !draft) return null;
  const open = draft || S.infos.has(l.id);
  const el = h(`<div class="col-info ${open ? "open" : ""}">
    <button class="col-sub" data-act="toggle-info" title="${esc(l.subtitle || "Note")}">${icon("chev", "chev")}<span>${esc(l.subtitle || "Note")}</span></button>
  </div>`);
  if (!open) return el;
  if (draft) {
    const ed = h(`<div class="editor col-editor">
      <textarea placeholder="Note in Markdown: ### titoli, - elenchi, **grassetto**"></textarea>
      <div class="row"><button class="btn primary" data-act="notes-save">Salva</button><button class="btn ghost" data-act="notes-cancel">Annulla</button></div>
    </div>`);
    const ta = ed.querySelector("textarea");
    ta.value = draft.text;
    ta.addEventListener("input", () => { draft.text = ta.value; });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveNotes(l.id);
      if (e.key === "Escape") { e.stopPropagation(); S.noteDraft = null; renderBoard(); }
    });
    el.append(ed);
  } else if (l.notes) {
    el.append(h(`<div class="col-notes md" data-act="edit-notes" title="Clic per modificare">${Md.render(l.notes)}</div>`));
  } else {
    el.append(h(`<div class="desc-empty col-notes-empty" data-act="edit-notes">Aggiungi note</div>`));
  }
  return el;
}

function editNotes(id) {
  S.infos.add(id);
  store("note-colonne", [...S.infos]);
  S.noteDraft = { id, text: list(id).notes || "", focus: true };
  renderBoard();
}

async function saveNotes(id) {
  const text = S.noteDraft.text;
  S.noteDraft = null;
  if (text !== (list(id).notes || "")) await act("PATCH", `/api/colonne/${id}`, { notes: text });
  else renderBoard();
}

function subtitlePop(anchor, l) {
  pop(anchor, `<h4>Sottotitolo</h4><div class="stack"><input class="field" type="text" maxlength="200" placeholder="Per esempio: cliente, persone e ruoli"><button class="btn primary">Salva</button></div>`, (el) => {
    const input = el.querySelector("input");
    input.value = l.subtitle || "";
    const save = async () => {
      closePop();
      if (input.value.trim() !== (l.subtitle || "")) await act("PATCH", `/api/colonne/${l.id}`, { subtitle: input.value.trim() });
    };
    el.querySelector("button").addEventListener("click", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  });
}

function renderColumn(l) {
  const cards = column(l.id);
  const filtering = S.query || S.labels.size;
  const shown = filtering ? cards.filter(matches).length : cards.length;
  const col = h(`<section class="col ${l.kind === "week" ? "week" : ""}" data-list="${l.id}">
    <div class="col-head">
      ${l.kind === "area" ? `<span class="dot c-${l.color}"></span>` : ""}
      <h2 data-act="rename-col" title="${esc(l.name)}">${esc(l.name)}</h2>
      <span class="count" ${filtering ? `title="${shown} di ${cards.length} con il filtro"` : ""}>${filtering ? `${shown}/${cards.length}` : cards.length}</span>
      <button class="icon-btn" data-act="col-menu" aria-label="Menu colonna">${icon("dots")}</button>
    </div>
    <div class="cards" data-list="${l.id}"></div>
    ${l.kind === "week" ? "" : `<div class="add-card"><button class="btn" data-act="compose">${icon("plus")} Aggiungi una scheda</button></div>`}
  </section>`);
  const box = col.querySelector(".cards");
  const info = colInfo(l);
  if (info) box.before(info);
  for (const c of cards) box.append(renderCard(c, l.kind === "week"));

  if (l.kind === "area") {
    const old = archived(l.id);
    const open = S.archives.has(l.id);
    const arch = h(`<div class="archive ${open ? "open" : ""}">
      <div class="archive-head">
        <button class="archive-toggle" data-act="toggle-archive">${icon("chev", "chev")} Archivio <span class="count">${filtering ? `${old.filter(matches).length}/${old.length}` : old.length}</span></button>
        <button class="trash-btn" data-act="empty-archive" title="Svuota l'archivio" aria-label="Svuota l'archivio">${icon("trash")}</button>
      </div>
      <div class="archive-list" ${open ? "" : "hidden"}></div>
    </div>`);
    const listEl = arch.querySelector(".archive-list");
    for (const c of old) {
      if (!matches(c)) continue;
      listEl.append(h(`<div class="archived" data-card="${c.id}">
        ${c.done ? `<span class="check done">${icon("check")}</span>` : ""}
        <span class="t">${esc(c.title)}</span><span class="when">${c.archivedAt ? ago(c.archivedAt) : ""}</span>
        <button class="trash-btn" data-act="delete-archived" title="Elimina la scheda" aria-label="Elimina la scheda">${icon("trash")}</button>
      </div>`));
    }
    if (old.length) col.append(arch);
  }
  return col;
}

// Le voci che contano per l'avanzamento: quelle senza sotto-voci (una voce madre è fatta quando lo sono le sue).
const leaves = (items) => items.filter((i) => !items.some((x) => x.parent === i.id));
const MAX_DEPTH = 3;

function cardStats(c) {
  const items = c.checklists.flatMap((cl) => leaves(cl.items));
  const done = items.filter((i) => i.done).length;
  const nextItem = items.filter((i) => !i.done && i.due).sort((a, b) => parseDue(a.due) - parseDue(b.due))[0];
  const open = c.comments.filter((m) => m.author === "utente" && !m.resolved).length;
  return { items: items.length, done, nextItem, open };
}

function renderCard(c, inWeek) {
  const st = cardStats(c);
  const labels = c.labels.map(label).filter(Boolean);
  // Sulla scheda in colonna la pillola c'è solo per P1-P3: P4 e P5 sono quasi tutte e non distinguono niente.
  const pill = prio(c) && prio(c) <= 3 ? prio(c) : 0;
  const badges = [];
  if (c.due) badges.push(`<span class="chip ${dueClass(c.due, c.done)}" title="Scadenza">${icon("clock")}${formatDue(c.due)}${bells(c)}</span>`);
  if (st.nextItem && (!c.due || parseDue(st.nextItem.due) < parseDue(c.due)))
    badges.push(`<span class="chip ${dueClass(st.nextItem.due, false)}" title="${esc(st.nextItem.text)}">${icon("list")}${formatDue(st.nextItem.due)}</span>`);
  const tt = timeTotals(c);
  if (tt.focus || tt.agents) badges.push(`<span class="badge" title="Tempo: focus ${minutes(tt.focus)}, agenti ${minutes(tt.agents)}">${icon("timer")}${minutes(tt.focus)}</span>`);
  if (st.items) badges.push(`<span class="badge ${st.done === st.items ? "all-done" : ""}">${icon("list")}${st.done}/${st.items}</span>`);
  if (c.attachments.length) badges.push(`<span class="badge">${icon("clip")}${c.attachments.length}</span>`);
  if (c.comments.length) badges.push(`<span class="badge ${st.open ? "open-comments" : ""}" title="${st.open ? `${st.open} da risolvere` : "Commenti"}">${icon("chat")}${st.open || c.comments.length}</span>`);
  if (inWeek) {
    const area = list(c.area);
    if (area) badges.push(`<span class="area-tag c-${area.color}">${esc(area.name)}</span>`);
  }
  return h(`<article class="card ${c.done ? "done" : ""} ${matches(c) ? "" : "hidden"}" data-card="${c.id}" data-prio="${prio(c)}">
    <div class="card-body">
      ${labels.length || pill ? `<div class="top-row"><div class="labels">${labels.map((l) => `<span class="label c-${l.color}" title="${esc(l.name)}">${esc(l.name)}</span>`).join("")}</div>${pill ? `<span class="prio p${pill}" title="Priorità ${pill}: ${PRIORITIES[pill]}">P${pill}</span>` : ""}</div>` : ""}
      <div class="title-row">
        <button class="check ${c.done ? "done" : ""}" data-act="toggle-done" aria-label="${c.done ? "Segna da fare" : "Segna completata"}">${icon("check")}</button>
        <span class="title">${esc(c.title)}</span>
      </div>
      <div class="badges">${badges.join("")}</div>
    </div>
  </article>`);
}

function openComposer(listId, text = "", focus = true) {
  const col = document.querySelector(`.col[data-list="${listId}"]`);
  if (!col) return;
  const slot = col.querySelector(".add-card");
  if (!slot) return; // in Questa settimana non si creano schede: si trascinano dalle altre colonne
  slot.innerHTML = `<div class="composer">
    <textarea placeholder="Titolo della scheda" rows="2" maxlength="300"></textarea>
    <div class="row"><button class="btn primary" data-act="compose-save">Aggiungi</button>
    <button class="icon-btn" data-act="compose-cancel" aria-label="Annulla">${icon("x")}</button></div>
  </div>`;
  const area = slot.querySelector("textarea");
  area.value = text;
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveComposer(listId, area); }
    if (e.key === "Escape") { e.stopPropagation(); closeComposer(); }
  });
  if (!focus) return;
  area.focus();
  col.querySelector(".cards").scrollTop = 1e6;
}

// Si toglie prima di ridisegnare, altrimenti renderBoard lo riapre.
function closeComposer() {
  document.querySelector("#bacheca .composer")?.remove();
  renderBoard();
}

async function saveComposer(listId, area) {
  const title = area.value.trim();
  if (!title) return;
  area.value = "";
  try {
    await act("POST", "/api/schede", { list: listId, title });
  } catch {
    return openComposer(listId, title);
  }
  openComposer(listId);
}

/* ---------- Popover ---------- */

let popEl = null;
let popClosedFrom = null; // il pulsante del popover appena chiuso da un clic sul pulsante stesso
function closePop() { if (popEl) { popEl.remove(); popEl = null; } }

function pop(anchor, html, setup) {
  const again = popEl?.anchor === anchor || popClosedFrom === anchor;
  closePop();
  popClosedFrom = null;
  if (again) return null;
  popEl = h(`<div class="pop" role="dialog">${html}</div>`);
  popEl.anchor = anchor;
  document.body.append(popEl);
  setup?.(popEl);
  placePop();
  popEl.querySelector("input[type=text], input[type=url], input[type=date], textarea")?.focus();
  return popEl;
}

// Rimette il popover sotto (o sopra) il suo pulsante: anche quando cresce, come con le notifiche.
function placePop() {
  if (!popEl) return;
  // La scheda aperta si ridisegna dopo ogni modifica (per esempio spuntando un'etichetta) e il pulsante
  // diventa un altro: si riprende quello nuovo con lo stesso data-a, preferendo la stessa classe (23 novembre).
  if (!popEl.anchor.isConnected) {
    const old = popEl.anchor;
    const same = old.dataset.a ? [...document.querySelectorAll(`#modale [data-a="${old.dataset.a}"]`)] : [];
    const next = same.find((b) => b.className === old.className) || same.at(-1);
    if (!next) return; // nessun sostituto: il popover resta dov'era
    popEl.anchor = next;
  }
  const r = popEl.anchor.getBoundingClientRect();
  const w = popEl.offsetWidth;
  const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + popEl.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - popEl.offsetHeight - 6);
  popEl.style.left = `${left}px`;
  popEl.style.top = `${top}px`;
}

function swatches(current, allowNone) {
  return `<div class="swatches">${COLORS.map((c) =>
    `<button class="swatch c-${c} ${current === c ? "on" : ""}" data-color="${c}" title="${COLOR_NAMES[c]}" aria-label="${COLOR_NAMES[c]}"></button>`
  ).join("")}${allowNone ? `<button class="swatch none ${current ? "" : "on"}" data-color="" style="grid-column: span 5">Nessun colore</button>` : ""}</div>`;
}

// Scadenza con le sue notifiche, come un evento di Google Calendar. kind: "schede" o "voci" (per le predefinite).
function duePop(anchor, value, reminders, kind, onSave) {
  const [d, t] = (value || "").split("T");
  // Una scadenza nuova parte con le notifiche predefinite; una già impostata con le sue.
  let codes = value ? [...(reminders || [])] : [...Store.alertDefaults(S.board, kind)];
  pop(anchor, `<h4>Scadenza</h4><div class="stack">
    <div class="row"><input class="field" type="date" value="${d || ""}"><input class="field" type="time" value="${t || ""}"></div>
    <label class="small">${icon("bell")} Notifiche</label>
    <div class="rem-box"></div>
    <button class="btn primary" data-act="save">Salva</button>
    ${value ? '<button class="btn" data-act="clear">Rimuovi</button>' : ""}
  </div>`, (el) => {
    const [date, time] = el.querySelectorAll("input");
    if (!date.value) date.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const due = () => (date.value ? (time.value ? `${date.value}T${time.value}` : date.value) : "");
    const editor = remindersEditor(el.querySelector(".rem-box"), codes, () => !time.value, (next) => { codes = next; }, due);
    date.addEventListener("input", () => editor.redraw());
    time.addEventListener("input", () => editor.redraw());
    // Una notifica personalizzata compilata ma non ancora aggiunta si aggiunge salvando (23 novembre).
    const save = () => { if (date.value && editor.commit()) { closePop(); onSave(due(), codes); } };
    el.querySelector('[data-act="save"]').onclick = save;
    el.querySelector('[data-act="clear"]')?.addEventListener("click", () => { closePop(); onSave("", []); });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input") && !e.target.closest(".rem-custom")) save(); });
  });
}

/* ---------- Notifiche ----------
   Codici come in store.js: "10m", "1h", "1g", "1s" prima della scadenza; "0g@09:00" il giorno stesso alle 9. */
const REM_UNITS = { m: ["minuto", "minuti"], h: ["ora", "ore"], g: ["giorno", "giorni"], s: ["settimana", "settimane"] };
const PRESETS_TIMED = ["0m", "10m", "30m", "1h", "2h", "1g", "2g", "1s"];
const PRESETS_DAY = ["0g@09:00", "1g@09:00", "2g@09:00", "1s@09:00"];

function reminderText(code) {
  const m = code.match(/^(\d+)([mhgs])(?:@(\d{2}):(\d{2}))?$/);
  if (!m) return code;
  const n = +m[1];
  const unit = REM_UNITS[m[2]][n === 1 ? 0 : 1];
  if (m[3] !== undefined) {
    const at = `${+m[3]}:${m[4]}`;
    return n === 0 ? `Il giorno stesso alle ${at}` : `${n} ${unit} prima alle ${at}`;
  }
  return n === 0 ? "All'ora della scadenza" : `${n} ${unit} prima`;
}

// Elenco di notifiche modificabile: ognuna con la ✕, "Aggiungi notifica" con le scelte comuni e "Personalizza…".
// dayOnly(): true se la scadenza non ha l'ora (le scelte diventano "il giorno stesso alle 9", ...).
// due(): la scadenza che si sta impostando, per segnare in rosso le notifiche già passate (permesse lo stesso).
function remindersEditor(box, codes, dayOnly, onChange, due = () => "") {
  let custom = false;
  const past = (c) => { const at = reminderAt(due(), c); return at !== null && at < Date.now(); };
  const set = (next) => { codes = Store.sortReminders(next); onChange(codes); draw(); };
  const draw = () => {
    const mode = dayOnly(); // null: le predefinite, che valgono per entrambi i tipi di scadenza
    const presets = (mode === null ? [...PRESETS_DAY, "10m", "1h", "1g"] : mode ? PRESETS_DAY : PRESETS_TIMED).filter((p) => !codes.includes(p));
    box.innerHTML = `
      <div class="rem-list">${codes.map((c) => `<div class="rem ${past(c) ? "past" : ""}"${past(c) ? ' title="Ora già passata: non arriverà"' : ""}><span>${esc(reminderText(c))}${past(c) ? " · passata" : ""}</span>
        <button class="icon-btn" data-rm="${c}" aria-label="Togli la notifica ${esc(reminderText(c))}" title="Togli">${icon("x")}</button></div>`).join("")
        || '<p class="rem-none">Nessuna notifica</p>'}</div>
      ${custom ? `<div class="rem-custom">
        <div class="row"><input class="field" type="number" min="0" max="999" value="1" aria-label="Quanti">
          <select class="field" aria-label="Unità">${Object.entries(REM_UNITS).map(([u, [, many]]) =>
            `<option value="${u}" ${u === (mode === false ? "h" : "g") ? "selected" : ""}>${many}</option>`).join("")}</select>
          <span class="small">prima</span></div>
        <div class="row rem-at"><label class="small">alle</label><input class="field" type="time" value="${mode === false ? "" : "09:00"}" aria-label="Ora"></div>
        <div class="row"><button class="btn small primary" data-rem="ok">Aggiungi</button><button class="btn small" data-rem="cancel">Annulla</button></div>
      </div>` : `<select class="field rem-add" aria-label="Aggiungi notifica">
        <option value="">Aggiungi notifica…</option>
        ${presets.map((p) => `<option value="${p}">${esc(reminderText(p))}</option>`).join("")}
        <option value="custom">Personalizza…</option></select>`}`;
    const add = box.querySelector(".rem-add");
    add?.addEventListener("change", () => {
      if (add.value === "custom") { custom = true; draw(); box.querySelector(".rem-custom input")?.focus(); }
      else if (add.value) set([...codes, add.value]);
    });
    const unit = box.querySelector(".rem-custom select");
    const at = box.querySelector(".rem-at");
    const showAt = () => { if (at) at.hidden = !["g", "s"].includes(unit.value); };
    unit?.addEventListener("change", showAt);
    if (unit) showAt();
    placePop();
  };
  box.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) return set(codes.filter((c) => c !== rm.dataset.rm));
    const b = e.target.closest("[data-rem]");
    if (!b) return;
    if (b.dataset.rem === "ok") return commit();
    custom = false;
    draw();
  });
  // Aggiunge la notifica personalizzata in corso, se c'è; false se non è valida.
  const commit = () => {
    if (!custom) return true;
    const n = Math.max(0, Math.min(999, parseInt(box.querySelector('.rem-custom input[type="number"]').value, 10) || 0));
    const u = box.querySelector(".rem-custom select").value;
    const time = box.querySelector('.rem-custom input[type="time"]').value;
    const code = Store.normalizeReminder(`${n}${u}${["g", "s"].includes(u) && time ? "@" + time : ""}`);
    if (!code) { toast("Notifica non valida."); return false; }
    custom = false;
    set([...codes, code]);
    return true;
  };
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input, select") && e.target.closest(".rem-custom")) { e.preventDefault(); box.querySelector('[data-rem="ok"]').click(); }
  });
  draw();
  return { redraw: draw, commit };
}

// Quando parte una notifica (ms), con l'ora del dispositivo; come fireAt in mcp-worker/src/avvisi.ts.
function reminderAt(due, code) {
  const m = String(code).match(/^(\d+)([mhgs])(?:@(\d{2}):(\d{2}))?$/);
  const d = String(due || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!m || !d) return null;
  const n = +m[1];
  if (m[3] !== undefined) return new Date(+d[1], +d[2] - 1, +d[3] - n * (m[2] === "s" ? 7 : 1), +m[3], +m[4]).getTime();
  const base = new Date(+d[1], +d[2] - 1, +d[3], d[4] !== undefined ? +d[4] : 9, d[5] !== undefined ? +d[5] : 0).getTime();
  return base - n * { m: 1, h: 60, g: 1440, s: 10080 }[m[2]] * 60000;
}

// Campanella in alto: notifiche su questo dispositivo, installazione dell'app, notifiche predefinite.
const PUSH_STATES = {
  unsupported: "Questo browser non riceve notifiche.",
  install: "Su iPhone e iPad le notifiche arrivano solo dalla bacheca installata nella schermata Home.",
  denied: "Le notifiche per questo sito sono bloccate nelle impostazioni del browser: sbloccale lì, poi riapri questo menu.",
  off: "Le notifiche non sono attive su questo dispositivo.",
  on: "Le notifiche arrivano su questo dispositivo.",
};
async function notificationsPop(anchor) {
  const state = await Store.pushState();
  const showInstall = !Store.isStandalone() && (installPrompt || Store.isIOS());
  pop(anchor, `<h4>Notifiche</h4><div class="stack notif">
    <p class="notif-state ${state === "on" ? "on" : ""}">${icon("bell")}<span>${PUSH_STATES[state]}</span></p>
    ${state === "off" ? '<button class="btn primary" data-n="on">Attiva le notifiche su questo dispositivo</button>' : ""}
    ${state === "on" ? '<div class="row"><button class="btn" data-n="test">Manda una prova</button><button class="btn" data-n="off">Disattiva</button></div>' : ""}
    ${showInstall ? installHtml() : ""}
    <hr>
    <label class="small">Predefinite per le scadenze delle schede</label><div class="rem-box" data-def="schede"></div>
    <label class="small">Predefinite per le scadenze delle voci</label><div class="rem-box" data-def="voci"></div>
    <p class="hint">Valgono per le nuove scadenze; su ognuna si cambiano dal menu della scadenza. Le scadenze senza ora contano come alle 9:00.</p>
  </div>`, (el) => {
    for (const box of el.querySelectorAll("[data-def]")) {
      const kind = box.dataset.def;
      remindersEditor(box, [...Store.alertDefaults(S.board, kind)], () => null,
        (codes) => act("PATCH", "/api/avvisi", { [kind]: codes }));
    }
    el.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-n]");
      if (!b) return;
      b.disabled = true;
      try {
        if (b.dataset.n === "on") { await Store.enablePush(); await Store.testPush(); toast("Notifiche attive: tra un minuto arriva una prova."); }
        if (b.dataset.n === "off") { await Store.disablePush(); toast("Notifiche disattivate su questo dispositivo."); }
        if (b.dataset.n === "test") { await Store.testPush(); toast("Entro un minuto arriva una notifica di prova."); }
        if (b.dataset.n === "install") return installApp();
        closePop(); // si ridisegna con lo stato nuovo (senza, pop() lo prenderebbe per un secondo clic e lo chiuderebbe)
        notificationsPop(anchor);
      } catch (error) {
        b.disabled = false;
        toast(error instanceof Store.HttpError ? error.message : failure(error));
      }
    });
  });
}

/* ---------- Installazione come app ----------
   Chrome ed Edge (Android, computer) offrono l'installazione con un evento: il pulsante la apre direttamente.
   Safari su iPhone non lo permette: si mostrano i due passaggi da fare a mano. */
let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  updateInstallButton();
});
addEventListener("appinstalled", () => { installPrompt = null; updateInstallButton(); toast("Bacheca installata."); });
function updateInstallButton() {
  document.getElementById("btn-installa").hidden = Store.isStandalone() || !(installPrompt || Store.isIOS());
}
function installHtml() {
  if (installPrompt) return `<button class="btn" data-n="install">${icon("download")} Installa la bacheca come app</button>`;
  return `<div class="install-ios"><b>Installa la bacheca nella Home</b>
    <ol><li>In Safari tocca ${icon("share")} <b>Condividi</b> (su iOS 26 è nel menu <b>···</b>).</li>
    <li>Scegli <b>Aggiungi alla schermata Home</b>, poi <b>Aggiungi</b>.</li>
    <li>Apri la bacheca dall'icona nella Home ed entra con Google.</li></ol></div>`;
}
async function installApp() {
  if (!installPrompt) return pop(document.getElementById("btn-installa"), `<h4>Installa</h4><div class="stack notif">${installHtml()}</div>`);
  closePop();
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  if (outcome === "accepted") installPrompt = null;
  updateInstallButton();
}

function priorityPop(anchor, value, onSave) {
  pop(anchor, `<h4>Priorità</h4><div class="stack">
    ${Object.entries(PRIORITIES).map(([n, name]) =>
      `<button class="btn prio-row ${Number(n) === value ? "on" : ""}" data-p="${n}"><span class="prio p${n}">P${n}</span> ${name}</button>`).join("")}
    ${value ? '<button class="btn" data-p="0">Rimuovi</button>' : ""}
  </div>`, (el) => {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-p]");
      if (b) { closePop(); onSave(Number(b.dataset.p)); }
    });
  });
}

function labelsPop(anchor, c) {
  // Senza scheda (pulsante in alto) le spunte sono il filtro della bacheca.
  const on = (id) => (c ? c.labels.includes(id) : S.labels.has(id));
  const draw = (el) => {
    el.innerHTML = `<h4>${c ? "Etichette" : "Filtra per etichetta"}</h4><div class="stack">
      ${S.board.labels.map((l) => `<div class="label-row">
        <input type="checkbox" data-toggle="${l.id}" ${on(l.id) ? "checked" : ""} aria-label="${esc(l.name)}">
        <button class="label c-${l.color}" data-toggle="${l.id}">${esc(l.name || COLOR_NAMES[l.color])}</button>
        <button class="icon-btn" data-edit="${l.id}" aria-label="Modifica" title="Modifica">${icon("pencil")}</button>
      </div>`).join("")}
      ${!c && S.labels.size ? `<button class="btn" data-clear>${icon("x")} Togli il filtro</button>` : ""}
      <button class="btn" data-edit="">${icon("plus")} Nuova etichetta</button>
    </div>`;
    el.querySelector("[data-clear]")?.addEventListener("click", () => {
      S.labels.clear();
      renderFilters();
      renderBoard();
      draw(el);
    });
    el.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!c) {
        const id = b.dataset.toggle;
        S.labels.has(id) ? S.labels.delete(id) : S.labels.add(id);
        renderFilters();
        renderBoard();
        return draw(el);
      }
      const id = b.dataset.toggle;
      const next = c.labels.includes(id) ? c.labels.filter((x) => x !== id) : [...c.labels, id];
      await act("PATCH", `/api/schede/${c.id}`, { labels: next });
      c = card(c.id);
      draw(el);
    }));
    el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editLabel(el, b.dataset.edit)));
    placePop();
  };
  const editLabel = (el, id) => {
    const l = id ? label(id) : { name: "", color: "blue" };
    let chosen = l.color;
    el.innerHTML = `<h4>${id ? "Modifica etichetta" : "Nuova etichetta"}</h4><div class="stack">
      <input class="field" type="text" value="${esc(l.name)}" placeholder="Nome" maxlength="60">
      ${swatches(chosen, false)}
      <button class="btn primary" data-act="save">${id ? "Salva" : "Crea"}</button>
      ${id ? '<button class="btn danger" data-act="del">Elimina etichetta</button>' : ""}
      <button class="btn ghost" data-act="back">${icon("back")} Indietro</button>
    </div>`;
    const name = el.querySelector("input");
    placePop();
    name.focus();
    el.querySelectorAll(".swatch").forEach((s) => s.addEventListener("click", () => {
      chosen = s.dataset.color;
      el.querySelectorAll(".swatch").forEach((x) => x.classList.toggle("on", x === s));
    }));
    const save = async () => {
      const body = { name: name.value.trim(), color: chosen };
      if (id) await act("PATCH", `/api/etichette/${id}`, body);
      else {
        const made = await act("POST", "/api/etichette", body);
        if (c) { await act("PATCH", `/api/schede/${c.id}`, { labels: [...c.labels, made.id] }); }
      }
      if (c) c = card(c.id);
      draw(el);
    };
    el.querySelector('[data-act="save"]').onclick = save;
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    el.querySelector('[data-act="back"]').onclick = () => draw(el);
    el.querySelector('[data-act="del"]')?.addEventListener("click", async () => {
      if (!confirm(`Eliminare l'etichetta "${l.name}" da tutte le schede?`)) return;
      await act("DELETE", `/api/etichette/${id}`);
      if (c) c = card(c.id);
      draw(el);
    });
  };
  pop(anchor, "", draw);
}

function colMenu(anchor, l) {
  const idx = areas().indexOf(l);
  pop(anchor, `<h4>${esc(l.name)}</h4><div class="menu">
    <button data-m="rename">Rinomina</button>
    <button data-m="subtitle">${l.subtitle ? "Cambia sottotitolo" : "Aggiungi sottotitolo"}</button>
    <button data-m="notes">${l.notes ? "Modifica note" : "Aggiungi note"}</button>
    ${l.kind === "area" ? `<button data-m="left" ${idx === 0 ? "disabled" : ""}>Sposta a sinistra</button>
    <button data-m="right" ${idx === areas().length - 1 ? "disabled" : ""}>Sposta a destra</button>` : ""}
    ${l.kind === "area" ? `<hr><div style="padding:4px 0 8px">${swatches(l.color, true)}</div><hr><button data-m="delete" class="danger">Elimina colonna</button>` : ""}
  </div>`, (el) => {
    el.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", async () => {
      closePop();
      const m = b.dataset.m;
      if (m === "rename") renameColumn(l.id);
      if (m === "subtitle") subtitlePop(document.querySelector(`.col[data-list="${l.id}"] .col-head`), l);
      if (m === "notes") editNotes(l.id);
      if (m === "left") await act("PATCH", `/api/colonne/${l.id}`, { index: idx - 1 });
      if (m === "right") await act("PATCH", `/api/colonne/${l.id}`, { index: idx + 1 });
      if (m === "delete" && confirm(`Eliminare la colonna "${l.name}"?`)) await act("DELETE", `/api/colonne/${l.id}`);
    }));
    el.querySelectorAll(".swatch").forEach((s) => s.addEventListener("click", async () => {
      closePop();
      await act("PATCH", `/api/colonne/${l.id}`, { color: s.dataset.color });
    }));
  });
}

function renameColumn(id) {
  const head = document.querySelector(`.col[data-list="${id}"] h2`);
  if (!head) return;
  const input = h(`<input type="text" maxlength="80">`);
  input.value = list(id).name;
  head.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() && input.value.trim() !== list(id).name) await act("PATCH", `/api/colonne/${id}`, { name: input.value.trim() });
    else renderBoard();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") { e.stopPropagation(); finish(false); } });
  input.addEventListener("blur", () => finish(true));
}

/* ---------- Eventi della bacheca ---------- */

document.getElementById("bacheca").addEventListener("click", async (e) => {
  if (e.target.closest(".col-notes a, .col-editor textarea")) return;
  const target = e.target.closest("[data-act], [data-card]");
  if (!target || S.drag?.moved) return;
  const col = target.closest(".col");
  const listId = col?.dataset.list;
  switch (target.dataset.act) {
    case "toggle-done": {
      e.stopPropagation();
      const c = card(target.closest("[data-card]").dataset.card);
      await act("PATCH", `/api/schede/${c.id}`, { done: !c.done });
      return;
    }
    case "compose": return openComposer(listId);
    case "compose-save": return saveComposer(listId, col.querySelector(".composer textarea"));
    case "compose-cancel": return closeComposer();
    case "col-menu": return colMenu(target, list(listId));
    case "rename-col": return renameColumn(listId);
    case "toggle-info": {
      if (S.noteDraft?.id === listId) return;
      S.infos.has(listId) ? S.infos.delete(listId) : S.infos.add(listId);
      store("note-colonne", [...S.infos]);
      return renderBoard();
    }
    case "edit-notes": return editNotes(listId);
    case "notes-save": return saveNotes(listId);
    case "notes-cancel": S.noteDraft = null; return renderBoard();
    case "toggle-archive": {
      S.archives.has(listId) ? S.archives.delete(listId) : S.archives.add(listId);
      store("archivi", [...S.archives]);
      return renderBoard();
    }
    case "delete-archived": {
      e.stopPropagation();
      const c = card(target.closest("[data-card]").dataset.card);
      const files = c.attachments.filter((a) => a.kind === "file").length;
      const msg = files
        ? `Eliminare definitivamente "${c.title}"? Ha ${files} file allegati: questa non si può annullare.`
        : `Eliminare "${c.title}"? Si può annullare per un'ora con Annulla (Ctrl+Z).`;
      if (!confirm(msg)) return;
      await act("DELETE", `/api/schede/${c.id}`);
      return toast("Scheda eliminata.");
    }
    case "empty-archive": {
      const old = archived(listId);
      if (!old.length) return;
      const files = old.reduce((n, c) => n + c.attachments.filter((a) => a.kind === "file").length, 0);
      const msg = `Svuotare l'archivio di "${list(listId).name}"? Si eliminano ${old.length} schede`
        + (files ? `, con ${files} file allegati che non si possono recuperare.` : `. Ogni scheda si può annullare per un'ora con Ctrl+Z.`);
      if (!confirm(msg)) return;
      for (const c of old) await api("DELETE", `/api/schede/${c.id}`);
      await refresh(true);
      return toast(`Archivio svuotato: ${old.length} schede eliminate.`);
    }
    case "add-col": {
      const name = prompt("Nome della colonna");
      if (name?.trim()) await act("POST", "/api/colonne", { name: name.trim() });
      return;
    }
  }
  if (target.dataset.card) openCard(target.dataset.card);
});

document.getElementById("cerca").addEventListener("input", (e) => {
  S.query = e.target.value.trim();
  renderBoard();
});
document.getElementById("btn-etichette").addEventListener("click", (e) => labelsPop(e.currentTarget, null));
document.getElementById("btn-notifiche").addEventListener("click", (e) => notificationsPop(e.currentTarget));
document.getElementById("btn-installa").addEventListener("click", () => installApp());

/* ---------- Cronologia dei commenti del proprietario ---------- */

// Tutti i commenti scritti da te, dal più recente, con la scheda e la colonna dove stanno.
// Claude legge la stessa cronologia con `jb.py cronologia` a ogni buongiorno.
function myComments() {
  const found = [];
  for (const c of S.board.cards) {
    for (const m of c.comments) {
      if (m.author !== S.board.chi) continue;
      const parent = m.replyTo && c.comments.find((x) => x.id === m.replyTo);
      const answered = !m.replyTo && c.comments.some((r) => r.replyTo === m.id && r.author === "claude");
      found.push({ c, m, parent, answered });
    }
  }
  return found.sort((a, b) => (b.m.created > a.m.created ? 1 : -1));
}

function renderHistory() {
  const box = document.getElementById("cronologia");
  document.getElementById("btn-cronologia").classList.toggle("on", S.history);
  if (!S.history || !S.board) { box.hidden = true; box.innerHTML = ""; return; }
  const scroll = box.querySelector(".drawer-list")?.scrollTop || 0;
  const items = myComments();
  let day = "";
  const rows = items.map(({ c, m, parent, answered }) => {
    const d = new Date(m.created);
    const key = `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`}`;
    const head = key !== day ? `<h4 class="day">${key}</h4>` : "";
    day = key;
    const where = c.archived ? `archiviata in ${list(c.area)?.name || ""}` : list(c.list)?.name || "";
    const color = (c.archived ? list(c.area) : list(c.list))?.color || list(c.area)?.color || "";
    const state = m.replyTo
      ? `<span class="state">risposta${parent?.author === "claude" ? " a Claude" : ""}</span>`
      : `<span class="state ${m.resolved ? "resolved" : "open"}">${m.resolved ? "risolto" : "aperto"}</span>${answered ? '<span class="state resolved">Claude ha risposto</span>' : ""}`;
    return `${head}<button class="h-item" data-card="${c.id}">
      <span class="h-where"><span class="dot c-${color}"></span><b>${esc(c.title)}</b><span class="h-col">${esc(where)}</span></span>
      <span class="h-text md">${Md.render(m.text)}</span>
      <span class="h-meta"><time title="${esc(m.created)}">${d.toTimeString().slice(0, 5)}</time>${state}</span>
    </button>`;
  }).join("");
  box.innerHTML = `<div class="drawer-head"><h3>I tuoi commenti</h3><span class="count">${items.length}</span>
      <button class="icon-btn" data-h="close" aria-label="Chiudi">${icon("x")}</button></div>
    <div class="drawer-list">${rows || '<p class="empty">Non hai ancora scritto commenti.</p>'}</div>`;
  box.hidden = false;
  box.querySelector(".drawer-list").scrollTop = scroll;
}

function toggleHistory(open = !S.history) {
  S.history = open;
  store("cronologia", open);
  renderHistory();
}

document.getElementById("btn-cronologia").addEventListener("click", () => toggleHistory());
document.getElementById("cronologia").addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  if (e.target.closest('[data-h="close"]')) return toggleHistory(false);
  const item = e.target.closest("[data-card]");
  if (item) openCard(item.dataset.card);
});

/* ---------- Trascinamento (mouse e touch) ---------- */

const board = document.getElementById("bacheca");

/* ---------- Menu contestuale della scheda ----------
   Clic destro su una scheda: apri, priorità, allegato, archivia (o ripristina) ed elimina.
   Eliminare chiede conferma e si annulla come le altre modifiche, salvo che la scheda abbia file allegati. */
board.addEventListener("contextmenu", (e) => {
  const el = e.target.closest("[data-card]");
  if (!el) return;
  e.preventDefault();
  // Al telefono tenere premuto solleva la scheda: il menu di sistema (Android, ~0,5 s) non deve aprirsi.
  if (S.drag?.active || S.drag?.touch) return;
  cardMenu(el.dataset.card, e.clientX, e.clientY);
});

function cardMenu(id, x, y) {
  const c = card(id);
  if (!c) return;
  const at = { getBoundingClientRect: () => ({ left: x, top: y, bottom: y }) };
  const files = c.attachments.filter((a) => a.kind === "file").length;
  pop(at, `<div class="ctx" role="menu">
      <button class="ctx-item" data-x="open">${icon("desc")} Apri</button>
      <div class="ctx-label">Priorità</div>
      <div class="ctx-prio">${[1, 2, 3, 4, 5].map((n) => `<button class="prio p${n} ${prio(c) === n ? "on" : ""}" data-x="prio" data-n="${n}" title="${PRIORITIES[n]}">P${n}</button>`).join("")}
        <button class="ctx-none ${prio(c) ? "" : "on"}" data-x="prio" data-n="0" title="Nessuna priorità">${icon("x")}</button></div>
      <button class="ctx-item" data-x="file">${icon("clip")} Allegato…</button>
      ${c.archived
        ? `<button class="ctx-item" data-x="restore">${icon("restore")} Ripristina</button>`
        : `<button class="ctx-item" data-x="archive">${icon("archive")} Archivia</button>`}
      <button class="ctx-item danger" data-x="delete">${icon("trash")} Elimina</button>
    </div>`, (el) => {
    el.classList.add("pop-menu");
    el.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-x]");
      if (!b) return;
      closePop();
      const path = `/api/schede/${c.id}`;
      switch (b.dataset.x) {
        case "open": return openCard(c.id);
        case "prio": return act("PATCH", path, { priority: Number(b.dataset.n) });
        case "archive": return act("PATCH", path, { archived: true });
        case "restore": return act("PATCH", path, { archived: false });
        case "file": {
          const input = h('<input type="file" multiple hidden>');
          input.addEventListener("change", () => { upload(c, [...input.files]); input.remove(); });
          document.body.append(input);
          return input.click();
        }
        case "delete": {
          const msg = files
            ? `Eliminare definitivamente "${c.title}"? Ha ${files} file allegati: questa non si può annullare.`
            : `Eliminare "${c.title}"? Si può annullare per un'ora con Annulla (Ctrl+Z).`;
          if (!confirm(msg)) return;
          await act("DELETE", path);
          if (S.open === c.id) closeCard();
          return toast(files ? "Scheda eliminata." : "Scheda eliminata. Ctrl+Z per annullare.");
        }
      }
    });
  });
}

board.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".card");
  if (!el || e.button !== 0 || e.target.closest("button")) return;
  const touch = e.pointerType !== "mouse";
  S.drag = { el, id: el.dataset.card, x: e.clientX, y: e.clientY, moved: false, active: false, touch, pointer: e.pointerId };
  if (touch) S.drag.timer = setTimeout(() => { if (S.drag && !S.drag.moved) startDrag(e.clientX, e.clientY); }, LIFT_MS);
});
// Al telefono (23 novembre): tocco = apre la scheda; tenere premuto 0,7 s senza muoversi = la scheda si solleva
// e si trascina; muovere il dito prima = scorrere colonne e schede, senza toccare la scheda.
const LIFT_MS = 700;
const TOUCH_SLOP = 10;

function startDrag(x, y) {
  const d = S.drag;
  const r = d.el.getBoundingClientRect();
  d.active = true;
  d.moved = true;
  d.dx = x - r.left;
  d.dy = y - r.top;
  d.ghost = d.el.cloneNode(true);
  d.ghost.classList.add("drag-ghost");
  d.ghost.style.width = `${r.width}px`;
  document.body.append(d.ghost);
  d.placeholder = h(`<div class="placeholder" style="height:${r.height}px"></div>`);
  d.el.replaceWith(d.placeholder);
  document.body.classList.add("dragging");
  navigator.vibrate?.(15);
  moveDrag(x, y);
}

function moveDrag(x, y) {
  const d = S.drag;
  d.lastX = x;
  d.lastY = y;
  d.ghost.style.left = `${x - d.dx}px`;
  d.ghost.style.top = `${y - d.dy}px`;
  placeDrag(x, y);
  autoScroll();
}

// Mette il segnaposto sotto il puntatore, nel gruppo della sua priorità.
function placeDrag(x, y) {
  const d = S.drag;
  const under = document.elementFromPoint(x, y)?.closest(".col");
  if (under) {
    const box = under.querySelector(".cards");
    const others = [...box.querySelectorAll(".card:not(.hidden)")];
    const hit = others.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    // Si sposta solo tra le schede della stessa priorità: lo spazio si ferma ai bordi del suo gruppo.
    const rank = (el) => Number(el.dataset.prio) || 6;
    const mine = rank(d.el);
    const lo = others.filter((c) => rank(c) < mine).length;
    const hi = others.length - others.filter((c) => rank(c) > mine).length;
    const at = Math.max(lo, Math.min(hit === -1 ? others.length : hit, hi));
    if (at < others.length) box.insertBefore(d.placeholder, others[at]);
    else box.append(d.placeholder);
  }
}

function autoScroll() {
  const d = S.drag;
  cancelAnimationFrame(d.raf);
  const edge = 60;
  const step = () => {
    if (!S.drag?.active) return;
    const b = board.getBoundingClientRect();
    let sx = 0;
    if (d.lastX < b.left + edge) sx = -12; else if (d.lastX > b.right - edge) sx = 12;
    const box = d.placeholder.parentElement;
    let sy = 0;
    if (box) {
      const r = box.getBoundingClientRect();
      if (d.lastY < r.top + 40) sy = -10; else if (d.lastY > r.bottom - 40) sy = 10;
      if (sy) box.scrollTop += sy;
    }
    if (sx) board.scrollLeft += sx;
    if (sx || sy) { placeDrag(d.lastX, d.lastY); d.raf = requestAnimationFrame(step); }
  };
  d.raf = requestAnimationFrame(step);
}

document.addEventListener("pointermove", (e) => {
  const d = S.drag;
  if (!d || e.pointerId !== d.pointer) return;
  if (d.active) return moveDrag(e.clientX, e.clientY);
  const far = Math.hypot(e.clientX - d.x, e.clientY - d.y) > (d.touch ? TOUCH_SLOP : 6);
  if (!far) return;
  if (d.touch) { clearTimeout(d.timer); S.drag = null; return; } // era uno scorrimento
  startDrag(e.clientX, e.clientY);
});

// Durante il trascinamento su touch la pagina non deve scorrere.
document.addEventListener("touchmove", (e) => { if (S.drag?.active) e.preventDefault(); }, { passive: false });

async function endDrag(cancel) {
  const d = S.drag;
  if (!d) return;
  clearTimeout(d.timer);
  if (!d.active) { S.drag = null; if (S.stale) refresh(); return; }
  cancelAnimationFrame(d.raf);
  d.ghost.remove();
  document.body.classList.remove("dragging");
  const box = d.placeholder.parentElement;
  const listId = box?.dataset.list;
  const index = box ? [...box.children].filter((c) => c === d.placeholder || (c.classList.contains("card") && c.dataset.card !== d.id)).indexOf(d.placeholder) : -1;
  // La scheda resta dove è stata lasciata finché la scrittura non parte.
  d.placeholder.replaceWith(d.el);
  // Il click che segue il rilascio non deve aprire la scheda.
  setTimeout(() => { S.drag = null; }, 0);
  if (cancel || !listId) return refresh();
  await act("POST", `/api/schede/${d.id}/sposta`, { list: listId, index });
}
document.addEventListener("pointerup", (e) => { if (S.drag && e.pointerId === S.drag.pointer) endDrag(false); });
document.addEventListener("pointercancel", (e) => { if (S.drag && e.pointerId === S.drag.pointer) endDrag(true); });

/* ---------- Finestra della scheda ---------- */

function openCard(id) {
  if (location.hash !== `#c/${id}`) history.pushState(null, "", `#c/${id}`);
  S.open = id;
  renderModal({ force: true, top: true });
}

function closeCard() {
  S.open = null;
  S.descDraft = null;
  closePop();
  if (location.hash) history.pushState(null, "", location.pathname);
  renderModal({ force: true });
}

window.addEventListener("popstate", fromHash);
function fromHash() {
  const m = location.hash.match(/^#c\/(\w+)/);
  S.open = m && S.board && card(m[1]) ? m[1] : null;
  renderModal({ force: true, top: true });
}

function renderModal({ force = false, top = false } = {}) {
  const root = document.getElementById("modale");
  const c = S.open && card(S.open);
  if (!c) { root.innerHTML = ""; document.body.style.overflow = ""; return; }
  // Un aggiornamento dal server non deve interrompere quello che si sta scrivendo.
  const focused = root.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (!force && focused && document.activeElement.dataset.keep !== "0") { S.modalStale = true; return; }
  S.modalStale = false;
  const overlay = root.querySelector(".overlay");
  const scroll = overlay?.scrollTop || 0;
  const commentText = root.querySelector(".comment-new textarea")?.value;
  if (commentText !== undefined) S.commentDraft[c.id] = commentText;

  root.innerHTML = "";
  root.append(buildModal(c));
  root.querySelector(".overlay").scrollTop = top ? 0 : scroll;
  autoGrow(root.querySelector(".m-title"));
}

// Una modifica arrivata mentre si scriveva si mostra appena si esce dal campo, senza riaprire la scheda.
// Si aspetta che il clic sia finito: ridisegnare a metà farebbe sparire il pulsante sotto il dito.
let pressed = false;
// Un salvataggio partito dal blur ridisegna la scheda: si aspetta che il clic in corso arrivi al suo pulsante.
const afterPress = () => new Promise((resolve) => {
  if (!pressed) return resolve();
  const done = () => { document.removeEventListener("pointerup", done, true); document.removeEventListener("pointercancel", done, true); setTimeout(resolve, 0); };
  document.addEventListener("pointerup", done, true);
  document.addEventListener("pointercancel", done, true);
});
const flushModal = () => setTimeout(() => { if (S.modalStale && !pressed) renderModal(); }, 200);
document.addEventListener("pointerdown", () => { pressed = true; }, true);
document.addEventListener("pointerup", () => { pressed = false; flushModal(); }, true);
document.addEventListener("pointercancel", () => { pressed = false; flushModal(); }, true);
document.getElementById("modale").addEventListener("focusout", flushModal);

function autoGrow(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function buildModal(c) {
  const area = list(c.area);
  const here = list(c.list);
  const labels = c.labels.map(label).filter(Boolean);
  const inWeek = here?.kind === "week";
  // In "Aggiungi" resta solo quello che la scheda non ha ancora: il resto si cambia da dove è mostrato.
  // Gli allegati hanno la loro zona in fondo alla scheda.
  const adds = [
    !labels.length && `<button class="add-text" data-a="labels">${icon("plus")} Etichette</button>`,
    !c.due && `<button class="add-text" data-a="due">${icon("plus")} Scadenza</button>`,
    !prio(c) && `<button class="add-text" data-a="priority">${icon("plus")} Priorità</button>`,
    !c.checklists.length && `<button class="add-text" data-a="checklist">${icon("plus")} Checklist</button>`,
  ].filter(Boolean).join("");
  // Azioni in alto a destra, separate dalla X da uno spazio e una linea: non si premono per sbaglio chiudendo.
  const actions = c.archived
    ? `<button class="btn small ghost" data-a="restore">${icon("restore")} Ripristina</button>
       <button class="btn small ghost danger" data-a="delete">${icon("trash")} Elimina</button>`
    : `${inWeek
        ? `<button class="btn small ghost" data-a="unweek">${icon("back", "flip")} Togli dalla settimana</button>`
        : `<button class="btn small ghost" data-a="week">${icon("week")} Questa settimana</button>`}
       <button class="btn small ghost" data-a="archive">${icon("archive")} Archivia</button>`;
  const root = h(`<div class="overlay" data-close>
    <div class="modal" role="dialog" aria-modal="true">
      <div class="m-bar">
        <div class="m-acts">${actions}</div>
        <span class="m-sep" aria-hidden="true"></span>
        <button class="icon-btn m-close" data-a="close" aria-label="Chiudi" title="Chiudi">${icon("x")}</button>
      </div>
      <div class="m-head">
        <button class="check ${c.done ? "done" : ""}" data-a="done" aria-label="${c.done ? "Segna da fare" : "Segna completata"}" title="${c.done ? "Completata" : "Segna completata"}">${icon("check")}</button>
        <textarea class="m-title" rows="1" maxlength="300">${esc(c.title)}</textarea>
      </div>
      <div class="m-sub">
        ${c.archived ? `Archiviata in <b>${esc(area?.name || "")}</b>` : inWeek ? `In <b>Questa settimana</b> · ambito` : "Nella colonna"}
        ${c.archived ? "" : `<select data-a="area" aria-label="Ambito">${areas().map((a) => `<option value="${a.id}" ${a.id === c.area ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>`}
      </div>
      <div class="m-body">
        <div class="m-main">
          ${labels.length || c.due || prio(c) || adds ? `<div class="meta">
            ${labels.length ? `<div><h4>Etichette</h4><div class="labels">${labels.map((l) => `<button class="label c-${l.color}" data-a="labels">${esc(l.name)}</button>`).join("")}<button class="add-chip" data-a="labels" aria-label="Aggiungi etichetta">${icon("plus")}</button></div></div>` : ""}
            ${c.due ? `<div><h4>Scadenza</h4><button class="due-box" data-a="due">${formatDue(c.due)} <span class="chip ${dueClass(c.due, c.done)}">${c.done ? "completata" : dueLabel(c.due)}</span>${bells(c, true)}</button></div>` : ""}
            ${prio(c) ? `<div><h4>Priorità</h4><button class="due-box" data-a="priority"><span class="prio p${prio(c)}">P${prio(c)}</span> ${PRIORITIES[prio(c)]}</button></div>` : ""}
            ${adds ? `<div class="m-add"><h4>Aggiungi</h4><div class="m-add-row">${adds}</div></div>` : ""}
          </div>` : ""}
          <section class="desc"></section>
          <section class="checklists"></section>
          <section class="time-sec"></section>
          <section class="comments-sec"></section>
          <section class="attachments-sec"></section>
        </div>
      </div>
      <input type="file" multiple hidden>
    </div>
  </div>`);

  fillDesc(root.querySelector(".desc"), c);
  fillChecklists(root.querySelector(".checklists"), c);
  fillTime(root.querySelector(".time-sec"), c);
  fillAttachments(root.querySelector(".attachments-sec"), c);
  fillComments(root.querySelector(".comments-sec"), c);
  wireModal(root, c);
  return root;
}

// Campanella accanto alla scadenza quando ci sono notifiche; nella scheda aperta anche quante.
function bells(x, count = false) {
  const n = x.due && !x.done ? (x.reminders || []).length : 0;
  if (!n) return "";
  const names = x.reminders.map(reminderText).join(", ");
  return `<span class="bells" title="Notifiche: ${esc(names)}" aria-label="Notifiche: ${esc(names)}">${icon("bell")}${count && n > 1 ? n : ""}</span>`;
}

function dueLabel(value) {
  const diff = parseDue(value) - Date.now();
  if (diff < 0) return "scaduta";
  if (diff < DAY_MS) return "entro oggi";
  if (diff < 2 * DAY_MS) return "domani";
  return `tra ${Math.ceil(diff / DAY_MS)} giorni`;
}

function fillDesc(sec, c) {
  const draft = S.descDraft?.id === c.id ? S.descDraft : null;
  sec.innerHTML = `<div class="section-head">${icon("desc")}<h3>Descrizione</h3>
    ${c.desc && !draft ? '<button class="btn small" data-d="edit">Modifica</button>' : ""}</div>`;
  if (draft) {
    const ed = h(`<div class="editor">
      <div class="row" style="margin:0 0 6px"><div class="tabs">
        <button class="btn small ${draft.preview ? "" : "on"}" data-d="write">Scrivi</button>
        <button class="btn small ${draft.preview ? "on" : ""}" data-d="preview">Anteprima</button>
      </div></div>
      ${draft.preview ? `<div class="preview md">${Md.render(draft.text)}</div>` : `<textarea data-keep="1" placeholder="Markdown: **grassetto**, - elenchi, [ ] da fare, \`codice\`, link"></textarea>`}
      <div class="row"><button class="btn primary" data-d="save">Salva</button><button class="btn ghost" data-d="cancel">Annulla</button></div>
    </div>`);
    sec.append(ed);
    const ta = ed.querySelector("textarea");
    if (ta) {
      ta.value = draft.text;
      ta.style.height = `${Math.max(140, Math.min(ta.scrollHeight + 4, 480))}px`;
      ta.addEventListener("input", () => { draft.text = ta.value; });
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveDesc(c);
        if (e.key === "Escape") { e.stopPropagation(); S.descDraft = null; fillDesc(sec, c); }
      });
      setTimeout(() => ta.focus(), 0);
    }
  } else if (c.desc) {
    // Una descrizione lunga si apre solo a richiesta, per arrivare subito alle checklist.
    // "Mostra tutto" compare solo se il testo supera davvero l'altezza della parte chiusa.
    const open = S.descOpen.has(c.id);
    const view = h(`<div class="desc-view md ${open ? "" : "clamped"}" data-d="edit">${Md.render(c.desc)}</div>`);
    sec.append(view);
    const more = h(`<button class="btn small desc-more" data-d="more" hidden>${open ? "Mostra meno" : "Mostra tutto"}</button>`);
    sec.append(more);
    if (open) more.hidden = false;
    else requestAnimationFrame(() => {
      if (view.scrollHeight > view.clientHeight + 4) more.hidden = false;
      else view.classList.remove("clamped");
    });
  } else {
    sec.append(h(`<div class="desc-empty" data-d="edit">Aggiungi una descrizione</div>`));
  }
  sec.onclick = (e) => {
    if (e.target.closest("a")) return;
    const b = e.target.closest("[data-d]");
    if (!b) return;
    const kind = b.dataset.d;
    if (kind === "more") { if (S.descOpen.has(c.id)) S.descOpen.delete(c.id); else S.descOpen.add(c.id); }
    if (kind === "edit") S.descDraft = { id: c.id, text: c.desc, preview: false };
    if (kind === "write") S.descDraft.preview = false;
    if (kind === "preview") S.descDraft.preview = true;
    if (kind === "cancel") S.descDraft = null;
    if (kind === "save") return saveDesc(c);
    fillDesc(sec, c);
  };
}

async function saveDesc(c) {
  const text = S.descDraft.text;
  await api("PATCH", `/api/schede/${c.id}`, { desc: text });
  S.descDraft = null;
  await refresh(true);
}

function fillChecklists(sec, c) {
  sec.innerHTML = "";
  for (const cl of c.checklists) {
    const counted = leaves(cl.items);
    const total = counted.length;
    const done = counted.filter((i) => i.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    // Albero delle voci: figlie sotto la madre, rientrate; l'ordine tra sorelle è quello dell'elenco.
    const kids = (id) => cl.items.filter((i) => (i.parent || "") === id);
    const row = (i, d, prev) => cl.hideDone && i.done ? "" : `
        <div class="item ${i.done ? "done" : ""} ${kids(i.id).length ? "has-kids" : ""}" data-item="${i.id}" style="--depth:${d}">
          <input type="checkbox" ${i.done ? "checked" : ""} data-keep="0" aria-label="Fatto">
          <span class="txt md" data-c="edit">${inlineMd(i.text)}</span>
          ${i.due ? `<span class="chip ${dueClass(i.due, i.done)}" data-c="due">${icon("clock")}${formatDue(i.due)}${bells(i)}</span>` : ""}
          <button class="icon-btn item-more" data-c="menu" aria-label="Azioni della voce" title="Azioni"
            data-sub="${d < MAX_DEPTH - 1 ? 1 : ""}" data-out="${i.parent ? 1 : ""}"
            data-prev="${prev && d + 1 + subDepth(i) < MAX_DEPTH ? prev.id : ""}">${icon("dots")}</button>
        </div>${branch(i.id, d + 1)}`;
    const subDepth = (i) => Math.max(0, ...kids(i.id).map((k) => 1 + subDepth(k)));
    const branch = (id, d) => kids(id).map((i, n, all) => row(i, d, all[n - 1])).join("");
    const block = h(`<div class="checklist" data-cl="${cl.id}">
      <div class="section-head">${icon("list")}<h3 data-c="rename">${esc(cl.title)}</h3>
        ${done ? `<button class="btn small" data-c="hide">${cl.hideDone ? `Mostra completate (${done})` : "Nascondi completate"}</button>` : ""}
        <button class="btn small" data-c="delete">Elimina</button>
      </div>
      <div class="progress"><span>${pct}%</span><div class="bar"><i style="width:${pct}%"></i></div></div>
      <div class="items">${branch("", 0)}</div>
      <div class="add-item" style="margin-top:6px"><button class="btn small" data-c="add">Aggiungi un elemento</button></div>
    </div>`);
    sec.append(block);
  }
  sec.onchange = async (e) => {
    const box = e.target.closest(".item input[type=checkbox]");
    if (!box) return;
    const clId = box.closest("[data-cl]").dataset.cl;
    const itemId = box.closest("[data-item]").dataset.item;
    await act("PATCH", `/api/schede/${c.id}/checklist/${clId}/voci/${itemId}`, { done: box.checked });
  };
  sec.onclick = async (e) => {
    if (e.target.closest("a")) return;
    const b = e.target.closest("[data-c]");
    if (!b) return;
    switch (b.dataset.c) {
      case "menu": {
        // Un solo ⋯ per voce: scadenza, sotto-voci, rientri ed eliminazione stanno qui.
        const cl = c.checklists.find((x) => x.id === b.closest("[data-cl]").dataset.cl);
        const item = cl.items.find((i) => i.id === b.closest("[data-item]").dataset.item);
        const entries = [
          ["due", "clock", item.due ? "Cambia scadenza" : "Scadenza"],
          b.dataset.sub && ["sub", "sub", "Aggiungi sottovoce"],
          b.dataset.prev && ["in", "indent", "Metti sotto la voce sopra"],
          b.dataset.out && ["out", "outdent", "Sposta fuori di un livello"],
          ["del", "trash", "Elimina", "danger"],
        ].filter(Boolean);
        return pop(b, `<div class="ctx" role="menu">${entries.map(([v, ic, text, cls]) =>
          `<button class="ctx-item ${cls || ""}" data-v="${v}">${icon(ic)} ${text}</button>`).join("")}</div>`, (el) => {
          el.classList.add("pop-menu", "pop-narrow");
          el.addEventListener("click", (ev) => {
            const v = ev.target.closest("[data-v]")?.dataset.v;
            if (!v) return;
            closePop();
            run(v, b);
          });
        });
      }
      default: return run(b.dataset.c, b);
    }
  };
  // Le azioni sulle voci e sulle checklist: b è il pulsante (o la riga) da cui partono.
  const run = async (action, b) => {
    const clId = b.closest("[data-cl]").dataset.cl;
    const cl = c.checklists.find((x) => x.id === clId);
    const itemId = b.closest("[data-item]")?.dataset.item;
    const base = `/api/schede/${c.id}/checklist/${clId}`;
    switch (action) {
      case "delete":
        if (confirm(`Eliminare la checklist "${cl.title}"?`)) await act("DELETE", base);
        return;
      case "hide": return act("PATCH", base, { hideDone: !cl.hideDone });
      case "del": {
        const n = cl.items.filter((x) => x.parent === itemId).length;
        if (n && !confirm("Eliminare la voce con tutte le sue sotto-voci?")) return;
        return act("DELETE", `${base}/voci/${itemId}`);
      }
      case "sub": return addItems(subSlot(b.closest("[data-item]")), base, itemId);
      case "out": {
        const item = cl.items.find((i) => i.id === itemId);
        const up = cl.items.find((i) => i.id === item.parent);
        return act("PATCH", `${base}/voci/${itemId}`, { parent: up?.parent || "" });
      }
      case "in": return act("PATCH", `${base}/voci/${itemId}`, { parent: b.dataset.prev });
      case "due": {
        const item = cl.items.find((i) => i.id === itemId);
        return duePop(b, item.due, item.reminders, "voci", (due, reminders) => act("PATCH", `${base}/voci/${itemId}`, { due, reminders }));
      }
      case "rename": return inlineEdit(b, cl.title, (title) => act("PATCH", base, { title }), "title-input");
      case "edit": {
        const item = cl.items.find((i) => i.id === itemId);
        return inlineEdit(b, item.text, (text) => act("PATCH", `${base}/voci/${itemId}`, { text }));
      }
      case "add": return addItems(b.parentElement, base);
    }
  };
}

function inlineMd(text) {
  // Una voce di checklist è una riga: niente paragrafi.
  return Md.render(text).replace(/^<p>|<\/p>$/g, "");
}

function inlineEdit(el, value, onSave, cls = "") {
  const wrap = h(`<div class="item-edit"><textarea rows="1" class="${cls}" data-keep="1"></textarea>
    <div class="row" style="display:flex;gap:6px;margin-top:4px"><button class="btn primary small">Salva</button><button class="btn ghost small">Annulla</button></div></div>`);
  const ta = wrap.querySelector("textarea");
  ta.value = value;
  el.replaceWith(wrap);
  autoGrow(ta);
  ta.focus();
  ta.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const v = ta.value.trim();
    if (save && v && v !== value) await onSave(v);
    else renderModal({ force: true });
  };
  ta.addEventListener("input", () => autoGrow(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.stopPropagation(); finish(false); }
  });
  const [save, cancel] = wrap.querySelectorAll("button");
  save.addEventListener("mousedown", (e) => e.preventDefault());
  save.onclick = () => finish(true);
  cancel.addEventListener("mousedown", (e) => e.preventDefault());
  cancel.onclick = () => finish(false);
  ta.addEventListener("blur", () => setTimeout(() => finish(true), 120));
}

// Il campo per le sotto-voci si apre sotto la voce e le sue sotto-voci, rientrato di un livello.
function subSlot(row) {
  const d = Number(row.style.getPropertyValue("--depth")) || 0;
  let last = row;
  while (last.nextElementSibling && Number(last.nextElementSibling.style.getPropertyValue("--depth")) > d) last = last.nextElementSibling;
  const slot = h(`<div class="add-item sub-add" style="--depth:${d + 1}"></div>`);
  last.after(slot);
  return slot;
}

function addItems(slot, base, parent = "") {
  slot.innerHTML = `<div class="item-edit"><textarea rows="1" data-keep="1" placeholder="${parent ? "Aggiungi una sottovoce" : "Aggiungi un elemento"}"></textarea>
    <div style="display:flex;gap:6px;margin-top:4px"><button class="btn primary small">Aggiungi</button><button class="btn ghost small">Chiudi</button></div></div>`;
  const ta = slot.querySelector("textarea");
  ta.focus();
  const add = async () => {
    // Incollare più righe crea più voci; un elenco rientrato (due spazi o un tab per livello) crea le sotto-voci.
    const rows = ta.value.split("\n").filter((l) => l.trim()).map((l) => {
      const lead = l.match(/^[\t ]*/)[0].replace(/\t/g, "  ").length;
      return { lead, text: l.replace(/^\s*([-*+]|\d+[.)])?\s*(\[[ xX]?\]\s*)?/, "").trim() };
    }).filter((r) => r.text);
    if (!rows.length) return;
    const leads = [...new Set(rows.map((r) => r.lead))].sort((a, b) => a - b);
    ta.value = "";
    await api("POST", `${base}/voci`, { texts: rows.map((r) => r.text), depths: rows.map((r) => leads.indexOf(r.lead)), parent });
    await refresh(true);
    const clId = base.split("/").pop();
    const row = parent && document.querySelector(`[data-cl="${clId}"] [data-item="${parent}"]`);
    const again = row ? subSlot(row) : document.querySelector(`[data-cl="${clId}"] .add-item`);
    if (again) addItems(again, base, parent);
  };
  ta.addEventListener("input", () => autoGrow(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); add(); }
    if (e.key === "Escape") { e.stopPropagation(); renderModal({ force: true }); }
  });
  const [ok, close] = slot.querySelectorAll("button");
  ok.onclick = add;
  close.onclick = () => renderModal({ force: true });
}

function fillTime(sec, c) {
  const { days, focus, agents } = timeTotals(c);
  if (!days.length) { sec.innerHTML = ""; return; }
  const top = Math.max(...days.map((d) => d.focus + d.agents), 1);
  sec.innerHTML = `<div class="section-head">${icon("timer")}<h3>Tempo</h3>
      <span class="time-total"><b>${minutes(focus)}</b> focus · ${minutes(agents)} agenti</span></div>
    <div class="time-days">${[...days].reverse().map((d) => {
      const [y, m, day] = d.date.split("-").map(Number);
      const label = `${day} ${MONTHS[m - 1]}${y === new Date().getFullYear() ? "" : ` ${y}`}`;
      return `<div class="time-day"><span class="when">${label}</span>
        <span class="bar" title="focus ${d.focus} min, agenti ${d.agents} min"><i class="f" style="width:${(d.focus / top) * 100}%"></i><i class="a" style="width:${(d.agents / top) * 100}%"></i></span>
        <span class="nums">${minutes(d.focus)} · ${minutes(d.agents)}</span></div>`;
    }).join("")}</div>
    <div class="time-legend"><span><i class="f"></i>focus</span><span><i class="a"></i>agenti</span></div>`;
}

// Zona allegati in fondo alla scheda: c'è sempre, si clicca per scegliere i file o ci si trascinano sopra
// (trascinarli in qualsiasi punto della scheda funziona lo stesso).
function fillAttachments(sec, c) {
  sec.innerHTML = `<div class="section-head">${icon("clip")}<h3>Allegati</h3></div>
    <button class="attach-zone" data-x="add">${icon("clip")}<span>Trascina qui i file o <u>sceglili</u></span><small>fino a 10 MB l'uno, anche immagini incollate</small></button>
    <div class="attachments">${[...c.attachments].reverse().map((a) => {
      const isImage = a.type.startsWith("image/") && a.type !== "image/svg+xml";
      const isFile = a.kind === "file";
      const open = isFile ? `href="#" data-x="open"` : `href="${esc(a.url)}" target="_blank" rel="noopener noreferrer"`;
      const ext = isFile ? esc((a.name.split(".").pop() || "file").slice(0, 4)) : icon("link");
      return `<div class="attachment" data-att="${a.id}">
        <a class="thumb" ${open}>${isImage ? `<img data-blob="${a.id}" alt="">` : ext}</a>
        <div class="info">
          <a class="name" ${open}>${esc(a.name)}</a>
          <div class="sub"><span>${ago(a.created)}</span>${a.size ? `<span>${size(a.size)}</span>` : ""}
            ${isFile ? `<a href="#" data-x="download" style="color:inherit">Scarica</a>` : ""}
            <button data-x="del">Elimina</button></div>
        </div>
      </div>`;
    }).join("")}</div>`;
  for (const img of sec.querySelectorAll("img[data-blob]")) {
    Store.fileBlob(img.dataset.blob).then((blob) => { img.src = blobUrl(img.dataset.blob, blob); }).catch(() => {});
  }
  sec.onclick = async (e) => {
    const b = e.target.closest("[data-x]");
    if (!b) return;
    e.preventDefault();
    if (b.dataset.x === "add") return sec.closest(".modal").querySelector("input[type=file]").click();
    const id = b.closest("[data-att]").dataset.att;
    const a = c.attachments.find((x) => x.id === id);
    if (b.dataset.x === "open" || b.dataset.x === "download") return openFile(a, b.dataset.x === "download");
    if (confirm(`Eliminare l'allegato "${a.name}"?`)) await act("DELETE", `/api/schede/${c.id}/allegati/${id}`);
  };
}

const blobUrls = new Map();
function blobUrl(id, blob) {
  if (!blobUrls.has(id)) blobUrls.set(id, URL.createObjectURL(blob));
  return blobUrls.get(id);
}

// I tipi sicuri si aprono in una scheda nuova; il resto si scarica, cosi' un file HTML non gira sul nostro dominio.
async function openFile(a, download) {
  const inline = !download && Store.INLINE_TYPES.has(a.type);
  const win = inline ? window.open("", "_blank") : null;
  try {
    const url = blobUrl(a.id, await Store.fileBlob(a.id));
    if (win) { win.location.href = url; return; }
    const link = h(`<a download="${esc(a.name)}" href="${url}"></a>`);
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) {
    win?.close();
    toast(error instanceof Store.HttpError ? error.message : failure(error));
  }
}

async function upload(c, files) {
  const problems = [];
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) { problems.push(`${file.name}: oltre 10 MB`); continue; }
    toast(`Carico ${file.name}…`);
    try {
      await Store.call("POST", `/api/schede/${c.id}/allegati`, undefined, { body: file, type: file.type, name: file.name || "incollato.png" });
    } catch (error) {
      problems.push(`${file.name}: ${error instanceof Store.HttpError ? error.message : failure(error)}`);
    }
  }
  if (problems.length) toast(problems.join(" · "));
  else document.getElementById("toast").hidden = true;
  await refresh(true);
}

function fillComments(sec, c) {
  const top = c.comments.filter((m) => !m.replyTo).reverse();
  const replies = (id) => c.comments.filter((m) => m.replyTo === id);
  const one = (m, isReply) => {
    const claude = m.author === "claude";
    const isMine = m.author === S.board.chi;
    const state = m.author === "utente" && !isReply
      ? `<span class="state ${m.resolved ? "resolved" : "open"}">${m.resolved ? "risolto" : "aperto"}</span>` : "";
    // I commenti di Claude restano da valutare finché il proprietario non li segna validi (resolved).
    const verdict = claude
      ? `<span class="state ${m.resolved ? "resolved" : "open"}">${m.resolved ? "valido" : "da valutare"}</span>` : "";
    return `<div class="comment ${m.author === "utente" && !m.resolved && !isReply ? "open" : ""}" data-cm="${m.id}">
      <div class="avatar ${claude ? "claude" : ""}">${claude ? "C" : "G"}</div>
      <div class="body">
        <div class="who"><b>${claude ? "Claude" : esc(OWNER)}</b><time title="${esc(m.created)}">${ago(m.created)}${m.edited ? " · modificato" : ""}</time>${state}${verdict}
          <button class="trash-btn" data-m="delete" title="Elimina il commento" aria-label="Elimina il commento">${icon("trash")}</button></div>
        <div class="bubble md">${Md.render(m.text)}</div>
        <div class="acts">
          ${!isReply ? '<button data-m="reply">Rispondi</button>' : ""}
          ${m.author === "utente" && !isReply ? `<button data-m="resolve">${m.resolved ? "Riapri" : "Segna risolto"}</button>` : ""}
          ${claude ? `<button data-m="resolve">${m.resolved ? "Da rivalutare" : "Valido"}</button>` : ""}
          ${isMine ? '<button data-m="edit">Modifica</button>' : ""}
        </div>
        ${!isReply && replies(m.id).length ? `<div class="replies">${replies(m.id).map((r) => one(r, true)).join("")}</div>` : ""}
      </div>
    </div>`;
  };
  sec.innerHTML = `<div class="section-head">${icon("chat")}<h3>Commenti</h3></div>
    <div class="comment-new"><div class="avatar">G</div><div class="editor">
      <textarea placeholder="Scrivi un commento (markdown)" data-keep="1"></textarea>
      <div class="row" hidden><button class="btn primary" data-m="send">Commenta</button><button class="btn ghost" data-m="preview">Anteprima</button></div>
      <div class="preview md" hidden></div>
    </div></div>
    <div class="comments">${top.map((m) => one(m, false)).join("")}</div>`;
  const ta = sec.querySelector(".comment-new textarea");
  const row = sec.querySelector(".comment-new .row");
  const preview = sec.querySelector(".comment-new .preview");
  ta.value = S.commentDraft[c.id] || "";
  const show = () => { row.hidden = !ta.value && document.activeElement !== ta; autoGrow(ta); };
  show();
  ta.addEventListener("focus", () => { row.hidden = false; });
  ta.addEventListener("blur", () => setTimeout(show, 150));
  ta.addEventListener("input", () => { S.commentDraft[c.id] = ta.value; autoGrow(ta); if (!preview.hidden) preview.innerHTML = Md.render(ta.value); });
  const send = async () => {
    const text = ta.value.trim();
    if (!text) return;
    S.commentDraft[c.id] = "";
    ta.value = "";
    ta.blur();
    await act("POST", `/api/schede/${c.id}/commenti`, { text });
  };
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); });
  sec.onclick = async (e) => {
    if (e.target.closest("a")) return;
    const b = e.target.closest("[data-m]");
    if (!b) return;
    const id = b.closest("[data-cm]")?.dataset.cm;
    const m = c.comments.find((x) => x.id === id);
    const base = `/api/schede/${c.id}/commenti`;
    switch (b.dataset.m) {
      case "send": return send();
      case "preview":
        preview.hidden = !preview.hidden;
        preview.innerHTML = Md.render(ta.value);
        b.textContent = preview.hidden ? "Anteprima" : "Nascondi anteprima";
        return ta.focus();
      case "resolve": return act("PATCH", `${base}/${id}`, { resolved: !m.resolved });
      case "delete": {
        const n = replies(id).length;
        if (confirm(n ? `Eliminare il commento e ${n === 1 ? "la sua risposta" : `le sue ${n} risposte`}?` : "Eliminare il commento?")) await act("DELETE", `${base}/${id}`);
        return;
      }
      case "edit": {
        const bubble = b.closest(".body").querySelector(".bubble");
        return inlineEdit(bubble, m.text, (text) => act("PATCH", `${base}/${id}`, { text }));
      }
      case "reply": {
        const acts = b.closest(".acts");
        const slot = h('<div style="margin-top:6px"></div>');
        acts.after(slot);
        acts.hidden = true;
        const span = h("<span></span>");
        slot.append(span);
        return inlineEdit(span, "", (text) => act("POST", base, { text, replyTo: id }));
      }
    }
  };
}

function wireModal(root, c) {
  const title = root.querySelector(".m-title");
  title.addEventListener("input", () => autoGrow(title));
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } });
  title.addEventListener("blur", async () => {
    const v = title.value.trim();
    if (!v) { title.value = c.title; autoGrow(title); return; }
    if (v === c.title) return;
    await afterPress();
    await act("PATCH", `/api/schede/${c.id}`, { title: v });
  });

  const fileInput = root.querySelector("input[type=file]");
  fileInput.addEventListener("change", () => { upload(c, [...fileInput.files]); fileInput.value = ""; });

  root.querySelector('[data-a="area"]')?.addEventListener("change", (e) => act("PATCH", `/api/schede/${c.id}`, { area: e.target.value }));

  // Chiude solo un click iniziato e finito sullo sfondo, non una selezione di testo che ci esce.
  let fromBackdrop = false;
  root.addEventListener("pointerdown", (e) => { fromBackdrop = e.target.matches("[data-close]"); });
  root.addEventListener("click", async (e) => {
    if (e.target.matches("[data-close]")) { if (fromBackdrop) closeCard(); return; }
    const b = e.target.closest("[data-a]");
    if (!b || b.tagName === "SELECT") return;
    switch (b.dataset.a) {
      case "close": return closeCard();
      case "done": return act("PATCH", `/api/schede/${c.id}`, { done: !c.done });
      case "labels": return labelsPop(b, c);
      case "due": return duePop(b, c.due, c.reminders, "schede", (due, reminders) => act("PATCH", `/api/schede/${c.id}`, { due, reminders }));
      case "priority": return priorityPop(b, prio(c), (priority) => act("PATCH", `/api/schede/${c.id}`, { priority }));
      case "file": return fileInput.click();
      case "checklist":
        return pop(b, `<h4>Nuova checklist</h4><div class="stack"><input class="field" type="text" value="Checklist" maxlength="200"><button class="btn primary">Aggiungi</button></div>`, (el) => {
          const input = el.querySelector("input");
          setTimeout(() => input.select(), 0);
          const go = async () => {
            closePop();
            const cl = await act("POST", `/api/schede/${c.id}/checklist`, { title: input.value.trim() || "Checklist" });
            const slot = document.querySelector(`[data-cl="${cl.id}"] .add-item`);
            if (slot) addItems(slot, `/api/schede/${c.id}/checklist/${cl.id}`);
          };
          el.querySelector("button").onclick = go;
          input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go(); });
        });
      case "week": return act("POST", `/api/schede/${c.id}/sposta`, { list: "settimana" });
      case "unweek": return act("POST", `/api/schede/${c.id}/sposta`, { list: c.area });
      case "archive": await act("PATCH", `/api/schede/${c.id}`, { archived: true }); return closeCard();
      case "restore": return act("PATCH", `/api/schede/${c.id}`, { archived: false });
      case "delete":
        if (!confirm(`Eliminare definitivamente "${c.title}" con allegati e commenti?`)) return;
        await act("DELETE", `/api/schede/${c.id}`);
        return closeCard();
    }
  });

  // Trascinare file sulla scheda li allega; anche incollare un'immagine.
  const modal = root.querySelector(".modal");
  let depth = 0;
  modal.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    if (depth++ === 0) modal.append(h('<div class="drop-hint">Rilascia per allegare</div>'));
  });
  modal.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
  modal.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; modal.querySelector(".drop-hint")?.remove(); } });
  modal.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    depth = 0;
    modal.querySelector(".drop-hint")?.remove();
    upload(c, [...e.dataTransfer.files]);
  });
}

document.addEventListener("paste", (e) => {
  const c = S.open && card(S.open);
  if (!c) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  upload(c, files);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (popEl) return closePop();
  if (S.open && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return closeCard();
  if (!S.open && S.history) toggleHistory(false);
});
document.addEventListener("pointerdown", (e) => {
  if (!popEl || popEl.contains(e.target)) return;
  const anchor = popEl.anchor;
  closePop();
  // Clic sullo stesso pulsante: il popover resta chiuso invece di riaprirsi subito.
  if (anchor instanceof Element && anchor.contains(e.target)) {
    popClosedFrom = anchor;
    setTimeout(() => { if (popClosedFrom === anchor) popClosedFrom = null; }, 400);
  }
}, true);

/* ---------- Vista Tempo ---------- */

// Ore per area e per task, settimana per settimana, dai minuti che Claude carica con `jb.py ore`.
// Colori dei grafici verificati per il daltonismo: sono toni vicini a quelli delle colonne, non gli stessi.
// Ambiti dalla config ("areas", nell'ordine dei colori --a-p1 … --a-p6) più "Altro".
const AREAS = [
  ...(CONFIG.areas || []).map((a) => ({ id: a.id, name: a.name })),
  { id: "altro", name: "Altro", hint: "organizzazione, svago e non classificato", other: true },
];
// Regole della config: i codici di un ambito che vanno in un altro (per esempio "^T\\d" → "tesisti").
const AREA_RULES = (CONFIG.area_rules || []).map((r) => ({ area: r.area, re: new RegExp(r.code_regex), to: r.to }));
{
  const style = document.createElement("style");
  style.textContent = AREAS.filter((a) => !a.other)
    .map((a, i) => `.a-${a.id} { background: var(--a-p${(i % 6) + 1}); }`).join("\n");
  document.head.append(style);
}
const WEEKDAYS = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
const T = { data: null, week: null, measure: load("tempo.misura", "focus"), others: load("tempo.altro", false) };

function areaOf(row) {
  const rule = AREA_RULES.find((r) => r.area === row.area && r.re.test(row.code || ""));
  if (rule) return rule.to;
  const id = (row.area || "").toLowerCase();
  return AREAS.some((a) => a.id === id && !a.other) ? id : "altro";
}
function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function hoursLabel(m) {
  m = Math.round(m);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}` : `${m / 60}h`;
}
// La scheda del progetto: il titolo comincia con il codice ("L2 Sito nuovo").
function cardForCode(code) {
  if (!S.board || !/^[A-Z]+\d/.test(code)) return null;
  const exact = new RegExp(`^${code}(\\s|$)`);
  const loose = new RegExp(`^${code}\\b`);
  const pick = (re) => S.board.cards.filter((c) => re.test(c.title)).sort((a, b) => a.archived - b.archived)[0];
  return pick(exact) || pick(loose) || null;
}

function setView(view) {
  if (!["bacheca", "tempo", "agenti"].includes(view)) view = "bacheca";
  S.view = view;
  store("vista", view);
  tip.hidden = true;
  document.querySelectorAll(".views [data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  document.getElementById("bacheca").hidden = view !== "bacheca";
  document.getElementById("tempo").hidden = view !== "tempo";
  document.getElementById("agenti").hidden = view !== "agenti";
  document.body.classList.toggle("view-tempo", view === "tempo");
  document.body.classList.toggle("view-agenti", view === "agenti");
  if (view === "tempo") {
    renderTime();
    // Le ore cambiano una volta al giorno: si ricaricano a ogni apertura della vista.
    Store.hours().then((data) => { T.data = data; if (S.view === "tempo") renderTime(); })
      .catch((error) => { if (!T.data) { T.error = failure(error); renderTime(); } });
  }
  if (view === "agenti") {
    renderAgents();
    Store.agents().then((data) => {
      A.data = data;
      A.error = null;
      if (S.view === "agenti") renderAgents();
    }, (error) => {
      if (!A.data) {
        A.error = failure(error);
        if (S.view === "agenti") renderAgents();
      }
    });
  }
}

function renderTime() {
  const root = document.getElementById("tempo");
  // Ridisegnare toglie il focus: si rimette sul pulsante premuto, così con la tastiera si può ripremere.
  const keep = root.contains(document.activeElement) && document.activeElement.dataset.t;
  drawTime(root);
  if (keep) (root.querySelector(`[data-t="${keep}"]:not(:disabled)`) || root.querySelector(".tv-nav [data-t]:not(:disabled)"))?.focus();
}

function drawTime(root) {
  if (!T.data) {
    root.innerHTML = `<p class="tv-empty">${T.error ? esc(T.error) : "Carico le ore…"}</p>`;
    return;
  }
  if (!T.week) T.week = mondayOf(new Date());
  const today = isoDay(new Date());
  const days = [...Array(7)].map((_, i) => new Date(T.week.getFullYear(), T.week.getMonth(), T.week.getDate() + i));
  const byDate = new Map(T.data.map((d) => [d.date, d.rows]));
  const key = T.measure;
  const shown = AREAS.filter((a) => T.others || !a.other);
  const visible = new Set(shown.map((a) => a.id));

  const cols = days.map((d) => {
    const per = {};
    for (const r of byDate.get(isoDay(d)) || []) {
      const a = areaOf(r);
      if (visible.has(a)) per[a] = (per[a] || 0) + r[key];
    }
    return { d, iso: isoDay(d), per, total: Object.values(per).reduce((s, v) => s + v, 0) };
  });
  const tasks = new Map();
  for (const c of cols) {
    for (const r of byDate.get(c.iso) || []) {
      const a = areaOf(r);
      if (!visible.has(a) || !r[key]) continue;
      const t = tasks.get(r.code) || { code: r.code, name: r.name, area: a, min: 0, days: 0 };
      t.min += r[key];
      t.days += 1;
      tasks.set(r.code, t);
    }
  }
  const taskList = [...tasks.values()].sort((a, b) => b.min - a.min);
  const areaTotals = shown.map((a) => ({ ...a, min: cols.reduce((s, c) => s + (c.per[a.id] || 0), 0) }));
  const total = areaTotals.reduce((s, a) => s + a.min, 0);
  const maxDay = Math.max(60, ...cols.map((c) => c.total));
  const hoursMax = maxDay / 60;
  const step = (hoursMax <= 4 ? 1 : hoursMax <= 8 ? 2 : hoursMax <= 16 ? 4 : 6) * 60;
  const top = Math.ceil(maxDay / step) * step;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const first = days[0];
  const last = days[6];
  // L'anno si mostra se non è quello in corso; a cavallo d'anno su entrambi i capi.
  const year = (d) => (first.getFullYear() !== last.getFullYear() || d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "");
  const range = first.getFullYear() !== last.getFullYear()
    ? `${first.getDate()} ${MONTHS[first.getMonth()]}${year(first)} – ${last.getDate()} ${MONTHS[last.getMonth()]}${year(last)}`
    : first.getMonth() === last.getMonth()
      ? `${first.getDate()} – ${last.getDate()} ${MONTHS[last.getMonth()]}${year(last)}`
      : `${first.getDate()} ${MONTHS[first.getMonth()]} – ${last.getDate()} ${MONTHS[last.getMonth()]}${year(last)}`;
  const thisWeek = isoDay(T.week) === isoDay(mondayOf(new Date()));
  const hasData = T.data.length > 0;
  const earliest = hasData ? mondayOf(new Date(`${T.data[0].date}T12:00`)) : T.week;
  const measureName = key === "focus" ? "focus" : "agenti";
  const maxTask = Math.max(1, ...taskList.map((t) => t.min));

  root.innerHTML = `<div class="tv">
    <div class="tv-bar">
      <div class="tv-nav">
        <button class="icon-btn" data-t="prev" aria-label="Settimana precedente" ${T.week <= earliest ? "disabled" : ""}>${icon("chev", "flip")}</button>
        <h2>${range}</h2>
        <button class="icon-btn" data-t="next" aria-label="Settimana successiva" ${thisWeek ? "disabled" : ""}>${icon("chev")}</button>
        ${thisWeek ? "" : '<button class="btn small" data-t="now">Questa settimana</button>'}
      </div>
      <div class="seg" role="group" aria-label="Misura">
        <button data-t="focus" aria-pressed="${key === "focus"}">Focus</button>
        <button data-t="agents" aria-pressed="${key === "agents"}">Agenti</button>
      </div>
      <label class="tv-check"><input type="checkbox" data-t="others" ${T.others ? "checked" : ""}> Anche organizzazione e svago</label>
    </div>

    <div class="tv-summary">
      <div class="tv-total"><span>Settimana, ${measureName}</span><b>${hoursLabel(total)}</b></div>
      <ul class="tv-legend">${areaTotals.map((a) => `<li title="${esc(a.hint || a.name)}">
        <i class="sw a-${a.id}"></i><span>${esc(a.name)}</span><b>${hoursLabel(a.min)}</b>
        <span class="pct">${total ? Math.round((a.min / total) * 100) : 0}%</span></li>`).join("")}</ul>
    </div>

    <div class="tv-chart" role="img" aria-label="Ore di ${measureName} per giorno e per area, settimana ${range}">
      <div class="tv-plot">
        ${ticks.map((v) => `<div class="tv-grid" style="bottom:${(v / top) * 100}%"><span>${v ? `${v / 60}h` : "0"}</span></div>`).join("")}
        <div class="tv-cols">${cols.map((c, i) => `<div class="tv-col" data-day="${i}">
          ${c.total ? `<span class="tv-coltotal">${hoursLabel(c.total)}</span>` : ""}
          <div class="tv-stack" style="height:${(c.total / top) * 100}%">${shown.filter((a) => c.per[a.id])
            .map((a) => `<i class="a-${a.id}" style="flex-grow:${c.per[a.id]}" data-tip="${esc(a.name)} · ${hoursLabel(c.per[a.id])}"></i>`).join("")}</div>
        </div>`).join("")}</div>
      </div>
      <div class="tv-days">${cols.map((c, i) => `<span class="${c.iso === today ? "today" : ""} ${c.iso > today ? "future" : ""}">${WEEKDAYS[i]} ${c.d.getDate()}</span>`).join("")}</div>
    </div>

    <h3 class="tv-h">Per task</h3>
    ${taskList.length ? `<div class="tv-tasks">${taskList.map((t) => {
      const c = cardForCode(t.code);
      const area = AREAS.find((a) => a.id === t.area);
      return `<${c ? `button data-card="${c.id}"` : "div"} class="tv-task" title="${esc(area.name)}${c ? " · apri la scheda" : ""}">
        <span class="tv-code">${esc(t.code === "?" ? "–" : t.code)}</span>
        <span class="tv-name">${esc(t.name)}</span>
        <span class="tv-tbar"><i class="a-${t.area}" style="width:${(t.min / maxTask) * 100}%"></i></span>
        <span class="tv-val">${hoursLabel(t.min)}</span>
        <span class="tv-days-n">${t.days} ${t.days === 1 ? "giorno" : "giorni"}</span>
      </${c ? "button" : "div"}>`;
    }).join("")}</div>` : `<p class="tv-empty">${hasData ? "Nessuna ora registrata in questa settimana." : "Nessuna ora caricata: Claude le carica a ogni buongiorno."}</p>`}
  </div>`;
}

document.querySelector(".views").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (b) setView(b.dataset.view);
});

const tip = document.createElement("div");
tip.className = "tv-tip";
tip.hidden = true;
document.body.append(tip);

document.getElementById("tempo").addEventListener("click", (e) => {
  const b = e.target.closest("[data-t], [data-card]");
  if (!b) return;
  if (b.dataset.card) return openCard(b.dataset.card);
  const move = (n) => { T.week = new Date(T.week.getFullYear(), T.week.getMonth(), T.week.getDate() + 7 * n); };
  switch (b.dataset.t) {
    case "prev": move(-1); break;
    case "next": move(1); break;
    case "now": T.week = mondayOf(new Date()); break;
    case "focus": case "agents": T.measure = b.dataset.t; store("tempo.misura", T.measure); break;
    case "others": return;
  }
  renderTime();
});
document.getElementById("tempo").addEventListener("change", (e) => {
  if (e.target.dataset.t !== "others") return;
  T.others = e.target.checked;
  store("tempo.altro", T.others);
  renderTime();
});
// Tooltip sul giorno: il dettaglio per area di quella colonna.
document.getElementById("tempo").addEventListener("pointermove", (e) => {
  const col = e.target.closest(".tv-col");
  const stack = col?.querySelector(".tv-stack");
  if (!col || !stack?.children.length) { tip.hidden = true; return; }
  const i = Number(col.dataset.day);
  const day = new Date(T.week.getFullYear(), T.week.getMonth(), T.week.getDate() + i);
  const parts = [...stack.children].reverse().map((s) => {
    const [name, value] = s.dataset.tip.split(" · ");
    return `<div class="row"><i class="sw ${s.className}"></i><span>${name}</span><b>${value}</b></div>`;
  });
  const totalText = col.querySelector(".tv-coltotal")?.textContent || "";
  tip.innerHTML = `<div class="when">${WEEKDAYS[i]} ${day.getDate()} ${MONTHS[day.getMonth()]}<b>${totalText}</b></div>${parts.join("")}`;
  tip.hidden = false;
  const w = tip.offsetWidth;
  const hgt = tip.offsetHeight;
  let x = e.clientX + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, Math.min(e.clientY - hgt / 2, innerHeight - hgt - 8))}px`;
});
document.getElementById("tempo").addEventListener("pointerleave", () => { tip.hidden = true; });

/* ---------- Vista Agenti ---------- */

// Canoni mensili in euro per account ("abbonamenti" della config; l'ordine è quello delle legende).
const AG_ABBONAMENTI = CONFIG.abbonamenti || {};
const AG_USD_EUR = 0.92; // cambio indicativo, aggiornalo

// Prezzi di listino (USD per milione di token; fonte: listino Anthropic, 24/11/2026).
const AG_PRICES = {
  "claude-opus-5-5":   { in: 4,    out: 20,  cr: 0.20 },
  "claude-sonnet-5-5": { in: 2,    out: 10,  cr: 0.10 },
  "claude-haiku-5-5":  { in: 0.10, out: 0.50, cr: 0.01 },
  "claude-fable-5-2":  { in: 8,    out: 40,  cr: 0.20 },
};

// Listino Gemini (USD per milione; fonte: blog di Google, novembre 2026). Lettura cache: nota solo per
// Neon; per gli altri si stima al 10% dell'input. Carbon e Argon non hanno prezzi pubblicati: "–".
const AG_GEMINI_PRICES = {
  hydrogen: { in: 1.50, out: 7.50, cr: 0.15 },
  neon:     { in: 3,    out: 15,   cr: 0.15 },
  flash:    { in: 0.75, out: 3.75, cr: 0.075 },
};
// Costo a listino di una chiamata Gemini, o null se mancano i token (chiamate prima del 24/11) o il prezzo.
function agGemCallUsd(g) {
  const m = /gemini-(?:4-)?(?:3\.8-)?(hydrogen|neon|flash)/.exec(String(g.model || ""));
  const p = m && AG_GEMINI_PRICES[m[1]];
  const tin = Number(g.input_tokens) || 0;
  const tout = (Number(g.output_tokens) || 0) + (Number(g.thinking_tokens) || 0);
  if (!p || !(tin || tout)) return null;
  return (tin * p.in + tout * p.out + (Number(g.cache_read_tokens) || 0) * p.cr) / 1e6;
}

const AG_ACCOUNTS = Object.keys(AG_ABBONAMENTI);
const AG_MONTHS_LONG = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
const AG_TABS = [
  { id: "panoramica", label: "Panoramica" },
  { id: "modelli", label: "Modelli" },
  { id: "sessioni", label: "Sessioni" },
];
// Oltre questo contesto (token riletti a ogni turno) una chat conviene chiuderla e ripartire.
const AG_LONG_CTX = Number(CONFIG.contesto_lungo) || 300000;
const AG_PERIODS = [
  { id: "settimana", label: "Settimana" },
  { id: "mese", label: "Mese" },
  { id: "trimestre", label: "3 mesi" },
];
const AG_BANDS = [
  { id: "notte", label: "Notte", range: "0–6", from: 0, to: 6 },
  { id: "mattina", label: "Mattina", range: "6–12", from: 6, to: 12 },
  { id: "pomeriggio", label: "Pomeriggio", range: "12–18", from: 12, to: 18 },
  { id: "sera", label: "Sera", range: "18–24", from: 18, to: 24 },
];

const A = {
  data: null,
  error: null,
  tab: load("agenti.scheda", "panoramica"),
  period: load("agenti.periodo", "settimana"),
  offset: 0,
};
if (!AG_TABS.some((t) => t.id === A.tab)) A.tab = "panoramica";
if (!AG_PERIODS.some((p) => p.id === A.period)) A.period = "settimana";

function shortTokens(n) {
  n = Math.round(n || 0);
  if (n < 1000) return String(n);
  if (n < 999500) {
    const k = n / 1e3;
    return `${(k < 100 ? k.toFixed(1) : Math.round(k).toString()).replace(/\.0$/, "").replace(".", ",")}k`;
  }
  if (n < 999500000) {
    const m = n / 1e6;
    return `${(m < 100 ? m.toFixed(1) : Math.round(m).toString()).replace(/\.0$/, "").replace(".", ",")}M`;
  }
  return `${(n / 1e9).toFixed(1).replace(/\.0$/, "").replace(".", ",")}G`;
}
function fmtNum(n, decimals = 2) {
  const neg = n < 0;
  const fixed = Math.abs(n || 0).toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "−" : ""}${grouped}${decPart !== undefined ? `,${decPart}` : ""}`;
}
const fmtInt = (n) => fmtNum(Math.round(n || 0), 0);
const fmtEur = (n) => `${fmtNum(n, 2)} €`;
const fmtUsd = (n) => `$${fmtNum(n, 2)}`;
function fmtPct(v) {
  if (v > 0 && v < 10) return `${fmtNum(v, 1).replace(/,0$/, "")}%`;
  return `${Math.round(v)}%`;
}
function fmtDur(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return r ? `${h}h ${rm}m ${r}s` : rm ? `${h}h ${rm}m` : `${h}h`;
}
function fmtCountdown(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h ? `${d}g ${h}h` : `${d}g`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
function agCapMonth(m) {
  const s = MONTHS[m];
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}
function agDateMs(iso, t = "00:00") {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  const [hh, mm] = String(t || "00:00").split(":").map(Number);
  if (!y || !m || !d) return NaN;
  return new Date(y, m - 1, d, Number.isFinite(hh) ? hh : 0, Number.isFinite(mm) ? mm : 0).getTime();
}
function agShortDate(iso, refYear) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return String(iso || "");
  return `${d} ${MONTHS[m - 1]}${refYear && y !== refYear ? ` ${y}` : ""}`;
}
function weekRange(days, refYear = new Date().getFullYear()) {
  const first = days[0];
  const last = days[days.length - 1];
  const year = (d) => (first.getFullYear() !== last.getFullYear() || d.getFullYear() !== refYear ? ` ${d.getFullYear()}` : "");
  if (first.getTime() === last.getTime()) {
    return `${first.getDate()} ${MONTHS[first.getMonth()]}${year(first)}`;
  }
  if (first.getFullYear() !== last.getFullYear()) {
    return `${first.getDate()} ${MONTHS[first.getMonth()]}${year(first)} – ${last.getDate()} ${MONTHS[last.getMonth()]}${year(last)}`;
  }
  if (first.getMonth() === last.getMonth()) {
    return `${first.getDate()} – ${last.getDate()} ${MONTHS[last.getMonth()]}${year(last)}`;
  }
  return `${first.getDate()} ${MONTHS[first.getMonth()]} – ${last.getDate()} ${MONTHS[last.getMonth()]}${year(last)}`;
}
function agAccountColor(acc) {
  if (acc === "Gemini") return "var(--ag-gemini)";
  const n = AG_ACCOUNTS.filter((a) => a !== "Gemini").indexOf(acc);
  if (n >= 0 && n < 3) return `var(--ag-acc-${n + 1})`;
  return "var(--ag-other)";
}
function agModelColor(id) {
  const s = String(id || "").toLowerCase();
  if (s.includes("opus")) return "var(--ag-opus)";
  if (s.includes("sonnet")) return "var(--ag-sonnet)";
  if (s.includes("haiku")) return "var(--ag-haiku)";
  if (s.includes("fable")) return "var(--ag-fable)";
  if (s.includes("gemini")) return "var(--ag-gemini)";
  return "var(--ag-other)";
}
function agModelName(id) {
  const m = String(id || "").match(/^claude-([a-z]+)-([\d-]+)$/i);
  if (!m) return String(id || "–");
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${fam} ${m[2].replace(/-/g, ".")}`;
}
// "gemini-4-hydrogen-high" → "Hydrogen high", "gemini-3.8-flash-low" → "3.8 flash low".
function gemName(id) {
  const s = String(id || "").replace(/^gemini-(4-)?/, "").replace(/-/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "–";
}
function clampPct(v) {
  return v === null || v === undefined ? null : Math.max(0, Math.min(100, Number(v)));
}

// Passi fini (1, 2, 2,5, 5 × 10^n) scegliendo 3–5 tacche col minimo spazio vuoto in cima.
function niceScale(maxVal, minStep = 1) {
  if (maxVal <= 0) return { top: 4 * minStep, ticks: [0, 1, 2, 3, 4].map((i) => i * minStep) };
  const baseExp = Math.floor(Math.log10(maxVal));
  let best = null;
  for (let exp = baseExp - 2; exp <= baseExp + 1; exp++) {
    const pow = Math.pow(10, exp);
    for (const mult of [1, 2, 2.5, 5]) {
      const step = mult * pow;
      if (step < minStep) continue;
      const count = Math.ceil(maxVal / step);
      if (count < 3 || count > 5) continue;
      const top = count * step;
      const waste = (top - maxVal) / top;
      if (!best || waste < best.waste - 1e-9 || (Math.abs(waste - best.waste) <= 1e-9 && count > best.count)) {
        best = { step, count, top, waste };
      }
    }
  }
  if (!best) {
    const step = Math.max(minStep, Math.ceil(maxVal / 4));
    const count = Math.max(1, Math.ceil(maxVal / step));
    best = { step, count, top: count * step };
  }
  const ticks = [];
  for (let i = 0; i <= best.count; i++) ticks.push(Math.round(i * best.step));
  return { top: Math.round(best.top), ticks };
}

/* ---------- Calcoli Vista Agenti ---------- */

const agNewTokens = (r) => (r.input || 0) + (r.output || 0) + (r.cache_write || 0);
const agAllTokens = (r) => agNewTokens(r) + (r.cache_read || 0);

// Costo a listino (USD) di una riga secondo i prezzi API in AG_PRICES; null se modello sconosciuto.
function agRowCostUsd(r, prices = AG_PRICES) {
  const p = prices[r.model];
  if (!p) return null;
  const cw = r.cache_write || 0;
  const cw1h = Math.min(cw, r.cache_write_1h || 0);
  const cw5m = cw - cw1h;
  return (
    (r.input || 0) * p.in +
    (r.output || 0) * p.out +
    (r.cache_read || 0) * p.cr +
    cw5m * p.in * 1.25 +
    cw1h * p.in * 2
  ) / 1e6;
}

// Intervallo del periodo (settimana | mese | trimestre = 3 mesi), giorni trascorsi e periodo precedente equivalente.
function agPeriodRange(period, offset = 0, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayIso = isoDay(today);
  const refYear = today.getFullYear();
  let start, end, prevStart, prevEndFull, label;

  if (period === "mese") {
    start = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    prevStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
    prevEndFull = new Date(start.getFullYear(), start.getMonth(), 0);
    label = `${AG_MONTHS_LONG[start.getMonth()]}${start.getFullYear() !== refYear ? ` ${start.getFullYear()}` : ""}`;
  } else if (period === "trimestre") {
    const endMonth = new Date(today.getFullYear(), today.getMonth() + offset * 3, 1);
    start = new Date(endMonth.getFullYear(), endMonth.getMonth() - 2, 1);
    end = new Date(endMonth.getFullYear(), endMonth.getMonth() + 1, 0);
    prevStart = new Date(start.getFullYear(), start.getMonth() - 3, 1);
    prevEndFull = new Date(start.getFullYear(), start.getMonth(), 0);
    if (start.getFullYear() !== end.getFullYear()) {
      label = `${agCapMonth(start.getMonth())} ${start.getFullYear()} – ${agCapMonth(end.getMonth())} ${end.getFullYear()}`;
    } else {
      label = `${agCapMonth(start.getMonth())} – ${agCapMonth(end.getMonth())}${end.getFullYear() !== refYear ? ` ${end.getFullYear()}` : ""}`;
    }
  } else {
    period = "settimana";
    const mon = mondayOf(today);
    start = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + offset * 7);
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    prevStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7);
    prevEndFull = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  }

  const days = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    days.push(d);
  }
  if (period === "settimana") label = weekRange(days, refYear);

  const startIso = isoDay(start);
  const endIso = isoDay(end);
  const totalDays = days.length;
  let elapsedDays = totalDays;
  if (todayIso < startIso) elapsedDays = 0;
  else if (todayIso < endIso) elapsedDays = Math.round((today - start) / DAY_MS) + 1;
  elapsedDays = Math.max(1, Math.min(totalDays, elapsedDays));

  const prevDaysCount = Math.min(elapsedDays, Math.round((prevEndFull - prevStart) / DAY_MS) + 1);
  const prevEnd = new Date(prevStart.getFullYear(), prevStart.getMonth(), prevStart.getDate() + prevDaysCount - 1);
  const prevStartIso = isoDay(prevStart);
  const prevEndIso = isoDay(prevEnd);
  const prevLabel = weekRange([prevStart, prevEnd], refYear);

  return {
    period, offset, start, end, startIso, endIso, todayIso, days,
    totalDays, elapsedDays, isCurrent: offset === 0,
    prevStartIso, prevEndIso, prevLabel, label,
  };
}

// Distribuzione dei token nuovi nelle 24 ore e nelle 4 fasce (Notte, Mattina, Pomeriggio, Sera).
function agComputeHourly(docs) {
  const hours = Array(24).fill(0);
  let total = 0;
  for (const doc of docs) {
    for (const r of doc.rows || []) {
      const h = Number(r.h);
      if (!Number.isInteger(h) || h < 0 || h >= 24) continue;
      const nt = agNewTokens(r);
      hours[h] += nt;
      total += nt;
    }
  }
  const bands = AG_BANDS.map((b) => {
    let tokens = 0;
    for (let h = b.from; h < b.to; h++) tokens += hours[h];
    return { ...b, tokens, pct: total > 0 ? Math.round((tokens / total) * 100) : 0 };
  });
  return { hours, total, bands };
}

// Raggruppa i giorni di un periodo in blocchi settimanali (lunedì–domenica, tagliati sul periodo).
function agWeekBuckets(days) {
  const map = new Map();
  for (const d of days) {
    const monIso = isoDay(mondayOf(d));
    let b = map.get(monIso);
    if (!b) {
      b = { monIso, days: [] };
      map.set(monIso, b);
    }
    b.days.push(d);
  }
  return [...map.values()].map((b) => ({
    monIso: b.monIso,
    days: b.days,
    startIso: isoDay(b.days[0]),
    endIso: isoDay(b.days[b.days.length - 1]),
    label: weekRange(b.days),
    shortLabel: `${b.days[0].getDate()} ${MONTHS[b.days[0].getMonth()]}`,
  }));
}

// Aggregazione completa per il periodo: token, variazione, barre, fasce orarie, progetti, modelli, costi e Gemini.
function agAggregatePeriod(data, period, offset = 0, now = new Date(), abbonamenti = AG_ABBONAMENTI, usdEur = AG_USD_EUR, prices = AG_PRICES) {
  const range = agPeriodRange(period, offset, now);
  const byDate = new Map(data.map((d) => [d.date, d]));
  const periodDocs = [];
  for (const d of range.days) {
    const doc = byDate.get(isoDay(d));
    if (doc) periodDocs.push(doc);
  }

  let newTokens = 0;
  let allTokens = 0;
  let listUsd = 0;
  let rowCount = 0;
  let unknownCostRows = 0;
  const accListUsd = new Map();
  const modelMap = new Map();
  const projMap = new Map();
  const dayTotals = new Map();
  const gemCalls = [];

  for (const doc of periodDocs) {
    let dNew = 0;
    let dAll = 0;
    for (const r of doc.rows || []) {
      rowCount++;
      const nt = agNewTokens(r);
      const at = agAllTokens(r);
      const usd = agRowCostUsd(r, prices);
      const acc = String(r.account || "CLI");
      const mk = String(r.model || "–");
      const pk = String(r.project || "–");

      newTokens += nt;
      allTokens += at;
      dNew += nt;
      dAll += at;
      if (usd !== null) {
        listUsd += usd;
        accListUsd.set(acc, (accListUsd.get(acc) || 0) + usd);
      } else {
        unknownCostRows++;
      }

      let m = modelMap.get(mk);
      if (!m) {
        m = { model: mk, name: agModelName(mk), color: agModelColor(mk), newTokens: 0, allTokens: 0, listUsd: 0, known: Boolean(prices[mk]), byAccUsd: new Map() };
        modelMap.set(mk, m);
      }
      m.newTokens += nt;
      m.allTokens += at;
      if (usd !== null) {
        m.listUsd += usd;
        m.byAccUsd.set(acc, (m.byAccUsd.get(acc) || 0) + usd);
      }

      let p = projMap.get(pk);
      if (!p) {
        p = { name: pk, newTokens: 0, listUsd: 0, byAccUsd: new Map(), byModelAccUsd: new Map() };
        projMap.set(pk, p);
      }
      p.newTokens += nt;
      if (usd !== null) {
        p.listUsd += usd;
        p.byAccUsd.set(acc, (p.byAccUsd.get(acc) || 0) + usd);
        let mm = p.byModelAccUsd.get(mk);
        if (!mm) { mm = { listUsd: 0, byAcc: new Map() }; p.byModelAccUsd.set(mk, mm); }
        mm.listUsd += usd;
        mm.byAcc.set(acc, (mm.byAcc.get(acc) || 0) + usd);
      }
    }
    dayTotals.set(doc.date, { newTokens: dNew, allTokens: dAll });
    for (const g of doc.gemini || []) gemCalls.push(g);
  }

  // Periodo precedente equivalente per la variazione % dei token nuovi.
  let prevNewTokens = 0;
  for (const doc of data) {
    if (doc.date >= range.prevStartIso && doc.date <= range.prevEndIso) {
      for (const r of doc.rows || []) prevNewTokens += agNewTokens(r);
    }
  }
  const deltaPct = prevNewTokens > 0 ? Math.round(((newTokens - prevNewTokens) / prevNewTokens) * 100) : null;
  const avgPerDay = newTokens / range.elapsedDays;

  // Barre del grafico: giornaliere in Settimana e Mese, settimanali in 3 mesi.
  let buckets;
  if (range.period === "trimestre") {
    const weeks = agWeekBuckets(range.days);
    const step = weeks.length > 8 ? 2 : 1;
    buckets = weeks.map((w, idx) => {
      let bNew = 0;
      let bAll = 0;
      for (const d of w.days) {
        const dt = dayTotals.get(isoDay(d));
        if (dt) { bNew += dt.newTokens; bAll += dt.allTokens; }
      }
      return {
        label: w.label,
        axisLabel: idx % step === 0 ? w.shortLabel : "",
        newTokens: bNew,
        allTokens: bAll,
        isToday: w.startIso <= range.todayIso && range.todayIso <= w.endIso,
        isFuture: w.startIso > range.todayIso,
      };
    });
  } else {
    buckets = range.days.map((d, i) => {
      const iso = isoDay(d);
      const dt = dayTotals.get(iso) || { newTokens: 0, allTokens: 0 };
      const dayNum = d.getDate();
      const showAxis = range.period === "settimana" || dayNum === 1 || dayNum % 5 === 0 || i === range.days.length - 1;
      return {
        label: range.period === "settimana"
          ? `${WEEKDAYS[i]} ${dayNum} ${MONTHS[d.getMonth()]}`
          : `${dayNum} ${MONTHS[d.getMonth()]}`,
        axisLabel: range.period === "settimana" ? `${WEEKDAYS[i]} ${dayNum}` : (showAxis ? String(dayNum) : ""),
        newTokens: dt.newTokens,
        allTokens: dt.allTokens,
        isToday: iso === range.todayIso,
        isFuture: iso > range.todayIso,
      };
    });
  }

  // Fasce orarie.
  const hourly = agComputeHourly(periodDocs);

  // Progetti (Panoramica): primi 8 per token nuovi + "Altri (N)".
  const sortedProjTok = [...projMap.values()].filter((p) => p.newTokens > 0).sort((a, b) => b.newTokens - a.newTokens);
  const top8Tok = sortedProjTok.slice(0, 8).map((p) => ({
    name: p.name,
    newTokens: p.newTokens,
    pct: newTokens > 0 ? Math.round((p.newTokens / newTokens) * 100) : 0,
    isOther: false,
  }));
  const restTok = sortedProjTok.slice(8);
  if (restTok.length) {
    const restVal = restTok.reduce((s, p) => s + p.newTokens, 0);
    top8Tok.push({
      name: `Altri (${restTok.length})`,
      newTokens: restVal,
      pct: newTokens > 0 ? Math.round((restVal / newTokens) * 100) : 0,
      isOther: true,
      count: restTok.length,
    });
  }

  // Costi reali ripartiti per account sul costo a listino.
  const paidClaudeAccounts = Object.entries(abbonamenti)
    .filter(([acc, fee]) => acc !== "Gemini" && typeof fee === "number" && fee > 0);
  const hasFees = paidClaudeAccounts.length > 0;
  const geminiFeeEur = typeof abbonamenti.Gemini === "number" && abbonamenti.Gemini > 0
    ? abbonamenti.Gemini * (range.elapsedDays / 30.44)
    : null;
  const hasAnyFee = hasFees || geminiFeeEur !== null;
  const accRealEur = new Map(paidClaudeAccounts.map(([acc, fee]) => [acc, fee * (range.elapsedDays / 30.44)]));
  const realEur = hasFees ? [...accRealEur.values()].reduce((s, v) => s + v, 0) : null;
  const listEur = listUsd * usdEur;
  const savingsRatio = hasFees && listEur > 0 ? 1 - realEur / listEur : null;
  const savingsPct = savingsRatio !== null ? Math.round(savingsRatio * 100) : null;

  const allocReal = (byAccMap) => {
    if (!hasFees) return null;
    let sum = 0;
    for (const [acc, u] of byAccMap) {
      const aReal = accRealEur.get(acc);
      const aTotal = accListUsd.get(acc) || 0;
      if (aReal && aTotal > 0) sum += aReal * (u / aTotal);
    }
    return sum;
  };

  // Modelli ordinati per spesa (reale se i canoni ci sono, altrimenti listino; sconosciuti in fondo).
  const models = [...modelMap.values()].map((m) => ({
    model: m.model,
    name: m.name,
    color: m.color,
    newTokens: m.newTokens,
    tokenPct: newTokens > 0 ? Math.round((m.newTokens / newTokens) * 100) : 0,
    known: m.known,
    listUsd: m.known ? m.listUsd : null,
    realEur: m.known ? allocReal(m.byAccUsd) : null,
  })).sort((a, b) => {
    if (a.known !== b.known) return a.known ? -1 : 1;
    const va = hasFees ? (a.realEur ?? -1) : (a.listUsd ?? -1);
    const vb = hasFees ? (b.realEur ?? -1) : (b.listUsd ?? -1);
    return (vb - va) || ((b.listUsd ?? -1) - (a.listUsd ?? -1)) || (b.newTokens - a.newTokens);
  });

  // Spesa per progetto: primi 8 + "Altri (N)" con quote dei modelli per barra impilata.
  const projCostAll = [...projMap.values()]
    .filter((p) => p.listUsd > 0)
    .map((p) => {
      const pReal = allocReal(p.byAccUsd);
      const segs = [...p.byModelAccUsd.entries()].map(([mk, mm]) => {
        const mReal = allocReal(mm.byAcc);
        const weight = hasFees && pReal > 0 ? mReal : mm.listUsd;
        return { model: mk, name: agModelName(mk), color: agModelColor(mk), listUsd: mm.listUsd, realEur: mReal, weight };
      }).filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight);
      return { name: p.name, listUsd: p.listUsd, realEur: pReal, primary: hasFees ? pReal : p.listUsd, models: segs, isOther: false };
    })
    .sort((a, b) => (b.primary - a.primary) || (b.listUsd - a.listUsd));

  const projectsCost = projCostAll.slice(0, 8);
  const restCost = projCostAll.slice(8);
  if (restCost.length) {
    const restListUsd = restCost.reduce((s, p) => s + p.listUsd, 0);
    const restRealEur = hasFees ? restCost.reduce((s, p) => s + p.realEur, 0) : null;
    const merged = new Map();
    for (const p of restCost) {
      for (const m of p.models) {
        const cur = merged.get(m.model) || { model: m.model, name: m.name, color: m.color, listUsd: 0, realEur: hasFees ? 0 : null, weight: 0 };
        cur.listUsd += m.listUsd;
        if (hasFees) cur.realEur += m.realEur;
        cur.weight += m.weight;
        merged.set(m.model, cur);
      }
    }
    projectsCost.push({
      name: `Altri (${restCost.length})`,
      listUsd: restListUsd,
      realEur: restRealEur,
      primary: hasFees ? restRealEur : restListUsd,
      models: [...merged.values()].sort((a, b) => b.weight - a.weight),
      isOther: true,
      count: restCost.length,
    });
  }

  // Gemini.
  const gemOk = gemCalls.filter((g) => g.ok).length;
  const gemSecs = gemCalls.reduce((s, g) => s + (Number(g.secs) || 0), 0);
  const gemChanged = gemCalls.reduce((s, g) => s + (Number(g.changed) || 0), 0);
  const gemCosts = gemCalls.map(agGemCallUsd).filter((v) => v !== null);
  const gemListUsd = gemCosts.reduce((s, v) => s + v, 0);
  const gemPriced = gemCosts.length;
  const gemModelsMap = new Map();
  for (const g of gemCalls) {
    const mk = String(g.model || "–");
    const gm = gemModelsMap.get(mk) || { model: mk, name: gemName(mk), count: 0, ok: 0, secs: 0 };
    gm.count++;
    if (g.ok) gm.ok++;
    gm.secs += Number(g.secs) || 0;
    gemModelsMap.set(mk, gm);
  }
  const gemModels = [...gemModelsMap.values()].sort((a, b) => b.count - a.count || b.secs - a.secs);

  return {
    range,
    rowCount,
    newTokens,
    allTokens,
    prevNewTokens,
    deltaPct,
    avgPerDay,
    buckets,
    hourly,
    projectsTokens: top8Tok,
    costs: {
      hasFees,
      hasAnyFee,
      listUsd,
      listEur,
      realEur,
      geminiFeeEur,
      savingsRatio,
      savingsPct,
      unknownCostRows,
      models,
      projects: projectsCost,
    },
    gemini: {
      calls: gemCalls.length,
      ok: gemOk,
      secs: gemSecs,
      changed: gemChanged,
      listUsd: gemListUsd,
      priced: gemPriced,
      models: gemModels,
    },
  };
}

// Stima il prossimo reset settimanale dai cali osservati di `sd` (ciclo di 7 giorni).
function agEstimateNextReset(samples, nowMs) {
  const drops = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (prev.sd == null || curr.sd == null) continue;
    if (curr.sd < prev.sd && (prev.sd - curr.sd >= 5 || curr.sd <= 5)) {
      const gap = curr.ms - prev.ms;
      if (gap > 0 && gap < 7 * DAY_MS) drops.push({ t0: prev.ms, t1: curr.ms, gap });
    }
  }
  if (!drops.length) return null;
  const last = drops[drops.length - 1];
  let est = (last.t0 + last.t1) / 2;
  // Se l'ultimo reset ha una finestra larga, la raffiniamo con un reset precedente stretto coerente col ciclo di 7 giorni.
  if (last.gap > 30 * 60000) {
    const weekMs = 7 * DAY_MS;
    for (let i = drops.length - 2; i >= 0; i--) {
      const d = drops[i];
      if (d.gap >= last.gap) continue;
      const mid = (d.t0 + d.t1) / 2;
      const shifted = mid + Math.round((est - mid) / weekMs) * weekMs;
      if (shifted >= last.t0 && shifted <= last.t1) { est = shifted; break; }
    }
  }
  const weekMs = 7 * DAY_MS;
  while (est <= nowMs) est += weekMs;
  const inMs = est - nowMs;
  return inMs > 0 && inMs <= weekMs ? { resetMs: est, resetInMs: inMs } : null;
}

// Limiti settimanali: ultimo campione per account + stima reset + serie per il grafico a linee del periodo.
function agComputeLimits(data, range, now = new Date()) {
  const nowMs = now.getTime();
  const docsAsc = [...data].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const allByAcc = new Map();
  for (const doc of docsAsc) {
    for (const s of doc.limits || []) {
      if (!s.account || (s.fh == null && s.sd == null)) continue;
      const ms = agDateMs(doc.date, s.t);
      if (!Number.isFinite(ms)) continue;
      const list = allByAcc.get(s.account) || [];
      list.push({
        account: s.account,
        date: doc.date,
        t: s.t || "",
        ms,
        fh: clampPct(s.fh),
        sd: clampPct(s.sd),
        sdReset: s.sd_reset || s.reset_at || null,
      });
      allByAcc.set(s.account, list);
    }
  }
  for (const list of allByAcc.values()) list.sort((a, b) => a.ms - b.ms);

  const accountNames = [
    ...AG_ACCOUNTS,
    ...[...allByAcc.keys()].filter((a) => !AG_ACCOUNTS.includes(a)).sort((a, b) => a.localeCompare(b, "it")),
  ];

  const latest = accountNames.map((acc) => {
    const list = allByAcc.get(acc) || [];
    const last = list.length ? list[list.length - 1] : null;
    let reset = null;
    if (last?.sdReset) {
      const rms = new Date(last.sdReset).getTime();
      if (Number.isFinite(rms) && rms > nowMs) reset = { resetMs: rms, resetInMs: rms - nowMs };
    }
    if (!reset && list.length >= 2) reset = agEstimateNextReset(list, nowMs);
    return {
      account: acc,
      color: agAccountColor(acc),
      sd: last?.sd ?? null,
      fh: last?.fh ?? null,
      date: last?.date ?? null,
      t: last?.t ?? "",
      resetInMs: reset?.resetInMs ?? null,
      hasData: Boolean(last),
    };
  });

  // Serie per il grafico a linee del periodo selezionato.
  let chart;
  if (range.period === "settimana") {
    const dayIdx = new Map(range.days.map((d, i) => [isoDay(d), i]));
    const series = [];
    for (const acc of accountNames) {
      const list = (allByAcc.get(acc) || []).filter((s) => s.sd != null && dayIdx.has(s.date));
      if (!list.length) continue;
      const segments = [];
      let seg = [];
      let prev = null;
      for (const s of list) {
        const i = dayIdx.get(s.date);
        const [hh, mm] = (s.t || "00:00").split(":").map(Number);
        const xh = i * 24 + (Number.isFinite(hh) ? hh : 0) + (Number.isFinite(mm) ? mm : 0) / 60;
        const pt = {
          xPct: (xh / 168) * 100,
          sd: s.sd,
          label: `${WEEKDAYS[i]} ${range.days[i].getDate()} ${MONTHS[range.days[i].getMonth()]}${s.t ? ` ${s.t}` : ""}`,
        };
        if (prev && s.sd < prev.sd && (prev.sd - s.sd >= 5 || s.sd <= 5)) {
          if (seg.length) segments.push(seg);
          seg = [pt];
        } else {
          seg.push(pt);
        }
        prev = s;
      }
      if (seg.length) segments.push(seg);
      // Un punto cliccabile per giorno (l'ultimo campione del giorno) più eventuali segmenti di un solo punto.
      const dailyDots = new Map();
      for (const s of list) {
        const i = dayIdx.get(s.date);
        const [hh, mm] = (s.t || "00:00").split(":").map(Number);
        const xh = i * 24 + (Number.isFinite(hh) ? hh : 0) + (Number.isFinite(mm) ? mm : 0) / 60;
        dailyDots.set(i, {
          xPct: (xh / 168) * 100,
          sd: s.sd,
          label: `${WEEKDAYS[i]} ${range.days[i].getDate()} ${MONTHS[range.days[i].getMonth()]}${s.t ? ` ${s.t}` : ""}`,
        });
      }
      const dots = [...dailyDots.values()];
      for (const sg of segments) {
        if (sg.length === 1 && !dots.some((d) => Math.abs(d.xPct - sg[0].xPct) < 0.01)) dots.push(sg[0]);
      }
      series.push({ account: acc, color: agAccountColor(acc), segments, dots });
    }
    chart = {
      mode: "week",
      caption: "Andamento della settimana (% usata)",
      xLabels: range.days.map((d, i) => `${WEEKDAYS[i]} ${d.getDate()}`),
      series,
    };
  } else {
    const weeks = agWeekBuckets(range.days);
    const step = weeks.length > 8 ? 2 : 1;
    const series = [];
    for (const acc of accountNames) {
      const list = (allByAcc.get(acc) || []).filter((s) => s.sd != null && s.date >= range.startIso && s.date <= range.endIso);
      if (!list.length) continue;
      const pts = [];
      weeks.forEach((w, idx) => {
        let peak = null;
        for (const s of list) {
          if (s.date >= w.startIso && s.date <= w.endIso) {
            peak = peak === null ? s.sd : Math.max(peak, s.sd);
          }
        }
        if (peak !== null) {
          pts.push({
            xPct: ((idx + 0.5) / weeks.length) * 100,
            sd: peak,
            label: `Sett. ${w.label}`,
          });
        }
      });
      if (pts.length) {
        series.push({ account: acc, color: agAccountColor(acc), segments: [pts], dots: pts });
      }
    }
    chart = {
      mode: "peaks",
      caption: "Picco settimanale per account (% usata)",
      xLabels: weeks.map((w, idx) => (idx % step === 0 ? w.shortLabel : "")),
      series,
    };
  }

  return { latest, hasAny: latest.some((x) => x.hasData), chart };
}

// Punti di pareggio per account con canone impostato (Gemini escluso: niente token).
function agComputeBreakeven(data, now = new Date(), abbonamenti = AG_ABBONAMENTI, usdEur = AG_USD_EUR, prices = AG_PRICES) {
  const paid = Object.entries(abbonamenti)
    .filter(([acc, fee]) => acc !== "Gemini" && typeof fee === "number" && fee > 0);
  if (!paid.length) return [];

  const docsAsc = [...data].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayIso = isoDay(today);
  const monthStartIso = isoDay(new Date(today.getFullYear(), today.getMonth(), 1));

  // Finestra degli ultimi 30 giorni di dati (fino all'ultima data disponibile).
  const latestDataIso = docsAsc.length ? docsAsc[docsAsc.length - 1].date : todayIso;
  const refEnd = new Date(`${latestDataIso}T12:00`);
  const cutoff30Iso = isoDay(new Date(refEnd.getFullYear(), refEnd.getMonth(), refEnd.getDate() - 29));

  return paid.map(([acc, feeEur]) => {
    // 1. Pareggio del mese corrente.
    let cumEur = 0;
    let paidDate = null;
    for (const doc of docsAsc) {
      if (doc.date < monthStartIso || doc.date > todayIso) continue;
      for (const r of doc.rows || []) {
        if (r.account !== acc) continue;
        const usd = agRowCostUsd(r, prices);
        if (usd !== null) cumEur += usd * usdEur;
      }
      if (!paidDate && cumEur >= feeEur) paidDate = doc.date;
    }

    // 2. Valore dell'1% del limite settimanale e soglia di pareggio sugli ultimi 30 giorni di dati.
    let cost30Usd = 0;
    const samples = [];
    for (const doc of docsAsc) {
      if (doc.date < cutoff30Iso || doc.date > latestDataIso) continue;
      for (const r of doc.rows || []) {
        if (r.account !== acc) continue;
        const usd = agRowCostUsd(r, prices);
        if (usd !== null) cost30Usd += usd;
      }
      for (const s of doc.limits || []) {
        if (s.account !== acc || s.sd == null) continue;
        const ms = agDateMs(doc.date, s.t);
        if (Number.isFinite(ms)) samples.push({ ms, sd: clampPct(s.sd) });
      }
    }
    samples.sort((a, b) => a.ms - b.ms);
    let sdInc = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].sd > samples[i - 1].sd) sdInc += samples[i].sd - samples[i - 1].sd;
    }
    const spanMs = samples.length >= 2 ? samples[samples.length - 1].ms - samples[0].ms : 0;
    const enough = sdInc >= 15 && cost30Usd > 0;
    const usdPer1Pct = enough ? cost30Usd / sdInc : null;
    const fullWeekUsd = usdPer1Pct !== null ? usdPer1Pct * 100 : null;
    const feeUsd = feeEur / usdEur;
    const thresholdPct = usdPer1Pct !== null ? feeUsd / (usdPer1Pct * 4.35) : null;
    const avgWeeklyPct = enough && spanMs >= 6 * DAY_MS ? Math.min(100, sdInc / (spanMs / (7 * DAY_MS))) : null;

    return {
      account: acc,
      color: agAccountColor(acc),
      feeEur,
      monthListEur: cumEur,
      paidDate,
      missingEur: paidDate ? 0 : Math.max(0, feeEur - cumEur),
      cost30Usd,
      sdInc,
      usdPer1Pct,
      fullWeekUsd,
      thresholdPct,
      avgWeeklyPct,
    };
  });
}

/* ---------- Rendering Vista Agenti ---------- */

function agTipAttrs(title, value, rows = null) {
  let out = `data-ag-tip="${esc(title)}" data-ag-val="${esc(value)}"`;
  if (rows?.length) out += ` data-ag-rows="${esc(JSON.stringify(rows))}"`;
  return out;
}

function renderAgents() {
  const root = document.getElementById("agenti");
  const keep = root.contains(document.activeElement) && document.activeElement.dataset.a;
  hideAgTip();
  try {
    drawAgents(root);
  } catch (error) {
    console.error("Vista Agenti:", error);
    root.innerHTML = `<div class="tv"><p class="tv-empty">Errore nel disegnare la vista: ${esc(error?.message || "sconosciuto")}</p></div>`;
  }
  if (keep) (root.querySelector(`[data-a="${keep}"]:not(:disabled)`) || root.querySelector(".tv-nav [data-a]:not(:disabled)"))?.focus();
}

function drawAgents(root) {
  if (!A.data) {
    root.innerHTML = `<div class="tv"><p class="tv-empty">${A.error ? esc(A.error) : "Carico le statistiche…"}</p></div>`;
    return;
  }
  const now = new Date();
  const agg = agAggregatePeriod(A.data, A.period, A.offset, now);
  const { range } = agg;
  const dates = A.data.map((d) => d.date).filter(Boolean).sort();
  const earliestIso = dates.length ? dates[0] : null;
  const canPrev = Boolean(earliestIso && range.startIso > earliestIso);

  const barHtml = `<div class="tv-bar">
    <div class="seg ag-tabs" role="group" aria-label="Scheda">
      ${AG_TABS.map((t) => `<button data-a="tab-${t.id}" aria-pressed="${A.tab === t.id}">${t.label}</button>`).join("")}
    </div>
    <div class="seg ag-periods" role="group" aria-label="Periodo">
      ${AG_PERIODS.map((p) => `<button data-a="per-${p.id}" aria-pressed="${A.period === p.id}">${p.label}</button>`).join("")}
    </div>
    <div class="tv-nav">
      <button class="icon-btn" data-a="prev" aria-label="Periodo precedente" ${canPrev ? "" : "disabled"}>${icon("chev", "flip")}</button>
      <h2>${esc(range.label)}</h2>
      <button class="icon-btn" data-a="next" aria-label="Periodo successivo" ${range.isCurrent ? "disabled" : ""}>${icon("chev")}</button>
      ${range.isCurrent ? "" : '<button class="btn small" data-a="now">Oggi</button>'}
    </div>
  </div>`;

  const bodyHtml = A.tab === "modelli" ? drawAgentsModels(agg, now)
    : A.tab === "sessioni" ? drawAgentsSessions(range, now)
    : drawAgentsOverview(agg, now);

  root.innerHTML = `<div class="tv">${barHtml}${bodyHtml}</div>`;
}

function drawAgentsOverview(agg, now) {
  const { range } = agg;
  const limits = agComputeLimits(A.data, range, now);
  const refYear = now.getFullYear();

  // 1. Token usati + grafico a barre singolo colore.
  const maxBar = Math.max(0, ...agg.buckets.map((b) => b.newTokens));
  const { top, ticks } = niceScale(maxBar);
  const barWidth = range.period === "settimana" ? "24px" : range.period === "trimestre" ? "20px" : "10px";
  const showColTotals = range.period === "settimana";
  const deltaHtml = agg.deltaPct !== null
    ? `<span class="ag-delta" title="${esc(`Rispetto a ${range.prevLabel} (${shortTokens(agg.prevNewTokens)})`)}">${agg.deltaPct > 0 ? `+${agg.deltaPct}%` : agg.deltaPct < 0 ? `−${Math.abs(agg.deltaPct)}%` : "0%"}</span>`
    : "";

  const tokensHtml = agg.rowCount ? `<section class="ag-card">
    <div class="ag-hero">
      <div class="ag-hero-top">
        <div class="tv-total"><span>Token nuovi</span><b>${shortTokens(agg.newTokens)}</b></div>
        ${deltaHtml}
      </div>
      <div class="ag-sub">${shortTokens(agg.allTokens)} con le letture da cache · media ${shortTokens(agg.avgPerDay)}/giorno</div>
    </div>
    <div class="ag-chart" style="--n:${agg.buckets.length};--bar-w:${barWidth}" role="img" aria-label="Token nuovi per ${range.period === "trimestre" ? "settimana" : "giorno"}, ${esc(range.label)}">
      <div class="tv-plot">
        ${ticks.map((v) => `<div class="tv-grid" style="bottom:${(v / top) * 100}%"><span>${v ? shortTokens(v) : "0"}</span></div>`).join("")}
        <div class="tv-cols">${agg.buckets.map((b) => {
          const pct = top > 0 ? (b.newTokens / top) * 100 : 0;
          const tipAttrs = b.newTokens > 0
            ? agTipAttrs(b.label, shortTokens(b.newTokens), [{ label: "Con cache", val: shortTokens(b.allTokens) }])
            : "";
          return `<div class="tv-col" ${tipAttrs}>
            ${showColTotals && b.newTokens ? `<span class="tv-coltotal">${shortTokens(b.newTokens)}</span>` : ""}
            <div class="tv-stack" style="height:${pct}%">${b.newTokens ? `<i style="flex-grow:1"></i>` : ""}</div>
          </div>`;
        }).join("")}</div>
      </div>
      <div class="tv-days">${agg.buckets.map((b) => `<span class="${b.isToday ? "today" : ""} ${b.isFuture ? "future" : ""}">${esc(b.axisLabel)}</span>`).join("")}</div>
    </div>
  </section>` : "";

  // 2. Limiti settimanali (sempre visibili se c'è almeno un campione in cronologia).
  const limitsRowsHtml = limits.hasAny ? `<div class="ag-limits">${limits.latest.map((l) => {
    const meta = [];
    if (l.fh !== null) meta.push(`5h: ${Math.round(l.fh)}%`);
    if (l.resetInMs !== null) meta.push(`reset tra ${fmtCountdown(l.resetInMs)}`);
    if (l.date && l.date !== range.todayIso) meta.push(`agg. ${agShortDate(l.date, refYear)}`);
    return `<div class="ag-lim">
      <span class="ag-lim-name"><i class="sw" style="background:${l.color}"></i>${esc(l.account)}</span>
      <span class="ag-lim-bar"><i style="width:${l.sd ?? 0}%;background:${l.color}"></i></span>
      <span class="ag-lim-val">${l.sd !== null ? `<b>${Math.round(l.sd)}%</b> usato` : "–"}</span>
      ${meta.length ? `<span class="ag-lim-meta">${esc(meta.join(" · "))}</span>` : ""}
    </div>`;
  }).join("")}</div>` : "";

  const lineChart = limits.chart;
  const lineHtml = lineChart.series.length ? `<div class="ag-line-box">
    <div class="ag-line-cap">${esc(lineChart.caption)}</div>
    <div class="ag-line-wrap" style="--n:${lineChart.xLabels.length}">
      <div class="ag-line-plot" role="img" aria-label="${esc(lineChart.caption)}">
        ${[0, 50, 100].map((v) => `<div class="tv-grid" style="bottom:${v}%"><span>${v}%</span></div>`).join("")}
        <svg class="ag-line-svg" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
          ${lineChart.series.map((s) => s.segments.filter((seg) => seg.length >= 2).map((seg) => {
            const pts = seg.map((p) => `${(p.xPct * 10).toFixed(1)},${(100 - p.sd).toFixed(1)}`).join(" ");
            return `<polyline stroke="${s.color}" points="${pts}"/>`;
          }).join("")).join("")}
        </svg>
        ${lineChart.series.map((s) => s.dots.map((p) => `<span class="ag-dot" style="left:${p.xPct.toFixed(2)}%;bottom:${p.sd.toFixed(1)}%;background:${s.color}" ${agTipAttrs(s.account, `${Math.round(p.sd)}% usato`, [{ label: p.label, val: "" }])}></span>`).join("")).join("")}
      </div>
      <div class="ag-line-x">${lineChart.xLabels.map((lbl) => `<span>${esc(lbl)}</span>`).join("")}</div>
    </div>
  </div>` : "";

  const limitsHtml = limits.hasAny ? `<h3 class="tv-h">Limiti settimanali</h3>
    <section class="ag-card">${limitsRowsHtml}${lineHtml}</section>` : "";

  if (!agg.rowCount) {
    return `${limitsHtml}<p class="tv-empty">Nessun uso registrato in questo periodo.</p>`;
  }

  // 3. Fasce orarie (24 barre sottili + 4 numeri riassuntivi).
  const maxHour = Math.max(1, ...agg.hourly.hours);
  const hourlyHtml = `<h3 class="tv-h">Fasce orarie</h3>
    <section class="ag-card">
      <div class="ag-bands">${agg.hourly.bands.map((b) => `<div class="ag-band">
        <span>${b.label} ${b.range}</span><b>${b.pct}%</b>
      </div>`).join("")}</div>
      <div class="ag-hours" role="img" aria-label="Distribuzione oraria dei token nuovi">
        <div class="ag-hplot">${agg.hourly.hours.map((v, hr) => {
          const hPct = v > 0 ? Math.max(2, (v / maxHour) * 100) : 0;
          const pct = agg.hourly.total > 0 ? Math.round((v / agg.hourly.total) * 100) : 0;
          const hh = String(hr).padStart(2, "0");
          const hhNext = String((hr + 1) % 24).padStart(2, "0");
          const tipAttrs = v > 0 ? agTipAttrs(`${hh}:00 – ${hhNext}:00`, `${shortTokens(v)} (${pct}%)`) : "";
          return `<div class="ag-hbar" ${tipAttrs}>${v > 0 ? `<i style="height:${hPct.toFixed(1)}%"></i>` : ""}</div>`;
        }).join("")}</div>
        <div class="ag-hx">${[...Array(24)].map((_, hr) => `<span>${hr % 6 === 0 || hr === 23 ? hr : ""}</span>`).join("")}</div>
      </div>
    </section>`;

  // 4. Progetti: primi 8 + "Altri (N)", colore neutro unico.
  const maxProj = Math.max(1, ...agg.projectsTokens.map((p) => p.newTokens));
  const projectsHtml = agg.projectsTokens.length ? `<h3 class="tv-h">Progetti</h3>
    <div class="tv-tasks">${agg.projectsTokens.map((p) => {
      const pctText = p.newTokens > 0 && p.pct === 0 ? "<1%" : `${p.pct}%`;
      return `<div class="tv-task">
        <span class="tv-name${p.isOther ? " ag-other-lbl" : ""}" title="${esc(p.name)}">${esc(p.name)}</span>
        <span class="tv-tbar"><i style="width:${(p.newTokens / maxProj) * 100}%;background:var(--ag-neutral)"></i></span>
        <span class="ag-nums"><span class="tv-val">${shortTokens(p.newTokens)}</span><span class="ag-sec">${pctText}</span></span>
      </div>`;
    }).join("")}</div>` : "";

  return `${tokensHtml}${limitsHtml}${hourlyHtml}${projectsHtml}`;
}

// Sessioni del periodo: una voce per conversazione, unendo i giorni. Costo a listino dai token per modello
// (sottoagenti compresi); contesto = token che ogni turno rilegge (input + cache), massimo e dell'ultimo turno.
function agComputeSessions(data, range, prices = AG_PRICES) {
  const byId = new Map();
  for (const doc of data) {
    if (!doc.date || doc.date < range.startIso || doc.date > range.endIso) continue;
    for (const x of doc.sessions || []) {
      let s = byId.get(x.id);
      if (!s) {
        s = { id: x.id, project: x.project, account: x.account, firstDate: doc.date, start: x.start,
          lastDate: doc.date, end: x.end, turns: 0, ctxMax: 0, ctxLast: 0, listUsd: 0, known: true,
          readTokens: 0, allTokens: 0 };
        byId.set(x.id, s);
      }
      if (doc.date < s.firstDate || (doc.date === s.firstDate && x.start < s.start)) { s.firstDate = doc.date; s.start = x.start; }
      if (doc.date > s.lastDate || (doc.date === s.lastDate && x.end >= s.end)) {
        s.lastDate = doc.date; s.end = x.end;
        if (x.turns) s.ctxLast = x.ctx_last || 0;
      }
      if (x.project) s.project = x.project;
      s.turns += x.turns || 0;
      s.ctxMax = Math.max(s.ctxMax, x.ctx_max || 0);
      for (const u of x.use || []) {
        const c = agRowCostUsd(u, prices);
        if (c === null) s.known = false; else s.listUsd += c;
        s.readTokens += u.cache_read || 0;
        s.allTokens += agAllTokens(u);
      }
    }
  }
  const list = [...byId.values()].sort((a, b) => b.listUsd - a.listUsd);
  const long = list.filter((x) => x.ctxMax >= AG_LONG_CTX);
  const total = list.reduce((t, x) => t + x.listUsd, 0);
  const costs = list.map((x) => x.listUsd).sort((a, b) => a - b);
  const median = costs.length ? (costs.length % 2 ? costs[(costs.length - 1) / 2] : (costs[costs.length / 2 - 1] + costs[costs.length / 2]) / 2) : 0;
  const read = list.reduce((t, x) => t + x.readTokens, 0);
  const all = list.reduce((t, x) => t + x.allTokens, 0);
  return {
    list, long, total, median,
    longUsd: long.reduce((t, x) => t + x.listUsd, 0),
    readPct: all ? Math.round((read / all) * 100) : 0,
  };
}

function drawAgentsSessions(range, now) {
  const S = agComputeSessions(A.data, range);
  if (!S.list.length) {
    const old = A.data.some((d) => d.date >= range.startIso && d.date <= range.endIso && (d.rows || []).length);
    return `<p class="tv-empty">${old ? "Per questo periodo non ci sono i dati per sessione (raccolti dal 24 novembre 2026)." : "Nessuna sessione in questo periodo."}</p>`;
  }
  const refYear = now.getFullYear();
  const longPct = S.total > 0 ? Math.round((S.longUsd / S.total) * 100) : 0;
  const summaryHtml = `<section class="tv-summary ag-mod-summary">
    <div class="ag-mod-kpis">
      <div class="tv-total"><span>Sessioni</span><b>${fmtInt(S.list.length)}</b></div>
      <div class="tv-total"><span>Costo mediano</span><b>${fmtUsd(S.median)}</b></div>
      <div class="tv-total"><span>Chat lunghe</span><b>${fmtInt(S.long.length)}</b></div>
      <div class="tv-total"><span>Il loro costo</span><b>${longPct}%</b></div>
    </div>
    <p class="ag-note">Ogni turno rilegge tutto il contesto (${S.readPct}% dei token sono letture da cache), quindi una chat lunga costa di più a ogni messaggio.
      Oltre ${shortTokens(AG_LONG_CTX)} di contesto conviene chiuderla e ripartire in una sessione nuova con un riassunto. Costi a listino API.</p>
  </section>`;
  const shown = S.list.slice(0, 40);
  const maxCost = Math.max(1e-9, ...shown.map((x) => x.listUsd));
  const when = (x) => {
    const a = `${agShortDate(x.firstDate, refYear)} ${x.start}`;
    return x.lastDate === x.firstDate ? `${a}–${x.end}` : `${a} – ${agShortDate(x.lastDate, refYear)} ${x.end}`;
  };
  const rowsHtml = shown.map((x) => {
    const isLong = x.ctxMax >= AG_LONG_CTX;
    const perTurn = x.turns ? x.listUsd / x.turns : 0;
    const color = agAccountColor(x.account);
    const title = `Sessione ${x.id} · per riaprirla: claude --resume ${x.id}`;
    return `<div class="tv-task ag-model-row ag-sess${isLong ? " is-long" : ""}">
      <span class="ag-name-wrap" title="${esc(title)}">
        <span class="tv-name"><i class="sw" style="background:${color}"></i>${esc(x.project || "senza cartella")}${isLong ? ' <span class="ag-long">lunga</span>' : ""}</span>
        <span class="ag-sub-inline">${esc(when(x))} · ${fmtInt(x.turns)} turni${x.turns ? ` · ${fmtUsd(perTurn)}/turno` : ""} · ${esc(x.account)}</span>
      </span>
      <span class="tv-tbar">${x.listUsd > 0 ? `<i style="width:${(x.listUsd / maxCost) * 100}%;background:${color}"></i>` : ""}</span>
      <span class="ag-nums"><span class="tv-val">${x.known ? fmtUsd(x.listUsd) : "–"}</span>
        <span class="ag-sec" title="Contesto massimo${x.ctxLast !== x.ctxMax ? `; all'ultimo turno ${shortTokens(x.ctxLast)}` : ""}">${shortTokens(x.ctxMax)} ctx</span></span>
    </div>`;
  }).join("");
  const more = S.list.length > shown.length ? `<p class="ag-note">E altre ${S.list.length - shown.length} sessioni più economiche.</p>` : "";
  return `${summaryHtml}<h3 class="tv-h">Per sessione, dalla più cara</h3><div class="tv-tasks">${rowsHtml}</div>${more}`;
}

function drawAgentsModels(agg, now) {
  const { costs, gemini } = agg;
  const breakeven = agComputeBreakeven(A.data, now);
  const refYear = now.getFullYear();

  if (!agg.rowCount && !gemini.calls && !breakeven.length) {
    return `<p class="tv-empty">Nessun dato in questo periodo.</p>`;
  }

  // Totali in alto.
  const summaryHtml = agg.rowCount ? `<section class="tv-summary ag-mod-summary">
    <div class="ag-mod-kpis">
      <div class="tv-total"><span>Costo a listino</span><b title="${esc(`≈ ${fmtEur(costs.listEur)}`)}">${fmtUsd(costs.listUsd)}</b></div>
      ${costs.hasFees ? `<div class="tv-total"><span>Spesa reale</span><b>${fmtEur(costs.realEur)}</b></div>
      <div class="tv-total"><span>Risparmio</span><b>${costs.savingsPct !== null ? `${costs.savingsPct < 0 ? `−${Math.abs(costs.savingsPct)}` : costs.savingsPct}%` : "–"}</b></div>` : ""}
    </div>
    <p class="ag-note">${costs.hasFees
      ? `Stima a prezzi API (1 $ = ${fmtNum(AG_USD_EUR, 2)} €); gli abbonamenti non si pagano a token.`
      : "Stima a prezzi API, gli abbonamenti non si pagano a token. Imposta i canoni per vedere la spesa reale."}</p>
  </section>` : `<p class="tv-empty">Nessun uso Claude registrato in questo periodo.</p>`;

  // Punti di pareggio per account con canone impostato.
  const breakevenHtml = breakeven.length ? `<section class="ag-card ag-be-card">
    <div class="ag-be-list">${breakeven.map((b) => {
      const monthPart = b.paidDate
        ? `si è ripagato il ${agShortDate(b.paidDate, refYear)}`
        : `mancano ${fmtEur(b.missingEur)} di uso a listino`;
      const parts = [monthPart];
      if (b.thresholdPct !== null) {
        let s = `pareggi usando il ${fmtPct(b.thresholdPct)} del limite a settimana`;
        if (b.avgWeeklyPct !== null) s += `; ne usi in media il ${Math.round(b.avgWeeklyPct)}%`;
        parts.push(s);
      }
      if (b.fullWeekUsd !== null) parts.push(`100% ≈ $${fmtInt(b.fullWeekUsd)}`);
      return `<div class="ag-be">
        <span class="ag-be-acc"><i class="sw" style="background:${b.color}"></i><b>${esc(b.account)}</b></span>
        <span class="ag-be-txt">${esc(parts.join(" · "))}</span>
      </div>`;
    }).join("")}</div>
  </section>` : "";

  // 1. Per modello.
  const maxModVal = Math.max(1e-9, ...costs.models.map((m) => (costs.hasFees ? (m.realEur || 0) : (m.listUsd || 0))));
  const modelsHtml = costs.models.length ? `<h3 class="tv-h">Per modello</h3>
    <div class="tv-tasks">${costs.models.map((m) => {
      const barVal = costs.hasFees ? (m.realEur || 0) : (m.listUsd || 0);
      const pctText = m.newTokens > 0 && m.tokenPct === 0 ? "<1%" : `${m.tokenPct}%`;
      const numsHtml = !m.known
        ? `<span class="tv-val">–</span>`
        : costs.hasFees
          ? `<span class="tv-val">${fmtEur(m.realEur)}</span><span class="ag-sec">${fmtUsd(m.listUsd)}</span>`
          : `<span class="tv-val">${fmtUsd(m.listUsd)}</span>`;
      return `<div class="tv-task ag-model-row">
        <span class="ag-name-wrap" title="${esc(m.model)}">
          <span class="tv-name"><i class="sw" style="background:${m.color}"></i>${esc(m.name)}</span>
          <span class="ag-sub-inline">${shortTokens(m.newTokens)} · ${pctText}</span>
        </span>
        <span class="tv-tbar">${m.known && barVal > 0 ? `<i style="width:${(barVal / maxModVal) * 100}%;background:${m.color}"></i>` : ""}</span>
        <span class="ag-nums">${numsHtml}</span>
      </div>`;
    }).join("")}</div>` : "";

  // 2. Spesa per progetto con barra impilata orizzontale delle quote dei modelli.
  const maxProjCost = Math.max(1e-9, ...costs.projects.map((p) => p.primary || 0));
  const projCostHtml = costs.projects.length ? `<h3 class="tv-h">Spesa per progetto</h3>
    <div class="tv-tasks">${costs.projects.map((p) => {
      const barPct = maxProjCost > 0 ? (p.primary / maxProjCost) * 100 : 0;
      const tipRows = p.models.map((m) => ({
        label: m.name,
        val: costs.hasFees ? `${fmtEur(m.realEur)} (${fmtUsd(m.listUsd)})` : fmtUsd(m.listUsd),
        color: m.color,
      }));
      const mainVal = costs.hasFees ? fmtEur(p.realEur) : fmtUsd(p.listUsd);
      const numsHtml = costs.hasFees
        ? `<span class="tv-val">${fmtEur(p.realEur)}</span><span class="ag-sec">${fmtUsd(p.listUsd)}</span>`
        : `<span class="tv-val">${fmtUsd(p.listUsd)}</span>`;
      return `<div class="tv-task" ${agTipAttrs(p.name, mainVal, tipRows)}>
        <span class="tv-name${p.isOther ? " ag-other-lbl" : ""}" title="${esc(p.name)}">${esc(p.name)}</span>
        <span class="tv-tbar"><span class="ag-sbar" style="width:${barPct}%">${p.models.map((m) => `<i style="flex-grow:${m.weight};background:${m.color}"></i>`).join("")}</span></span>
        <span class="ag-nums">${numsHtml}</span>
      </div>`;
    }).join("")}</div>` : "";

  // 3. Gemini (riga compatta + per modello in tonalità di blu).
  const gemShades = ["var(--ag-gem-1)", "var(--ag-gem-2)", "var(--ag-gem-3)"];
  const maxGem = Math.max(1, ...gemini.models.map((m) => m.count));
  const gemListEur = gemini.listUsd * AG_USD_EUR;
  // Il risparmio ha senso solo se tutte le chiamate del periodo hanno i token: altrimenti si confronterebbe
  // il canone intero con il listino di una parte delle chiamate.
  const gemSave = costs.geminiFeeEur !== null && gemListEur > 0 && gemini.priced === gemini.calls
    ? Math.round((1 - costs.geminiFeeEur / gemListEur) * 100) : null;
  const gemCostText = costs.geminiFeeEur !== null
    ? `${fmtEur(costs.geminiFeeEur)} (canone)`
    : "non stimabile";
  const gemListNote = gemini.priced
    ? `A listino $${(Math.round(gemini.listUsd * 100) / 100).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} su ${fmtInt(gemini.priced)} chiamate con i token${gemSave !== null ? ` · risparmio ${gemSave}%` : ""}${gemini.priced < gemini.calls ? ` (le altre ${fmtInt(gemini.calls - gemini.priced)} sono senza token)` : ""}.`
    : "I token di Gemini si registrano dal 24/11/2026: niente listino per queste chiamate.";
  const gemHtml = `<h3 class="tv-h">Gemini</h3>
    <section class="ag-card ag-gem-card">${gemini.calls ? `
      <div class="ag-gem-stats">
        <div class="tv-total"><span>Chiamate</span><b>${fmtInt(gemini.ok)}/${fmtInt(gemini.calls)}</b></div>
        <div class="tv-total"><span>Tempo</span><b>${fmtDur(gemini.secs)}</b></div>
        <div class="tv-total"><span>File modificati</span><b>${fmtInt(gemini.changed)}</b></div>
        <div class="tv-total"><span>Spesa</span><b class="ag-gem-cost">${esc(gemCostText)}</b></div>
      </div>
      <p class="ag-note">${esc(gemListNote)}</p>
      <div class="ag-gem-list">${gemini.models.map((m, idx) => `<div class="tv-task">
        <span class="tv-name" title="${esc(m.model)}">${esc(m.name)}</span>
        <span class="tv-tbar"><i style="width:${(m.count / maxGem) * 100}%;background:${gemShades[idx % gemShades.length]}"></i></span>
        <span class="ag-nums"><span class="tv-val">${fmtInt(m.count)}</span><span class="ag-sec">${fmtDur(m.secs)}</span></span>
      </div>`).join("")}</div>`
      : `<p class="ag-note">Nessuna chiamata Gemini in questo periodo.${costs.geminiFeeEur !== null ? ` Canone periodo: ${fmtEur(costs.geminiFeeEur)}.` : ""}</p>`}
    </section>`;

  return `${summaryHtml}${breakevenHtml}${modelsHtml}${projCostHtml}${gemHtml}`;
}

/* ---------- Interazione e tooltip Vista Agenti ---------- */

let agTipPinned = null;

function showAgTip(target, clientX, clientY, anchorAbove = false) {
  const title = target.dataset.agTip;
  if (!title) return;
  const val = target.dataset.agVal || "";
  let rows = [];
  if (target.dataset.agRows) {
    try { rows = JSON.parse(target.dataset.agRows); } catch { rows = []; }
  }
  tip.innerHTML = `<div class="when">${esc(title)}${val ? `<b>${esc(val)}</b>` : ""}</div>${rows.map((r) => `<div class="row">${r.color ? `<i class="sw" style="background:${esc(r.color)}"></i>` : ""}<span>${esc(r.label)}</span>${r.val ? `<b>${esc(r.val)}</b>` : ""}</div>`).join("")}`;
  tip.hidden = false;
  const w = tip.offsetWidth;
  const hgt = tip.offsetHeight;
  let x, y;
  if (anchorAbove) {
    const r = target.getBoundingClientRect();
    x = r.left + r.width / 2 - w / 2;
    y = r.top - hgt - 8;
    if (y < 8) y = r.bottom + 8;
  } else {
    x = clientX + 14;
    if (x + w > innerWidth - 8) x = clientX - w - 14;
    y = clientY - hgt / 2;
  }
  tip.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  tip.style.top = `${Math.max(8, Math.min(y, innerHeight - hgt - 8))}px`;
}

function hideAgTip() {
  if (agTipPinned) {
    agTipPinned.classList.remove("is-active");
    agTipPinned = null;
  }
  tip.hidden = true;
}

document.getElementById("agenti").addEventListener("click", (e) => {
  const b = e.target.closest("[data-a]");
  if (b) {
    hideAgTip();
    const action = b.dataset.a;
    if (action === "prev") A.offset -= 1;
    else if (action === "next") A.offset = Math.min(0, A.offset + 1);
    else if (action === "now") A.offset = 0;
    else if (action.startsWith("tab-")) { A.tab = action.slice(4); store("agenti.scheda", A.tab); }
    else if (action.startsWith("per-")) { A.period = action.slice(4); A.offset = 0; store("agenti.periodo", A.period); }
    else return;
    renderAgents();
    return;
  }
  // Tooltip al tocco (e clic su barre/punti/righe con dettaglio).
  const target = e.target.closest("[data-ag-tip]");
  if (target) {
    if (agTipPinned === target) return hideAgTip();
    if (agTipPinned) agTipPinned.classList.remove("is-active");
    agTipPinned = target;
    target.classList.add("is-active");
    showAgTip(target, e.clientX, e.clientY, true);
    return;
  }
  hideAgTip();
});

document.getElementById("agenti").addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" || agTipPinned) return;
  const target = e.target.closest("[data-ag-tip]");
  if (!target) { tip.hidden = true; return; }
  showAgTip(target, e.clientX, e.clientY, false);
});
document.getElementById("agenti").addEventListener("pointerleave", () => { if (!agTipPinned) tip.hidden = true; });
document.getElementById("agenti").addEventListener("scroll", () => { if (agTipPinned) hideAgTip(); }, { passive: true });

/* ---------- Avvio ---------- */

const LOGIN_ERRORS = {
  "auth/popup-closed-by-user": "",
  "auth/cancelled-popup-request": "",
  "auth/popup-blocked": "Il browser ha bloccato la finestra di accesso.",
  "auth/network-request-failed": "Connessione assente, riprova.",
};

function showLogin(message = "") {
  document.body.classList.add("login-page");
  document.getElementById("accesso").hidden = false;
  document.getElementById("app").hidden = true;
  const box = document.getElementById("errore");
  box.textContent = message;
  box.hidden = !message;
}

document.getElementById("entra").addEventListener("click", async () => {
  try {
    await Store.login();
  } catch (error) {
    showLogin(LOGIN_ERRORS[error.code] ?? `Accesso non riuscito (${error.code || error.message}).`);
  }
});
// Il logo apre un piccolo menu con Esci: si usa di rado, non merita un'icona nella barra.
document.querySelector(".brand").addEventListener("click", (e) => {
  e.preventDefault();
  pop(e.currentTarget, `<div class="menu"><button data-m="reload">Ricarica la bacheca</button><button data-m="logout">Esci</button></div>`, (el) => {
    el.classList.add("pop-menu", "pop-narrow");
    el.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-m]");
      if (!b) return;
      closePop();
      if (b.dataset.m === "reload") location.reload();
      if (b.dataset.m === "logout") Store.logout();
    });
  });
});

let first = true;
Store.start({
  onUser(user) {
    S.board = null;
    if (!user) { first = true; return showLogin(); }
    document.body.classList.remove("login-page");
    document.getElementById("accesso").hidden = true;
    document.getElementById("app").hidden = false;
  },
  onChange() {
    if (!first) return changed();
    first = false;
    refresh();
    fromHash();
    setView(load("vista", "bacheca"));
  },
  // Errori della lettura della bacheca: un rifiuto qui vuol dire che l'account non è tra quelli ammessi.
  onError(error) {
    if (error?.code === "permission-denied") {
      Store.logout().then(() => showLogin("Questo account Google non è abilitato."));
    } else {
      toast(failure(error));
    }
  },
  // Errori di una modifica inviata (anche ore dopo, dalla coda offline): si avvisa senza uscire.
  // Se invece la sessione è stata revocata ci pensa Firebase Auth a riportare alla schermata di accesso.
  onWriteError(error) {
    if (error?.code === "permission-denied" || error?.code === "not-found") {
      toast("Una modifica è stata rifiutata dal server: la bacheca mostra di nuovo la versione salvata.");
    } else {
      toast(failure(error));
    }
  },
});

// Offline la bacheca funziona dalla cache: qui si mostra se si è offline e quante modifiche aspettano il server.
// Online le scritture si confermano in un attimo: l'indicatore compare solo se ci mettono più di 1,5 secondi.
let syncTimer, wasOffline = false;
Store.onSyncStatus(({ online, pending }) => {
  const box = document.getElementById("sync");
  clearTimeout(syncTimer);
  const waiting = pending ? ` · ${pending} da sincronizzare` : "";
  if (!online) {
    wasOffline = true;
    box.textContent = "Offline" + waiting;
    box.className = "sync offline";
    box.hidden = false;
  } else if (pending) {
    syncTimer = setTimeout(() => {
      box.textContent = `Sincronizzo ${pending}…`;
      box.className = "sync";
      box.hidden = false;
    }, wasOffline ? 0 : 1500);
  } else {
    box.hidden = true;
    if (wasOffline) toast("Modifiche sincronizzate.");
    wasOffline = false;
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  // Clic su una notifica con la bacheca già aperta: sw.js chiede di aprire la scheda.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.open) location.hash = new URL(e.data.open, location.origin).hash;
  });
}
updateInstallButton();
