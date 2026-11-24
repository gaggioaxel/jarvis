// Dati della bacheca su Firestore. Le stesse operazioni che faceva il server, eseguite qui:
// ogni chiamata lavora su una copia della bacheca e scrive solo i documenti che cambiano.
//   bacheca/stato            colonne ed etichette
//   schede/{id}              una scheda intera (checklist, commenti, allegati)
//   allegati/{id}            un file allegato; i byte stanno in allegati/{id}/parti/{n}
//   dispositivi/{id}         un dispositivo che riceve le notifiche (iscrizione Web Push)
//   avvisi/agenda            le notifiche in arrivo, tenute dal Worker (mcp-worker/src/avvisi.ts)
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signInWithCredential,
  signOut, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
  initializeFirestore, connectFirestoreEmulator, collection, doc, onSnapshot, writeBatch, setDoc, getDoc, getDocs,
  Bytes, deleteField, persistentLocalCache, persistentMultipleTabManager, disableNetwork, enableNetwork,
  increment, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const MAX_UPLOAD = 10 * 1024 * 1024;
const PART = 900 * 1024; // un documento Firestore arriva a 1 MiB
const COLORS = new Set(["", "green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink", "black"]);
export const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]);

// Valori dell'istanza: config.js (generato da scripts/genera.py) definisce self.JARVIS prima dei moduli.
export const CONFIG = self.JARVIS || {};
export const OWNER = CONFIG.owner_name || "Utente";

// Colonne della prima apertura: "Questa settimana" più gli ambiti della config che stanno in bacheca.
const DEFAULT_LISTS = [
  { id: "settimana", name: "Questa settimana", kind: "week", color: "" },
  ...(CONFIG.areas || [{ id: "lavoro", name: "Lavoro", color: "blue" }])
    .filter((a) => a.board !== false)
    .map((a) => ({ id: a.id, name: a.name, kind: "area", color: a.color || "" })),
];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let auth, db;
const cache = { stato: null, statoExists: false, cards: new Map(), ready: { stato: false, cards: false } };

/* ---------- Commenti e checklist per id ----------
   Su Firestore commenti, checklist e voci di una scheda sono mappe id -> elemento (17 novembre), non elenchi:
   ogni modifica scrive solo quello che tocca (comments.<id>, checklists.<id>.items.<id>.done, ...). Così una
   modifica fatta offline con la vista vecchia si somma a quelle arrivate intanto invece di sostituirle;
   si scontrano solo due modifiche allo stesso campo dello stesso elemento, e lì vince l'ultima.
   L'app lavora con gli elenchi: i commenti in ordine di creazione, checklist e voci in ordine di `pos`. */
const KEYED = ["comments", "checklists"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const byCreated = (a, b) => (a.created || "").localeCompare(b.created || "") || (a.id || "").localeCompare(b.id || "");
const byPos = (a, b) => (a.pos ?? 0) - (b.pos ?? 0) || (a.id || "").localeCompare(b.id || "");
const unpos = ({ pos, ...rest }) => rest;
const keyed = (items, extra = (x) => x) => Object.fromEntries(items.map((x, i) => [x.id, extra({ ...clone(x), pos: i })]));

// Dalla mappa su Firestore all'elenco dell'app.
function listField(key, value) {
  const all = Object.values(value || {});
  if (key === "comments") return all.sort(byCreated);
  return all.sort(byPos).map((cl) => ({ ...unpos(cl), items: Object.values(cl.items || {}).sort(byPos).map(unpos) }));
}
// Dall'elenco dell'app alla mappa su Firestore.
function docField(key, items) {
  if (key === "comments") return Object.fromEntries((items || []).map((m) => [m.id, clone(m)]));
  return keyed(items || [], (cl) => ({ ...cl, items: keyed(cl.items || []) }));
}
function fromDoc(data) {
  const card = { comments: [], checklists: [], ...data };
  for (const k of KEYED) card[k] = listField(k, card[k]);
  return card;
}
function toDoc(card) {
  const out = clone(card);
  for (const k of KEYED) out[k] = docField(k, card[k]);
  return out;
}
let unsubscribe = [];

async function config() {
  if (LOCAL) return { apiKey: "locale", projectId: "demo-bacheca", authDomain: location.host };
  // Offline la risposta arriva dalla cache del service worker; in più se ne tiene una copia qui.
  let cfg;
  try {
    cfg = await (await fetch("/__/firebase/init.json")).json();
    localStorage.setItem("firebase-config", JSON.stringify(cfg));
  } catch (error) {
    cfg = JSON.parse(localStorage.getItem("firebase-config") || "null");
    if (!cfg) throw error;
  }
  // Accesso dallo stesso dominio della pagina: niente cookie di terze parti.
  return { ...cfg, authDomain: location.host };
}

/* ---------- Stato della sincronizzazione ----------
   Con la cache persistente ogni modifica vale subito in locale (e la vede onSnapshot); il commit
   si chiude solo quando il server conferma. Offline resta in coda in IndexedDB, anche chiudendo l'app,
   e parte da solo al ritorno della rete. Qui si contano le modifiche non ancora confermate. */
let pending = 0;
let statusListener = () => {};
let writeErrorListener = () => {};

function syncStatus() {
  return { online: navigator.onLine, pending };
}
function notifyStatus() {
  statusListener(syncStatus());
}
export function onSyncStatus(listener) {
  statusListener = listener;
  notifyStatus();
}
addEventListener("online", () => { notifyStatus(); dropQueuedFiles(); });
addEventListener("offline", notifyStatus);

function track(promise) {
  pending++;
  notifyStatus();
  promise.catch((error) => writeErrorListener(error)).finally(() => { pending--; notifyStatus(); });
}

export async function start({ onUser, onChange, onError, onWriteError }) {
  const app = initializeApp(await config());
  auth = getAuth(app);
  // Gli errori delle scritture in coda arrivano a parte: un rifiuto non vuol dire che l'account non vale più.
  writeErrorListener = onWriteError || onError;
  // Cache su IndexedDB: la bacheca si apre e si modifica anche senza rete.
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  if (LOCAL) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8085);
    // Solo con l'emulatore: entra con una mail qualsiasi, per le prove.
    window.provaAccesso = (email) => signInWithCredential(auth,
      GoogleAuthProvider.credential(JSON.stringify({ sub: email, email, email_verified: true })));
    // Per provare le modifiche offline: provaRete(false) stacca Firestore dal server, provaRete(true) lo riattacca.
    window.provaRete = (on) => (on ? enableNetwork(db) : disableNetwork(db));
  }
  onAuthStateChanged(auth, (user) => {
    unsubscribe.forEach((u) => u());
    unsubscribe = [];
    cache.ready = { stato: false, cards: false };
    cache.cards.clear();
    onUser(user);
    if (!user) return;
    dropQueuedFiles();
    refreshPush();
    const fire = () => { if (cache.ready.stato && cache.ready.cards) onChange(); };
    unsubscribe.push(onSnapshot(doc(db, "bacheca", "stato"), (snap) => {
      cache.statoExists = snap.exists();
      cache.stato = snap.exists() ? snap.data() : { lists: DEFAULT_LISTS, labels: [] };
      cache.ready.stato = true;
      fire();
    }, onError));
    unsubscribe.push(onSnapshot(collection(db, "schede"), (snap) => {
      for (const change of snap.docChanges()) {
        const id = change.doc.id;
        if (change.type === "removed") cache.cards.delete(id);
        else cache.cards.set(id, fromDoc(change.doc.data()));
      }
      cache.ready.cards = true;
      fire();
    }, onError));
  });
}

