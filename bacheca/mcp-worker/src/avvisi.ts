// Notifiche delle scadenze (20 novembre), come gli avvisi di Google Calendar.
//
// Ogni scheda e ogni voce con una scadenza può avere `reminders`, un elenco di codici:
//   "10m", "1h", "1g", "1s"   10 minuti / 1 ora / 1 giorno / 1 settimana prima della scadenza
//   "0g@09:00", "1s@18:30"    il giorno stesso / 1 settimana prima, a quell'ora
// Le scadenze senza ora valgono come se fossero alle 9:00. Ora di Roma.
// Gli avvisi predefiniti per le nuove scadenze stanno in bacheca/stato.avvisi = {schede: [...], voci: [...]}.
//
// Recapito: Web Push standard (VAPID), senza Firebase Cloud Messaging. I dispositivi stanno in
// dispositivi/{id} = {endpoint, keys: {p256dh, auth}, nome}. Ogni minuto il Cron Trigger legge avvisi/agenda:
//   entries    gli avvisi in arrivo, in ordine di ora      inviati   chiave -> quando è partito
//   richieste  contatore che app, jb.py e Worker alzano quando cambia una scadenza, un avviso, una spunta
//   visto      il valore di richieste all'ultima lettura delle schede (se diverso si rileggono)
//   prova      {dispositivo} chiesto dall'app: manda una notifica di prova
// Le schede si rileggono solo quando richieste cambia, o ogni 6 ore: così si resta lontani dal limite di letture.
import { Env, Store, fields } from "./firestore";

import { CFG, configure } from "./config";
const CODE = /^(\d{1,3})([mhgs])(?:@(\d{1,2}):(\d{2}))?$/;
const UNIT_MIN: Record<string, number> = { m: 1, h: 60, g: 1440, s: 10080 };
export const DEFAULT_ALERTS = { schede: ["1g@09:00"], voci: ["0g@09:00"] };
const MAX = 10;

/** Codice valido e normalizzato ("01g@9:00" -> "1g@09:00"), o null. */
export function normalize(code: unknown): string | null {
  const m = String(code ?? "").trim().toLowerCase().match(CODE);
  if (!m) return null;
  const [, n, u, hh, mm] = m;
  if (hh !== undefined) {
    if (u !== "g" && u !== "s") return null;
    if (+hh > 23 || +mm > 59) return null;
    return `${+n}${u}@${hh.padStart(2, "0")}:${mm}`;
  }
  return `${+n}${u}`;
}

/** Minuti prima della fine del giorno di scadenza, per ordinare. */
function weight(code: string) {
  const m = code.match(CODE)!;
  const base = +m[1] * UNIT_MIN[m[2]];
  return m[3] === undefined ? base : base + 1440 - (+m[3] * 60 + +m[4]);
}

export function sortCodes(codes: string[]) {
  return [...new Set(codes)].sort((a, b) => weight(a) - weight(b));
}

/** Elenco di avvisi da un argomento degli strumenti; lancia un errore leggibile. */
export function parseCodes(value: unknown, fail: (msg: string) => Error): string[] {
  if (!Array.isArray(value)) throw fail('avvisi: serve un elenco, per esempio ["1g@09:00", "1h"]');
  const out = value.map((v) => {
    const c = normalize(v);
    if (!c) throw fail(`Avviso non valido: ${v}. Esempi: "10m", "1h", "1g", "1s" (minuti, ore, giorni, settimane prima), "0g@09:00" (il giorno stesso alle 9), "1g@18:00".`);
    return c;
  });
  if (out.length > MAX) throw fail(`Al massimo ${MAX} avvisi.`);
  return sortCodes(out);
}

export function describe(code: string): string {
  const m = code.match(CODE);
  if (!m) return code;
  const n = +m[1];
  const names: Record<string, [string, string]> = { m: ["minuto", "minuti"], h: ["ora", "ore"], g: ["giorno", "giorni"], s: ["settimana", "settimane"] };
  const unit = names[m[2]][n === 1 ? 0 : 1];
  if (m[3] !== undefined) {
    const at = `${+m[3]}:${m[4]}`;
    return n === 0 ? `il giorno stesso alle ${at}` : `${n} ${unit} prima alle ${at}`;
  }
  return n === 0 ? "all'ora della scadenza" : `${n} ${unit} prima`;
}

/* ---------- Ore di Roma ---------- */

