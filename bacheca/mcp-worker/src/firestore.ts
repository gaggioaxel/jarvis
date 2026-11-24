// Firestore via REST con l'account di servizio, come jb.py: JWT firmato con la chiave e scambiato con un token di Google.

export interface Env {
  BACHECA_SA: string; // JSON della chiave dell'account di servizio (secret)
  ALLOWED_EMAIL: string; // le mail che possono autorizzare il connettore, separate da virgole
  FIREBASE_PROJECT: string;
  LOGIN_PAGE: string; // pagina di accesso su Firebase Hosting
  BACHECA_URL?: string; // indirizzo della bacheca (predefinito https://<FIREBASE_PROJECT>.web.app)
  OWNER_NAME?: string; // nome del proprietario nei testi degli strumenti
  TIMEZONE?: string; // fuso delle scadenze e degli avvisi (predefinito Europe/Rome)
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  VAPID_KEY: string; // JSON {publicKey, jwk} della chiave per le notifiche (secret)
}

export class Conflict extends Error {}
export class Fail extends Error {} // l'equivalente dei sys.exit() di jb.py: errore da mostrare così com'è

type Doc = { name: string; fields?: Record<string, any>; updateTime: string };

let cached: { token: string; until: number; account: string } | null = null;

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function accessToken(env: Env): Promise<string> {
  const key = JSON.parse(env.BACHECA_SA);
  const stamp = Math.floor(Date.now() / 1000);
  if (cached && cached.account === key.client_email && stamp < cached.until) return cached.token;
  const pem = key.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const signer = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.private_key_id })) + "." +
    b64url(JSON.stringify({
      iss: key.client_email, scope: "https://www.googleapis.com/auth/datastore",
      aud: key.token_uri, iat: stamp, exp: stamp + 3600,
    }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(unsigned));
  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(signature)}`,
    }),
  });
  if (!res.ok) throw new Error(`token Google: ${res.status} ${await res.text()}`);
  const answer: any = await res.json();
  // Come jb.py: si rinnova dopo 50 minuti.
  cached = { token: answer.access_token, until: stamp + 50 * 60, account: key.client_email };
  return cached.token;
}

export class Store {
  base: string;
  constructor(private env: Env) {
    this.base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents`;
  }

  async call(method: string, path: string, body?: unknown, query?: Record<string, string>, retry = true): Promise<any> {
    const url = this.base + path + (query ? "?" + new URLSearchParams(query) : "");
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken(this.env)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      const raw = await res.text();
      return raw ? JSON.parse(raw) : null;
    }
    const detail = await res.text();
    if (res.status === 401 && retry) {
      cached = null;
      return this.call(method, path, body, query, false);
    }
    if (res.status === 404 && method === "GET") return null;
    if (res.status === 409 || res.status === 412 || detail.includes("FAILED_PRECONDITION")) throw new Conflict(detail);
    throw new Error(`Firestore ${res.status}: ${detail}`);
  }

  async get(path: string): Promise<Doc | null> {
    return this.call("GET", path);
  }

  /** Tutti i documenti di una collezione, con il loro id. */
  async list(collection: string): Promise<any[]> {
    const found: any[] = [];
    let page: string | undefined;
    do {
      const data = (await this.call("GET", `/${collection}`, undefined, { pageSize: "300", ...(page ? { pageToken: page } : {}) })) || {};
      found.push(...(data.documents || []).map((d: Doc) => ({ id: d.name.split("/").pop(), ...fields(d) })));
      page = data.nextPageToken;
    } while (page);
    return found;
  }

  /** Scrive solo i campi elencati (quelli assenti da data si cancellano); crea il documento se manca. */
  async patch(path: string, data: Record<string, unknown>, mask: string[]) {
    const name = this.base.split("/v1/")[1] + `/${path}`;
    await this.call("POST", ":commit", { writes: [{
      update: { name, fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encode(v)])) },
      updateMask: { fieldPaths: mask },
    }] });
  }

  async remove(path: string) {
    await this.call("DELETE", `/${path}`);
  }

  /** Avvisa il controllo delle notifiche che una scadenza, un avviso o una spunta sono cambiati. */
  bumpWrite(): any {
    return { transform: {
      document: this.base.split("/v1/")[1] + "/avvisi/agenda",
      fieldTransforms: [{ fieldPath: "richieste", increment: { integerValue: "1" } }],
    } };
  }
  async bump() {
    await this.call("POST", ":commit", { writes: [this.bumpWrite()] });
  }

  async cards(): Promise<any[]> {
    const found: any[] = [];
    let page: string | undefined;
    do {
      const data = (await this.call("GET", "/schede", undefined, { pageSize: "300", ...(page ? { pageToken: page } : {}) })) || {};
      found.push(...(data.documents || []).map(fields));
      page = data.nextPageToken;
    } while (page);
    return found;
  }

  async stato(): Promise<{ lists: any[]; labels: any[] }> {
    const doc = await this.get("/bacheca/stato");
    return doc ? (fields(doc) as any) : { lists: [], labels: [] };
  }

  async board() {
    const [stato, cards] = await Promise.all([this.stato(), this.cards()]);
    return { ...stato, cards };
  }

  /** Riscrive il documento intero; con updateTime solo se nel frattempo non è cambiato. */
  async write(collection: string, id: string, data: Record<string, unknown>, updateTime?: string, bump = false) {
    const name = this.base.split("/v1/")[1] + `/${collection}/${id}`;
    if (collection === "schede") {
      data = { ...data };
      for (const k of KEYED) data[k] = docField(k, (data[k] as any[]) || []);
    }
    const op: any = { update: { name, fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encode(v)])) } };
    if (updateTime) op.currentDocument = { updateTime };
    await this.call("POST", ":commit", { writes: bump ? [op, this.bumpWrite()] : [op] });
  }

  /** Riordina le colonne dall'alto: P1…P5, poi le schede senza priorità; a parità resta l'ordine di prima.
   *  Scrive solo il campo pos delle schede che cambiano posto, tutte in un commit. */
  async sortByPriority(listIds: string[]) {
    const rank = (c: any) => ([1, 2, 3, 4, 5].includes(c.priority) ? c.priority : 6);
    const base = this.base.split("/v1/")[1];
    const every = await this.cards();
    const writes: any[] = [];
    for (const listId of new Set(listIds)) {
      const column = every.filter((c) => c.list === listId && !c.archived).sort((a, b) => a.pos - b.pos);
      [...column].sort((a, b) => rank(a) - rank(b) || a.pos - b.pos).forEach((c, pos) => {
        if (c.pos !== pos) writes.push({
          update: { name: `${base}/schede/${c.id}`, fields: { pos: encode(pos) } },
          updateMask: { fieldPaths: ["pos"] }, currentDocument: { exists: true },
        });
      });
    }
    if (writes.length) await this.call("POST", ":commit", { writes });
  }

  /** Legge, modifica e riscrive una scheda; se nel frattempo è cambiata riprova. */
  async modify<T>(cardId: string, change: (card: any) => T): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const doc = await this.get(`/schede/${encodeURIComponent(cardId)}`);
      if (!doc) throw new Fail(`Scheda inesistente: ${cardId}`);
      const card = fields(doc);
      const before = alertSig(card);
      const result = change(card);
      card.updated = now();
      try {
        await this.write("schede", cardId, card, doc.updateTime, alertSig(card) !== before);
        return result;
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Fail("La scheda continua a cambiare, riprova.");
  }
}