export async function login() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  // Installata nella Home di iOS i popup non tornano all'app: si passa dalla pagina intera.
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) {
    return signInWithRedirect(auth, provider);
  }
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    // Dove i popup non si aprono si passa dalla pagina intera.
    if (error.code === "auth/popup-blocked") return signInWithRedirect(auth, provider);
    throw error;
  }
}
export const logout = () => signOut(auth);

export function board() {
  return {
    lists: cache.stato.lists,
    labels: cache.stato.labels,
    ...(cache.stato.avvisi ? { avvisi: cache.stato.avvisi } : {}),
    cards: [...cache.cards.values()],
    chi: "utente",
  };
}

// Minuti per progetto e giorno, caricati da Claude con `jb.py ore`: [{date, rows: [{code, name, area, focus, agents}]}].
export async function hours() {
  const snap = await getDocs(collection(db, "ore"));
  return snap.docs.map((d) => d.data()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Uso dei modelli per giorno, caricati con `jb.py agenti`: [{date, updated, rows, limits, gemini}].
export async function agents() {
  const snap = await getDocs(collection(db, "agenti"));
  return snap.docs
    .map((d) => { const data = d.data(); return { ...data, date: data.date || d.id }; })
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

/* ---------- Notifiche su questo dispositivo ----------
   Web Push standard: il browser si iscrive con la chiave pubblica VAPID del Worker e l'iscrizione
   (endpoint e chiavi) va in dispositivi/{id}. Il Worker manda le notifiche; sw.js le mostra.
   Su iPhone funziona solo con la bacheca installata nella Home (iOS 16.4 o successivo). */
const VAPID_PUBLIC = CONFIG.vapid_public || "";
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function deviceId() {
  let id = localStorage.getItem("bacheca.dispositivo");
  if (!id) { id = newId() + newId(); localStorage.setItem("bacheca.dispositivo", id); }
  return id;
}
function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || isIOS() ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Dispositivo";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return `${os}${browser ? " · " + browser : ""}${isStandalone() ? " (app)" : ""}`;
}

// "unsupported" | "install" (iPhone: prima va installata) | "denied" | "off" | "on"
export async function pushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIOS() && !isStandalone() ? "install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" && localStorage.getItem("bacheca.notifiche") === "si" ? "on" : "off";
}

async function saveSubscription(sub) {
  const json = sub.toJSON();
  await setDoc(doc(db, "dispositivi", deviceId()), {
    endpoint: json.endpoint, keys: json.keys, nome: deviceName(), aggiornato: now(),
  }, { merge: true });
  localStorage.setItem("bacheca.notifiche", "si");
  localStorage.setItem("bacheca.notifiche-endpoint", json.endpoint);
}

// Da chiamare dal clic di un pulsante: iOS chiede il permesso solo dopo un gesto.
export async function enablePush() {
  if (LOCAL) throw new HttpError(400, "Con gli emulatori le notifiche non partono.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new HttpError(403, "Permesso per le notifiche non concesso.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = unb64u(VAPID_PUBLIC);
  const current = sub?.options?.applicationServerKey;
  if (sub && current && !new Uint8Array(current).every((x, i) => x === key[i])) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await saveSubscription(sub);
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
  localStorage.removeItem("bacheca.notifiche");
  localStorage.removeItem("bacheca.notifiche-endpoint");
  await deleteDoc(doc(db, "dispositivi", deviceId()));
}

// Il Worker manda una notifica di prova a questo dispositivo entro un minuto.
export async function testPush() {
  await setDoc(doc(db, "avvisi", "agenda"), { prova: { dispositivo: deviceId(), chiesta: serverTimestamp() } }, { merge: true });
}

// All'avvio: se il browser ha cambiato iscrizione (succede), si aggiorna il dispositivo.
async function refreshPush() {
  try {
    if (localStorage.getItem("bacheca.notifiche") !== "si" || !("PushManager" in window) || Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(VAPID_PUBLIC) });
    if (sub.endpoint !== localStorage.getItem("bacheca.notifiche-endpoint")) await saveSubscription(sub);
  } catch { /* si riprova al prossimo avvio */ }
}

/* ---------- Scrittura ---------- */

const clone = (value) => JSON.parse(JSON.stringify(value));

// Si scrivono solo i campi cambiati, non la scheda intera: una modifica fatta offline non cancella
// quello che intanto Claude ha scritto sulla stessa scheda in altri campi (un commento, il tempo).
// Resta "vince l'ultimo" solo sullo stesso campo.
function changedFields(before, after, skip = new Set()) {
  const out = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (skip.has(key)) continue;
    if (!(key in after)) out[key] = deleteField();
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = clone(after[key]);
  }
  return out;
}