function zoneOffset(utcMs: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: CFG.zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** Istante UTC di un'ora locale di Roma. */
function romeToUtc(y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - zoneOffset(guess);
  t = guess - zoneOffset(t);
  return t;
}

function romeParts(utcMs: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: CFG.zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

/** Quando parte un avviso: istante UTC in ms. */
export function fireAt(due: string, code: string): number | null {
  const m = code.match(CODE);
  const dm = due.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!m || !dm) return null;
  const [y, mo, d] = [+dm[1], +dm[2], +dm[3]];
  const n = +m[1];
  if (m[3] !== undefined) {
    const days = n * (m[2] === "s" ? 7 : 1);
    const day = new Date(Date.UTC(y, mo - 1, d - days));
    return romeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), +m[3], +m[4]);
  }
  const base = romeToUtc(y, mo, d, dm[4] !== undefined ? +dm[4] : 9, dm[5] !== undefined ? +dm[5] : 0);
  return base - n * UNIT_MIN[m[2]] * 60000;
}

const DAYS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

/** "Scade tra 10 minuti", "Scade oggi alle 15:00", "Scade domani", "Scade venerdì 27 novembre alle 9:30". */
export function whenText(due: string, nowMs: number): string {
  const dm = due.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!dm) return "";
  const timed = dm[4] !== undefined;
  const at = timed ? romeToUtc(+dm[1], +dm[2], +dm[3], +dm[4], +dm[5]) : null;
  const time = timed ? ` alle ${+dm[4]}:${dm[5]}` : "";
  if (at !== null && Math.abs(at - nowMs) < 90000) return `Scade adesso${time}`;
  if (at !== null && at < nowMs) return `Scaduta${time}`;
  if (at !== null && at - nowMs < 60 * 60000) {
    const mins = Math.max(1, Math.round((at - nowMs) / 60000));
    return `Scade tra ${mins} ${mins === 1 ? "minuto" : "minuti"}`;
  }
  const today = romeParts(nowMs);
  const dayNum = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d) / 86400000;
  const diff = dayNum(+dm[1], +dm[2], +dm[3]) - dayNum(today.y, today.mo, today.d);
  if (diff < 0) return `Scaduta il ${+dm[3]} ${MONTHS[+dm[2] - 1]}`;
  if (diff === 0) return `Scade oggi${time}`;
  if (diff === 1) return `Scade domani${time}`;
  const wd = DAYS[new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3])).getUTCDay()];
  const year = +dm[1] !== today.y ? ` ${dm[1]}` : "";
  return `Scade ${wd} ${+dm[3]} ${MONTHS[+dm[2] - 1]}${year}${time}`;
}

/** Testo della notifica (23 novembre). Sopra il sistema mette il nome dell'app (Jarvis); il titolo, in grassetto,
 *  è "colonna · scheda" (la colonna è l'ambito, anche quando la scheda è in Questa settimana); sotto, cosa scade.
 *  Scheda:  "Lavoro · L3 Relazione trimestrale" / "Scheda in scadenza oggi alle 15:00"
 *  Voce:    "Studio · S2 Esame" / "Ripassare il capitolo 4 · domani" */
export function message(e: Entry, nowMs: number): { title: string; body: string } {
  const clip = (t: string, n = 80) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);
  const when = whenText(e.due, nowMs).replace(/^Scade /, "").replace(/^Scaduta/, "scaduta");
  const head = (name: string) => clip(e.column ? `${e.column} · ${name}` : name, 100);
  if (!e.item) {
    return { title: head(e.title), body: when.startsWith("scaduta") ? `Scheda ${when}` : `Scheda in scadenza ${when}` };
  }
  return { title: head(e.context), body: `${clip(e.title)} · ${when}` };
}

/* ---------- Agenda ---------- */

interface Entry { at: number; key: string; card: string; item: string; title: string; context: string; due: string; column?: string }

/** Tutti gli avvisi delle schede e voci aperte, con la loro ora. column: il nome dell'ambito della scheda. */
export function collect(cards: any[], lists: any[] = []): Entry[] {
  const out: Entry[] = [];
  const names = new Map(lists.map((l) => [l.id, l.name]));
  for (const c of cards) {
    if (c.archived || c.done) continue;
    const column = names.get(c.area) || names.get(c.list) || "";
    const add = (due: string, codes: unknown, item: any) => {
      if (!due || !Array.isArray(codes)) return;
      for (const raw of codes) {
        const code = normalize(raw);
        const at = code && fireAt(due, code);
        if (!code || !at) continue;
        out.push({
          at, key: `${c.id}/${item?.id || "-"}/${due}/${code}`, card: c.id, item: item?.id || "",
          title: item ? item.text : c.title, context: item ? c.title : "", due, column,
        });
      }
    };
    add(c.due, c.reminders, null);
    for (const cl of c.checklists || []) for (const it of cl.items || []) if (!it.done) add(it.due, it.reminders, it);
  }
  return out.sort((a, b) => a.at - b.at);
}

const GRACE = 2 * 60000; // un avviso trovato in ritardo di al più 2 minuti parte lo stesso
// Il Cron Trigger gira una volta al minuto, ma non al secondo 0 (di solito verso il 47): un avviso parte
// dal giro più vicino alla sua ora, quindi al più 30 secondi prima o dopo.
const EARLY = 30000;
const LATE = 12 * 3600000; // oltre 12 ore di ritardo non parte più
const RESCAN = 6 * 3600000;
const KEEP_SENT = 60 * 86400000;