/** Quello che conta per le notifiche: se cambia, il Cron Trigger rilegge le schede. */
export function alertSig(c: any): string {
  return JSON.stringify([c.title, c.due, c.reminders, c.done, c.archived,
    (c.checklists || []).map((cl: any) => (cl.items || []).map((i: any) => [i.id, i.text, i.due, i.reminders, i.done]))]);
}

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function encode(value: unknown): any {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (typeof value === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)])) } };
  }
  throw new TypeError(`valore non supportato: ${value}`);
}

export function decode(value: any): any {
  const [kind, inner] = Object.entries(value)[0] as [string, any];
  if (kind === "integerValue") return parseInt(inner, 10);
  if (kind === "arrayValue") return (inner.values || []).map(decode);
  if (kind === "mapValue") return Object.fromEntries(Object.entries(inner.fields || {}).map(([k, v]) => [k, decode(v)]));
  if (kind === "nullValue") return null;
  return inner;
}

export function fields(doc: Doc): any {
  const data = Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, decode(v)]));
  if (doc.name?.includes("/schede/")) for (const k of KEYED) data[k] = listField(k, data[k] || {});
  return data;
}

// Commenti, checklist e voci stanno su Firestore come mappe id -> elemento (17 novembre), come in jb.py:
// l'app scrive solo l'elemento che tocca. Qui si lavora con gli elenchi: commenti per data, il resto per `pos`.
const KEYED = ["comments", "checklists"];

function byPos(byId: Record<string, any>): any[] {
  return Object.values(byId)
    .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || (a.id || "").localeCompare(b.id || ""))
    .map(({ pos, ...rest }) => rest);
}

export function listField(key: string, byId: Record<string, any>): any[] {
  if (key === "comments") {
    return Object.values(byId).sort((a, b) =>
      (a.created || "").localeCompare(b.created || "") || (a.id || "").localeCompare(b.id || ""));
  }
  return byPos(byId).map((cl) => ({ ...cl, items: byPos(cl.items || {}) }));
}

export function docField(key: string, items: any[]): Record<string, any> {
  if (key === "comments") return Object.fromEntries(items.map((c) => [c.id, c]));
  return Object.fromEntries(items.map((cl, i) => [cl.id, {
    ...cl, pos: i, items: Object.fromEntries((cl.items || []).map((it: any, j: number) => [it.id, { ...it, pos: j }])),
  }]));
}