// Percorsi cambiati tra due mappe: si scende finché entrambi i lati sono mappe, poi si scrive il valore.
function diffPaths(before, after, prefix, out) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const path = `${prefix}.${key}`;
    if (!(key in after)) out[path] = deleteField();
    else if (!(key in before)) out[path] = clone(after[key]);
    else if (isObj(before[key]) && isObj(after[key])) diffPaths(before[key], after[key], path, out);
    else if (!same(before[key], after[key])) out[path] = clone(after[key]);
  }
  return out;
}

// Commenti e checklist: solo i percorsi toccati.
function keyedChanges(prev, card) {
  const out = {};
  for (const k of KEYED) diffPaths(docField(k, prev[k]), docField(k, card[k]), k, out);
  return out;
}

// I campi di bacheca/stato: colonne, etichette e notifiche predefinite (solo se ci sono).
const STATO = ["lists", "labels", "avvisi"];
const statoOf = (b) => Object.fromEntries(STATO.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));

// Quello che conta per le notifiche: se cambia, il Worker rilegge le schede (avvisi/agenda.richieste).
const alertSig = (c) => JSON.stringify([c.title, c.due, c.reminders, c.done, c.archived,
  (c.checklists || []).map((cl) => (cl.items || []).map((i) => [i.id, i.text, i.due, i.reminders, i.done]))]);

function commit(before, after) {
  const batch = writeBatch(db);
  let n = 0;
  let alerts = false;
  const stato = statoOf(after);
  if (!cache.statoExists) {
    batch.set(doc(db, "bacheca", "stato"), clone(stato));
    n++;
  } else {
    const diff = changedFields(statoOf(before), stato);
    if (Object.keys(diff).length) { batch.update(doc(db, "bacheca", "stato"), diff); n++; }
  }
  const old = new Map(before.cards.map((c) => [c.id, c]));
  for (const c of after.cards) {
    const prev = old.get(c.id);
    if (!prev) {
      batch.set(doc(db, "schede", c.id), toDoc(c));
      n++;
      alerts ||= Boolean(c.due || c.checklists?.some((cl) => cl.items.some((i) => i.due)));
    } else {
      const diff = { ...changedFields(prev, c, new Set(KEYED)), ...keyedChanges(prev, c) };
      if (Object.keys(diff).length) { batch.update(doc(db, "schede", c.id), diff); n++; }
      alerts ||= alertSig(prev) !== alertSig(c);
    }
    old.delete(c.id);
  }
  for (const id of old.keys()) { batch.delete(doc(db, "schede", id)); n++; alerts = true; }
  if (alerts) batch.set(doc(db, "avvisi", "agenda"), { richieste: increment(1) }, { merge: true });
  // La copia in memoria si aggiorna subito: onSnapshot arriva qualche istante dopo il commit, e la
  // finestra della scheda si ridisegnava prima, ancora con i dati vecchi (voci e commenti "spariti").
  // Se il server rifiuta la scrittura, onSnapshot riporta la versione salvata.
  if (n) {
    cache.stato = { ...cache.stato, ...clone(stato) };
    cache.statoExists = true;
    cache.cards = new Map(after.cards.map((c) => [c.id, clone(c)]));
  }
  // Non si aspetta il server: la modifica è già nella cache locale e offline la conferma arriverebbe solo al ritorno della rete.
  if (n) track(batch.commit());
}

/* ---------- Validazione, come sul server ---------- */

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const newId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");

function text(value, limit, field) {
  if (typeof value !== "string") throw new HttpError(400, `${field}: serve un testo`);
  if (value.length > limit) throw new HttpError(400, `${field}: troppo lungo`);
  return value;
}
function date(value, field) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value) || isNaN(new Date(value))) {
    throw new HttpError(400, `${field}: data non valida`);
  }
  return value;
}
/* ---------- Notifiche delle scadenze (20 novembre) ----------
   `reminders` su schede e voci: "10m", "1h", "1g", "1s" (minuti, ore, giorni, settimane prima della scadenza),
   "0g@09:00", "1g@18:00" (il giorno stesso, il giorno prima, ... a quell'ora). Le scadenze senza ora valgono
   come alle 9:00. Una scadenza nuova prende gli avvisi predefiniti (bacheca/stato.avvisi); senza scadenza
   gli avvisi si tolgono. Le manda il Worker (mcp-worker/src/avvisi.ts), ogni minuto. */
const REMINDER = /^(\d{1,3})([mhgs])(?:@(\d{1,2}):(\d{2}))?$/;
const UNIT_MIN = { m: 1, h: 60, g: 1440, s: 10080 };
export const DEFAULT_ALERTS = { schede: ["1g@09:00"], voci: ["0g@09:00"] };
export function normalizeReminder(code) {
  const m = String(code ?? "").trim().toLowerCase().match(REMINDER);
  if (!m) return null;
  const [, n, u, hh, mm] = m;
  if (hh === undefined) return `${+n}${u}`;
  if ((u !== "g" && u !== "s") || +hh > 23 || +mm > 59) return null;
  return `${+n}${u}@${hh.padStart(2, "0")}:${mm}`;
}
function reminderWeight(code) {
  const m = code.match(REMINDER);
  const base = +m[1] * UNIT_MIN[m[2]];
  return m[3] === undefined ? base : base + 1440 - (+m[3] * 60 + +m[4]);
}
export function sortReminders(codes) {
  return [...new Set(codes)].sort((a, b) => reminderWeight(a) - reminderWeight(b));
}
function reminders(value) {
  if (!Array.isArray(value)) throw new HttpError(400, "notifiche: serve un elenco");
  const out = value.map((v) => {
    const c = normalizeReminder(v);
    if (!c) throw new HttpError(400, `notifica non valida: ${v}`);
    return c;
  });
  if (out.length > 10) throw new HttpError(400, "al massimo 10 notifiche");
  return sortReminders(out);
}
export function alertDefaults(b, kind) {
  return Array.isArray(b.avvisi?.[kind]) ? b.avvisi[kind] : DEFAULT_ALERTS[kind];
}
// Scadenza e notifiche insieme: una scadenza nuova prende le predefinite, senza scadenza non ce ne sono.
function applyDue(b, target, d, kind) {
  if ("due" in d) target.due = date(d.due, "scadenza");
  if ("reminders" in d) target.reminders = reminders(d.reminders);
  else if ("due" in d && target.due && target.reminders === undefined) target.reminders = [...alertDefaults(b, kind)];
  if (!target.due) delete target.reminders;
}