export async function runAlerts(env: Env, nowMs = Date.now()) {
  configure(env);
  const store = new Store(env);
  const doc = await store.get("/avvisi/agenda");
  const ag = doc ? fields(doc) : {};
  let entries: Entry[] = ag.entries || [];
  const sent: Record<string, string> = ag.inviati || {};
  const mask = new Set<string>();
  const richieste = Number(ag.richieste || 0);

  if (!doc || richieste !== ag.visto || !ag.scanned || nowMs - Date.parse(ag.scanned) > RESCAN) {
    const pending = new Set(entries.map((e) => e.key));
    const data = await store.board();
    entries = collect(data.cards, data.lists || [])
      .filter((e) => !sent[e.key] && (e.at >= nowMs - GRACE || pending.has(e.key)));
    Object.assign(ag, { visto: richieste, scanned: new Date(nowMs).toISOString() });
    ["entries", "visto", "scanned"].forEach((k) => mask.add(k));
  }

  const ready = entries.filter((e) => e.at <= nowMs + EARLY);
  if (ready.length || ag.prova) {
    const devices = await store.list("dispositivi");
    for (const e of ready) {
      if (nowMs - e.at <= LATE) {
        await pushAll(env, store, devices, { ...message(e, nowMs), url: `/#c/${e.card}`, tag: e.key });
      }
      sent[e.key] = new Date(nowMs).toISOString();
    }
    if (ag.prova) {
      const target = devices.filter((d) => !ag.prova.dispositivo || d.id === ag.prova.dispositivo);
      await pushAll(env, store, target, {
        title: "Notifiche attive", body: "Le scadenze della bacheca arriveranno qui.", url: "/", tag: "prova",
      });
      mask.add("prova");
      delete ag.prova;
    }
    if (ready.length) {
      entries = entries.filter((e) => !ready.includes(e));
      for (const [k, when] of Object.entries(sent)) if (nowMs - Date.parse(when) > KEEP_SENT) delete sent[k];
      ["entries", "inviati"].forEach((k) => mask.add(k));
    }
  }

  if (!mask.size) return { fired: 0 };
  const data: Record<string, unknown> = { entries, inviati: sent, visto: ag.visto, scanned: ag.scanned };
  await store.patch("avvisi/agenda", Object.fromEntries([...mask].filter((k) => k in data).map((k) => [k, data[k]])), [...mask]);
  return { fired: ready.length, scanned: mask.has("scanned"), entries: entries.length };
}

/* ---------- Web Push (RFC 8291 + VAPID, RFC 8292) ---------- */

const te = new TextEncoder();

function b64u(bytes: Uint8Array | ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** Cifra il messaggio per un dispositivo (aes128gcm, un solo record). */
export async function encrypt(p256dh: string, auth: string, payload: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const uaPublic = unb64u(p256dh);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, local.privateKey, 256));
  const ikm = await hkdf(unb64u(auth), shared, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

let vapidKey: CryptoKey | null = null;
async function vapidHeader(env: Env, endpoint: string) {
  const vapid = JSON.parse(env.VAPID_KEY);
  vapidKey ??= await crypto.subtle.importKey("jwk", { ...vapid.jwk, key_ops: ["sign"], ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const stamp = Math.floor(Date.now() / 1000);
  const unsigned = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))) + "." +
    b64u(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: stamp + 12 * 3600, sub: CFG.url })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapidKey, te.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

async function push(env: Env, device: any, message: Record<string, string>) {
  const body = await encrypt(device.keys.p256dh, device.keys.auth, te.encode(JSON.stringify(message)));
  return fetch(device.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(env, device.endpoint),
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      TTL: String(12 * 3600), Urgency: "high", Topic: message.tag.replace(/[^\w-]/g, "").slice(-32) || "avviso",
    },
    body,
  });
}

async function pushAll(env: Env, store: Store, devices: any[], message: Record<string, string>) {
  for (const d of devices) {
    if (!d.endpoint || !d.keys?.p256dh || !d.keys?.auth) continue;
    try {
      const res = await push(env, d, message);
      if (res.status === 404 || res.status === 410) {
        // Iscrizione scaduta o tolta dal browser: il dispositivo si toglie (si riattiva dall'app).
        await store.remove(`dispositivi/${d.id}`);
        console.log(`dispositivo ${d.id} tolto: ${res.status}`);
      } else if (!res.ok) {
        console.error(`push ${d.id} (${d.nome}): ${res.status} ${await res.text()}`);
      } else {
        console.log(`push ${d.id} (${d.nome}): ${message.title}`);
      }
    } catch (error) {
      console.error(`push ${d.id}:`, error);
    }
  }
}