function color(value) {
  if (!COLORS.has(value)) throw new HttpError(400, "colore non valido");
  return value;
}
function priority(value) {
  const n = value === "" || value === null ? 0 : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 5) throw new HttpError(400, "priorità: da 1 (più alta) a 5, 0 per toglierla");
  return n;
}
function bool(value, field) {
  if (typeof value !== "boolean") throw new HttpError(400, `${field}: serve true o false`);
  return value;
}
function find(items, id, what) {
  const item = items.find((x) => x.id === id);
  if (!item) throw new HttpError(404, `${what} inesistente`);
  return item;
}
const clamp = (i, n) => Math.max(0, Math.min(parseInt(i, 10) || 0, n));

class Board {
  constructor(data) { Object.assign(this, data); }
  list(id) { return find(this.lists, id, "colonna"); }
  card(id) { return find(this.cards, id, "scheda"); }
  label(id) { return find(this.labels, id, "etichetta"); }
  column(id) { return this.cards.filter((c) => c.list === id && !c.archived).sort((a, b) => a.pos - b.pos); }
  firstArea() { return this.lists.find((l) => l.kind === "area").id; }
  // Dall'alto: P1…P5, poi le schede senza priorità; a parità resta l'ordine di prima.
  sortByPriority(listId) {
    const rank = (c) => (c.priority >= 1 && c.priority <= 5 ? c.priority : 6);
    this.column(listId).sort((a, b) => rank(a) - rank(b) || a.pos - b.pos).forEach((c, pos) => { c.pos = pos; });
  }
  place(card, listId, index) {
    const others = this.column(listId).filter((c) => c !== card);
    others.splice(index === undefined || index === null ? others.length : clamp(index, others.length), 0, card);
    card.list = listId;
    others.forEach((c, pos) => { c.pos = pos; });
    // A mano si ordina solo tra le schede della stessa priorità: fuori dal suo gruppo la scheda torna al bordo.
    this.sortByPriority(listId);
  }
  archive(card, value) {
    if (value === card.archived) return;
    if (value) {
      if (this.list(card.list).kind === "week") card.list = card.area;
      card.archived = true;
      card.archivedAt = now();
      this.column(card.list).forEach((c, pos) => { c.pos = pos; });
    } else {
      card.archived = false;
      card.archivedAt = "";
      this.place(card, card.list);
    }
  }
}

function newItem(data, b) {
  const t = text(data.text ?? "", 1000, "testo").trim();
  if (!t) throw new HttpError(400, "voce vuota");
  const item = { id: newId(), text: t, done: Boolean(data.done), due: "" };
  if (data.due) applyDue(b, item, { due: data.due, ...("reminders" in data ? { reminders: data.reminders } : {}) }, "voci");
  return item;
}

/* ---------- Sottovoci (19 novembre) ----------
   Una voce può avere sotto-voci: `parent` è l'id di un'altra voce della stessa checklist, fino a 3 livelli.
   L'elenco resta piatto (ordine di `pos`); l'albero si legge da `parent`. Spuntare una voce spunta tutte le sue
   sotto-voci; una voce con sotto-voci è fatta quando lo sono tutte. Eliminarla elimina anche le sotto-voci. */
export const MAX_DEPTH = 3;
const kidsOf = (items, id) => items.filter((x) => (x.parent || "") === id);
function subtree(items, item) {
  const out = [item];
  for (let i = 0; i < out.length; i++) out.push(...kidsOf(items, out[i].id));
  return out;
}
function depth(items, item) {
  let n = 1;
  for (let p = item.parent; p; p = items.find((x) => x.id === p)?.parent) n++;
  return n;
}
const height = (items, item) => 1 + Math.max(0, ...kidsOf(items, item.id).map((k) => height(items, k)));
// Le voci madri seguono le figlie: fatta solo se lo sono tutte.
function syncUp(items, parentId) {
  for (let p = items.find((x) => x.id === parentId); p; p = items.find((x) => x.id === p.parent)) {
    const kids = kidsOf(items, p.id);
    if (kids.length) p.done = kids.every((k) => k.done);
  }
}
function setDone(items, item, value) {
  for (const x of subtree(items, item)) x.done = value;
  syncUp(items, item.parent);
}
// Toglie la voce con le sue sotto-voci dall'elenco e le rimette subito dopo `after` (con le sue sotto-voci).
function relocate(items, item, after) {
  const block = subtree(items, item);
  const rest = items.filter((x) => !block.includes(x));
  const anchor = after ? subtree(rest, after).at(-1) : null;
  rest.splice(anchor ? rest.indexOf(anchor) + 1 : rest.length, 0, ...block);
  items.splice(0, items.length, ...rest);
}
function reparent(items, item, parentId) {
  const old = item.parent || "";
  if (parentId === old) return;
  if (parentId) {
    const p = find(items, parentId, "voce madre");
    if (subtree(items, item).includes(p)) throw new HttpError(400, "una voce non va sotto sé stessa");
    if (depth(items, p) + height(items, item) > MAX_DEPTH) throw new HttpError(400, `al massimo ${MAX_DEPTH} livelli`);
    const oldParent = old && items.find((x) => x.id === old);
    item.parent = p.id;
    // Se sale a un antenato del vecchio padre resta subito dopo di lui, non in fondo al nuovo padre.
    const up = oldParent && subtree(items, p).includes(oldParent);
    relocate(items, item, up ? oldParent : p);
  } else {
    delete item.parent;
    relocate(items, item, items.find((x) => x.id === old));
  }
  syncUp(items, old);
  syncUp(items, item.parent);
}

/* ---------- Operazioni ---------- */

const ROUTES = [];
const route = (method, pattern, fn) => ROUTES.push([method, new RegExp(`^${pattern}$`), fn]);

route("POST", "/api/colonne", (b, d) => {
  const item = { id: newId(), name: text(d.name ?? "", 80, "nome").trim() || "Nuova colonna", kind: "area", color: color(d.color ?? "") };
  b.lists.push(item);
  return item;
});
route("PATCH", "/api/colonne/([\\w-]+)", (b, d, id) => {
  const item = b.list(id);
  if ("name" in d) item.name = text(d.name, 80, "nome").trim() || item.name;
  if ("color" in d) item.color = color(d.color);
  if ("subtitle" in d) item.subtitle = text(d.subtitle, 200, "sottotitolo").trim();
  if ("notes" in d) item.notes = text(d.notes, 50000, "note");
  if ("index" in d && item.kind === "area") {
    const rest = b.lists.filter((x) => x.kind === "area" && x !== item);
    rest.splice(clamp(d.index, rest.length), 0, item);
    b.lists = [...b.lists.filter((x) => x.kind === "week"), ...rest];
  }
  return item;
});
route("DELETE", "/api/colonne/([\\w-]+)", (b, d, id) => {
  const item = b.list(id);
  if (item.kind === "week") throw new HttpError(400, "la colonna della settimana resta");
  if (b.cards.some((c) => c.list === id || c.area === id)) throw new HttpError(400, "la colonna contiene schede, anche in archivio");
  b.lists = b.lists.filter((x) => x !== item);
});

route("PATCH", "/api/avvisi", (b, d) => {
  const next = { ...DEFAULT_ALERTS, ...(b.avvisi || {}) };
  for (const kind of ["schede", "voci"]) if (kind in d) next[kind] = reminders(d[kind]);
  b.avvisi = next;
  return next;
});

route("POST", "/api/etichette", (b, d) => {
  const item = { id: newId(), name: text(d.name ?? "", 60, "nome").trim(), color: color(d.color ?? "blue") || "blue" };
  b.labels.push(item);
  return item;
});
route("PATCH", "/api/etichette/(\\w+)", (b, d, id) => {
  const item = b.label(id);
  if ("name" in d) item.name = text(d.name, 60, "nome").trim();
  if ("color" in d) item.color = color(d.color) || item.color;
  return item;
});
route("DELETE", "/api/etichette/(\\w+)", (b, d, id) => {
  b.label(id);
  b.labels = b.labels.filter((x) => x.id !== id);
  for (const c of b.cards) c.labels = c.labels.filter((x) => x !== id);
});

route("POST", "/api/schede", (b, d) => {
  const target = b.list(d.list || b.firstArea());
  // In Questa settimana non si creano schede: si creano in un ambito e poi ci si spostano.
  if (target.kind === "week") throw new HttpError(400, "In Questa settimana non si creano schede: creala in un ambito e trascinala qui.");
  const area = d.area || (target.kind === "area" ? target.id : b.firstArea());
  if (b.list(area).kind !== "area") throw new HttpError(400, "l'ambito deve essere una colonna di ambito");
  const title = text(d.title ?? "", 300, "titolo").trim();
  if (!title) throw new HttpError(400, "titolo vuoto");
  const c = {
    id: newId(), list: target.id, area, pos: 0, title, desc: text(d.desc ?? "", 50000, "descrizione"),
    color: color(d.color ?? ""), labels: [], due: "", priority: priority(d.priority ?? 0), done: false, archived: false, archivedAt: "",
    created: now(), updated: now(), checklists: [], attachments: [], comments: [],
  };
  if (d.due) applyDue(b, c, d, "schede");
  b.cards.push(c);
  b.place(c, target.id, d.top ? 0 : undefined);
  return c;
});
route("PATCH", "/api/schede/(\\w+)", (b, d, id) => {
  const c = b.card(id);
  if ("title" in d) c.title = text(d.title, 300, "titolo").trim() || c.title;
  if ("desc" in d) c.desc = text(d.desc, 50000, "descrizione");
  if ("due" in d || "reminders" in d) applyDue(b, c, d, "schede");
  if ("priority" in d) c.priority = priority(d.priority);
  if ("done" in d) c.done = bool(d.done, "done");
  if ("labels" in d) {
    if (!Array.isArray(d.labels)) throw new HttpError(400, "labels: serve una lista");
    c.labels = [...new Set(d.labels)].map((x) => b.label(x).id);
  }
  if ("area" in d) {
    if (b.list(d.area).kind !== "area") throw new HttpError(400, "l'ambito deve essere una colonna di ambito");
    c.area = d.area;
    if (c.archived) c.list = d.area;
    else if (b.list(c.list).kind === "area") b.place(c, d.area);
  }
  if ("archived" in d) b.archive(c, bool(d.archived, "archived"));
  // Cambiando la priorità la colonna si riordina da sola.
  if ("priority" in d && !c.archived) b.sortByPriority(c.list);
  c.updated = now();
  return c;
});
route("POST", "/api/schede/(\\w+)/sposta", (b, d, id) => {
  const c = b.card(id);
  const target = b.list(d.list ?? c.list);
  if (c.archived) b.archive(c, false);
  if (target.kind === "area") c.area = target.id;
  b.place(c, target.id, d.index);
  c.updated = now();
  return c;
});
route("DELETE", "/api/schede/(\\w+)", (b, d, id) => {
  const c = b.card(id);
  b.cards = b.cards.filter((x) => x !== c);
  return { files: c.attachments.filter((a) => a.kind === "file").map((a) => a.id) };
});

route("POST", "/api/schede/(\\w+)/checklist", (b, d, id) => {
  const c = b.card(id);
  const cl = { id: newId(), title: text(d.title ?? "", 200, "titolo").trim() || "Checklist", hideDone: false, items: [] };
  for (const line of d.items || []) cl.items.push(newItem(typeof line === "object" ? line : { text: line }, b));
  c.checklists.push(cl);
  c.updated = now();
  return cl;
});
route("PATCH", "/api/schede/(\\w+)/checklist/(\\w+)", (b, d, id, clId) => {
  const c = b.card(id);
  const cl = find(c.checklists, clId, "checklist");
  if ("title" in d) cl.title = text(d.title, 200, "titolo").trim() || cl.title;
  if ("hideDone" in d) cl.hideDone = bool(d.hideDone, "hideDone");
  c.updated = now();
  return cl;
});
route("DELETE", "/api/schede/(\\w+)/checklist/(\\w+)", (b, d, id, clId) => {
  const c = b.card(id);
  find(c.checklists, clId, "checklist");
  c.checklists = c.checklists.filter((x) => x.id !== clId);
  c.updated = now();
});
route("POST", "/api/schede/(\\w+)/checklist/(\\w+)/voci", (b, d, id, clId) => {
  const c = b.card(id);
  const cl = find(c.checklists, clId, "checklist");
  // texts: righe; con depths (0 = sotto `parent`, 1 = sotto la riga precedente di livello 0, ...) si incolla un elenco annidato.
  const texts = Array.isArray(d.texts) ? d.texts : [d.text];
  const base = d.parent ? find(cl.items, d.parent, "voce madre") : null;
  const baseDepth = base ? depth(cl.items, base) : 0;
  if (baseDepth >= MAX_DEPTH) throw new HttpError(400, `al massimo ${MAX_DEPTH} livelli`);
  const stack = [base];
  const items = texts.map((t, i) => {
    const item = newItem({ ...d, text: t }, b);
    const lvl = Math.max(0, Math.min(parseInt(d.depths?.[i], 10) || 0, stack.length - 1, MAX_DEPTH - baseDepth - 1));
    stack.length = lvl + 1;
    if (stack[lvl]) item.parent = stack[lvl].id;
    stack.push(item);
    return item;
  });
  if (base) {
    const at = cl.items.indexOf(subtree(cl.items, base).at(-1)) + 1;
    cl.items.splice(at, 0, ...items);
  } else cl.items.push(...items);
  if (base) syncUp(cl.items, base.id);
  c.updated = now();
  return items[0];
});
route("PATCH", "/api/schede/(\\w+)/checklist/(\\w+)/voci/(\\w+)", (b, d, id, clId, itemId) => {
  const c = b.card(id);
  const cl = find(c.checklists, clId, "checklist");
  const item = find(cl.items, itemId, "voce");
  if ("text" in d) item.text = text(d.text, 1000, "testo").trim() || item.text;
  if ("done" in d) setDone(cl.items, item, bool(d.done, "done"));
  if ("due" in d || "reminders" in d) applyDue(b, item, d, "voci");
  if ("parent" in d) reparent(cl.items, item, d.parent ? text(d.parent, 20, "parent") : "");
  if ("index" in d) {
    cl.items = cl.items.filter((x) => x !== item);
    cl.items.splice(clamp(d.index, cl.items.length), 0, item);
  }
  c.updated = now();
  return item;
});
route("DELETE", "/api/schede/(\\w+)/checklist/(\\w+)/voci/(\\w+)", (b, d, id, clId, itemId) => {
  const c = b.card(id);
  const cl = find(c.checklists, clId, "checklist");
  const item = find(cl.items, itemId, "voce");
  const gone = subtree(cl.items, item);
  cl.items = cl.items.filter((x) => !gone.includes(x));
  syncUp(cl.items, item.parent);
  c.updated = now();
});

route("POST", "/api/schede/(\\w+)/commenti", (b, d, id) => {
  const c = b.card(id);
  const body = text(d.text ?? "", 20000, "testo").trim();
  if (!body) throw new HttpError(400, "commento vuoto");
  const m = { id: newId(), author: "utente", text: body, created: now(), edited: "", resolved: false, resolvedAt: "", replyTo: "" };
  if (d.replyTo) {
    const parent = find(c.comments, d.replyTo, "commento");
    m.replyTo = parent.id;
    if (d.resolve) { parent.resolved = true; parent.resolvedAt = now(); }
  }
  c.comments.push(m);
  c.updated = now();
  return m;
});
route("PATCH", "/api/schede/(\\w+)/commenti/(\\w+)", (b, d, id, cid) => {
  const c = b.card(id);
  const m = find(c.comments, cid, "commento");
  if ("text" in d) {
    if (m.author !== "utente") throw new HttpError(403, "si modificano solo i propri commenti");
    m.text = text(d.text, 20000, "testo").trim() || m.text;
    m.edited = now();
  }
  if ("resolved" in d) {
    m.resolved = bool(d.resolved, "resolved");
    m.resolvedAt = m.resolved ? now() : "";
  }
  return m;
});
route("DELETE", "/api/schede/(\\w+)/commenti/(\\w+)", (b, d, id, cid) => {
  const c = b.card(id);
  const m = find(c.comments, cid, "commento");
  // Il proprietario elimina anche i commenti di Claude (quelli non validi o già chiusi), con le risposte.
  c.comments = c.comments.filter((x) => x.id !== m.id && x.replyTo !== m.id);
});

route("POST", "/api/schede/(\\w+)/allegati", (b, d, id) => {
  const c = b.card(id);
  let a;
  if (d.file) {
    a = { id: d.file.id, kind: "file", name: d.file.name, url: "", size: d.file.size, type: d.file.type, created: now() };
  } else {
    const url = text(d.url ?? "", 2000, "url").trim();
    if (!/^https?:\/\//.test(url)) throw new HttpError(400, "il link deve iniziare con http:// o https://");
    a = { id: newId(), kind: "link", name: text(d.name ?? "", 200, "nome").trim() || url, url, size: 0, type: "", created: now() };
  }
  c.attachments.push(a);
  c.updated = now();
  return a;
});
route("DELETE", "/api/schede/(\\w+)/allegati/(\\w+)", (b, d, id, aid) => {
  const c = b.card(id);
  const a = find(c.attachments, aid, "allegato");
  c.attachments = c.attachments.filter((x) => x !== a);
  c.updated = now();
  return { files: a.kind === "file" ? [a.id] : [] };
});

/* ---------- Annulla ----------
   Ogni operazione ricorda com'erano prima le cose che ha toccato (schede, colonne, etichette), per un'ora.
   Annullare rimette i valori di prima solo nei campi che da allora non sono cambiati: se intanto Claude
   ha aggiunto un commento o spuntato una voce sulla stessa scheda, quello resta. I commenti si annullano
   uno per uno. Non si annulla l'eliminazione di una scheda con file allegati: i file sono già cancellati. */
const UNDO_MS = 60 * 60 * 1000;
const undoStack = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function describe(method, path, body) {
  if (path.includes("/commenti")) return method === "POST" ? "nuovo commento" : method === "DELETE" ? "commento eliminato" : "modifica al commento";
  if (path.includes("/voci")) {
    if (method === "POST") return "nuova voce";
    if (method === "DELETE") return "voce eliminata";
    if ("parent" in body) return body.parent ? "voce spostata sotto un'altra" : "voce spostata fuori";
    if ("due" in body) return body.due ? "scadenza della voce" : "scadenza della voce tolta";
    if ("reminders" in body) return "notifiche della voce";
    return "done" in body ? (body.done ? "voce spuntata" : "voce tolta la spunta") : "modifica alla voce";
  }
  if (path.includes("/checklist")) return method === "POST" ? "nuova checklist" : method === "DELETE" ? "checklist eliminata" : "modifica alla checklist";
  if (path.includes("/allegati")) return method === "POST" ? "allegato aggiunto" : "allegato tolto";
  if (path.endsWith("/sposta")) return "spostamento della scheda";
  if (path.startsWith("/api/schede")) {
    if (method === "POST") return "nuova scheda";
    if (method === "DELETE") return "scheda eliminata";
    const keys = Object.keys(body);
    if (keys.includes("due")) return body.due ? "modifica: scadenza" : "scadenza tolta";
    if (keys.includes("reminders")) return "modifica: notifiche";
    const names = { desc: "descrizione", title: "titolo", due: "scadenza", priority: "priorità", labels: "etichette", color: "colore", area: "ambito", done: "completata", archived: body.archived ? "archiviazione" : "ripristino" };
    return keys.length === 1 && names[keys[0]] ? `modifica: ${names[keys[0]]}` : "modifica alla scheda";
  }
  if (path.startsWith("/api/colonne")) return method === "POST" ? "nuova colonna" : method === "DELETE" ? "colonna eliminata" : "modifica alla colonna";
  if (path === "/api/avvisi") return "notifiche predefinite";
  if (path.startsWith("/api/etichette")) return method === "POST" ? "nuova etichetta" : method === "DELETE" ? "etichetta eliminata" : "modifica all'etichetta";
  return "modifica";
}

function remember(label, before, after) {
  const was = new Map(before.cards.map((c) => [c.id, c]));
  const cards = [];
  for (const c of after.cards) {
    const prev = was.get(c.id);
    if (!prev || !same(prev, c)) cards.push({ id: c.id, before: prev ? clone(prev) : null, after: clone(c) });
    was.delete(c.id);
  }
  for (const [id, prev] of was) cards.push({ id, before: clone(prev), after: null });
  const stato = STATO.some((k) => !same(before[k], after[k]))
    ? { before: clone(statoOf(before)), after: clone(statoOf(after)) }
    : null;
  if (!cards.length && !stato) return;
  undoStack.push({ label, at: Date.now(), cards, stato });
}

function prune() {
  while (undoStack.length && Date.now() - undoStack[0].at > UNDO_MS) undoStack.shift();
}

// Quello che si annullerebbe adesso, per il pulsante: null se non c'è niente.
export function undoLabel() {
  prune();
  return undoStack.at(-1)?.label ?? null;
}

// Commenti e checklist, sulle mappe per id: ogni campo toccato torna com'era se nel frattempo non è
// cambiato; se è cambiato e da tutte e tre le parti è una mappa, si scende e si guarda dentro.
function undoPaths(now, before, after) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[key], a = after[key], n = now[key];
    if (same(b, a)) continue;
    if (same(n, a)) { if (key in before) now[key] = clone(b); else delete now[key]; }
    else if (isObj(n) && isObj(a) && isObj(b)) undoPaths(n, b, a);
  }
  return now;
}

// Colonne ed etichette: ogni elemento (per id) e ogni suo campo torna com'era se nel frattempo non è cambiato,
// anche se intanto sono cambiate altre colonne. Una colonna nuova si toglie solo se è ancora vuota.
function undoById(now, before, after, inUse) {
  const byId = (arr) => new Map((arr || []).map((x) => [x.id, x]));
  const b = byId(before), a = byId(after);
  let out = [...(now || [])];
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const was = b.get(id), then = a.get(id);
    const at = out.findIndex((x) => x.id === id);
    if (was && !then) { if (at === -1) out.splice(Math.min(before.indexOf(was), out.length), 0, clone(was)); continue; }
    if (!was && then) { if (at !== -1 && same(out[at], then) && !inUse(id)) out.splice(at, 1); continue; }
    if (at === -1 || same(was, then)) continue;
    const cur = { ...out[at] };
    for (const k of new Set([...Object.keys(was), ...Object.keys(then)])) {
      if (!same(cur[k], then[k])) continue;
      if (k in was) cur[k] = clone(was[k]); else delete cur[k];
    }
    out[at] = cur;
  }
  // L'ordine torna com'era solo se quello di allora non è stato cambiato di nuovo.
  const common = (before || []).map((x) => x.id).filter((id) => a.has(id) && out.some((x) => x.id === id));
  const order = (arr) => arr.map((x) => x.id).filter((id) => common.includes(id));
  if (same(order(out), order(after)) && !same(order(out), common)) {
    const slots = out.map((x, i) => (common.includes(x.id) ? i : -1)).filter((i) => i !== -1);
    const items = common.map((id) => out.find((x) => x.id === id));
    slots.forEach((slot, n) => { out[slot] = items[n]; });
  }
  return out;
}

export function undo() {
  if (!cache.ready.stato || !cache.ready.cards) throw new HttpError(503, "bacheca non ancora caricata");
  prune();
  const entry = undoStack.pop();
  if (!entry) return null;
  const current = board();
  const next = new Board(clone(current));
  if (entry.stato) {
    const inUse = (id) => next.cards.some((c) => c.list === id || c.area === id || c.labels?.includes(id));
    for (const k of ["lists", "labels"]) {
      if (!same(entry.stato.before[k], entry.stato.after[k])) next[k] = undoById(next[k], entry.stato.before[k], entry.stato.after[k], inUse);
    }
    for (const k of STATO.filter((x) => x === "avvisi")) {
      if (!same(next[k], entry.stato.after[k])) continue;
      if (entry.stato.before[k] === undefined) delete next[k];
      else next[k] = clone(entry.stato.before[k]);
    }
  }
  for (const { id, before, after } of entry.cards) {
    const now = next.cards.find((c) => c.id === id);
    if (!after) { if (!now) next.cards.push(clone(before)); continue; } // era stata eliminata: torna
    if (!before) { next.cards = next.cards.filter((c) => c.id !== id); continue; } // era nuova: si toglie
    if (!now) continue; // eliminata dopo: niente da rimettere
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (KEYED.includes(k)) now[k] = listField(k, undoPaths(docField(k, now[k]), docField(k, before[k]), docField(k, after[k])));
      else if (same(now[k], after[k])) { if (k in before) now[k] = clone(before[k]); else delete now[k]; }
    }
  }
  commit(current, next);
  return entry.label;
}

export async function call(method, path, body = {}, raw) {
  if (!cache.ready.stato || !cache.ready.cards) throw new HttpError(503, "bacheca non ancora caricata");
  if (raw) {
    if (!navigator.onLine) throw new HttpError(503, "Gli allegati si caricano solo online.");
    body = { file: await putFile(raw) };
  }
  for (const [verb, pattern, fn] of ROUTES) {
    const match = path.match(pattern);
    if (verb !== method || !match) continue;
    const before = board();
    const next = new Board(clone(before));
    const result = fn(next, body || {}, ...match.slice(1));
    commit(before, next);
    if (result?.files?.length) undoStack.length = 0; // file cancellati: da qui non si torna indietro
    else remember(describe(method, path, body || {}), before, next);
    if (result?.files) result.files.forEach(queueDropFile);
    return result && !result.files ? clone(result) : null;
  }
  throw new HttpError(404, "percorso inesistente");
}

/* ---------- File allegati ---------- */

async function putFile({ body, type, name }) {
  if (body.size > MAX_UPLOAD) throw new HttpError(413, `${name}: oltre ${MAX_UPLOAD / 1048576} MB`);
  const bytes = new Uint8Array(await body.arrayBuffer());
  const id = newId();
  const parts = Math.max(1, Math.ceil(bytes.length / PART));
  for (let i = 0; i < parts; i++) {
    await setDoc(doc(db, "allegati", id, "parti", String(i)), { data: Bytes.fromUint8Array(bytes.subarray(i * PART, (i + 1) * PART)) });
  }
  const meta = {
    id, parts, size: bytes.length, created: now(),
    name: (name || "allegato").replace(/[\x00-\x1f/\\]/g, "_").slice(0, 200),
    type: /^[\w.+-]+\/[\w.+-]+$/.test(type || "") ? type : "application/octet-stream",
  };
  await setDoc(doc(db, "allegati", id), meta);
  return meta;
}

async function dropFile(id) {
  const parts = await getDocs(collection(db, "allegati", id, "parti"));
  const batch = writeBatch(db);
  parts.forEach((p) => batch.delete(p.ref));
  batch.delete(doc(db, "allegati", id));
  await batch.commit();
  blobs.delete(id);
}

// Per cancellare i pezzi di un allegato bisogna elencarli dal server: offline l'id resta in coda
// (in localStorage) e si cancella al ritorno della rete.
const DROP_QUEUE = "allegati-da-togliere";
const droppedQueue = () => { try { return JSON.parse(localStorage.getItem(DROP_QUEUE) || "[]"); } catch { return []; } };
function queueDropFile(id) {
  localStorage.setItem(DROP_QUEUE, JSON.stringify([...new Set([...droppedQueue(), id])]));
  dropQueuedFiles();
}
async function dropQueuedFiles() {
  if (!db || !navigator.onLine) return;
  for (const id of droppedQueue()) {
    try {
      await dropFile(id);
      localStorage.setItem(DROP_QUEUE, JSON.stringify(droppedQueue().filter((x) => x !== id)));
    } catch { /* si riprova al prossimo ritorno online */ }
  }
}

const blobs = new Map();
export async function fileBlob(id) {
  if (blobs.has(id)) return blobs.get(id);
  const meta = await getDoc(doc(db, "allegati", id));
  if (!meta.exists()) throw new HttpError(404, "allegato inesistente");
  const { parts, type } = meta.data();
  const chunks = [];
  for (let i = 0; i < parts; i++) {
    const part = await getDoc(doc(db, "allegati", id, "parti", String(i)));
    chunks.push(part.data().data.toUint8Array());
  }
  const blob = new Blob(chunks, { type: INLINE_TYPES.has(type) ? type : "application/octet-stream" });
  blobs.set(id, blob);
  return blob;
}
