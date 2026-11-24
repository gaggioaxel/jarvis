// Gli strumenti MCP della bacheca: gli stessi comandi di jb.py (e di mcp_server.py), con le stesse uscite di testo.
import { Conflict, Fail, Store, fields, newId, now } from "./firestore";
import { DEFAULT_ALERTS, describe, parseCodes } from "./avvisi";
import { CFG } from "./config";

const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];

const s = (description: string) => ({ type: "string", description });
const i = (description: string) => ({ type: "integer", description });
const b = (description: string) => ({ type: "boolean", description });
const SCHEDA = s("id della scheda (8 caratteri esadecimali)");

type Args = Record<string, any>;
interface Tool {
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  writes?: boolean;
  run: (store: Store, a: Args) => Promise<string>;
}

function local(stamp: string | Date) {
  const d = typeof stamp === "string" ? new Date(stamp) : stamp;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("it-IT", {
    timeZone: CFG.zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, day: +parts.day, month: +parts.month, time: `${parts.hour}:${parts.minute}` };
}

function find(items: any[], id: string, what: string) {
  const item = items.find((x) => x.id === id);
  if (!item) throw new Fail(`${what} inesistente: ${id}`);
  return item;
}

function pickList(data: { lists: any[] }, wanted: string) {
  const w = wanted.toLowerCase();
  const item = data.lists.find((l) => l.id === w || l.name.toLowerCase() === w);
  if (!item) throw new Fail("Colonna inesistente: " + data.lists.map((l) => `${l.id} (${l.name})`).join(", "));
  return item;
}

function comment(author: string, text: string, replyTo = "") {
  return { id: newId(), author, text, created: now(), edited: "", resolved: false, resolvedAt: "", replyTo };
}

async function getCard(store: Store, id: string) {
  const doc = await store.get(`/schede/${encodeURIComponent(id)}`);
  if (!doc) throw new Fail(`Scheda inesistente: ${id}`);
  return fields(doc);
}


// Modifiche: le stesse regole di jb.py (edit_card, edit_item, edit_checklist, edit_comment).
const COLORS = new Set(["", "green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink", "black"]);
const COLORI = [...COLORS].filter(Boolean).sort().join(", ");
const DUE = s("scadenza AAAA-MM-GG o AAAA-MM-GGTHH:MM, vuota per toglierla");

function dueValue(value: any) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value) || isNaN(Date.parse(value)))
    throw new Fail(`Scadenza non valida: ${value} (AAAA-MM-GG o AAAA-MM-GGTHH:MM, vuota per toglierla)`);
  return value;
}

// Notifiche delle scadenze (20 novembre): codici come in avvisi.ts, regole come in static/store.js.
const AVVISI = {
  type: "array", items: { type: "string" },
  description: 'notifiche della scadenza (sostituiscono quelle attuali): "10m", "1h", "1g", "1s" = 10 minuti, 1 ora, 1 giorno, ' +
    '1 settimana prima; "0g@09:00" = il giorno stesso alle 9, "1g@18:00" = il giorno prima alle 18. Le scadenze senza ora ' +
    "valgono come alle 9:00. Se non lo passi, una nuova scadenza prende gli avvisi predefiniti; [] li toglie tutti.",
};
type Kind = "schede" | "voci";
function codesArg(a: Args) {
  return has(a, "avvisi") ? parseCodes(a.avvisi, (m) => new Fail(m)) : undefined;
}
async function alertDefaults(store: Store, kind: Kind, stato?: any): Promise<string[]> {
  const st: any = stato ?? (await store.stato());
  return Array.isArray(st.avvisi?.[kind]) ? st.avvisi[kind] : DEFAULT_ALERTS[kind];
}
/** Scadenza e avvisi di una scheda o voce: una scadenza nuova prende i predefiniti; senza scadenza niente avvisi. */
function applyDue(target: any, due: string | undefined, codes: string[] | undefined, defaults: string[]) {
  if (due !== undefined) target.due = due;
  if (codes !== undefined) {
    if (codes.length && !target.due) throw new Fail("Gli avvisi servono a una scadenza: passa anche scade.");
    target.reminders = codes;
  } else if (due && target.reminders === undefined) target.reminders = [...defaults];
  if (!target.due) delete target.reminders;
}
const alertsText = (x: any) => (x.due && x.reminders?.length ? `, avvisi: ${x.reminders.map(describe).join(", ")}` : "");

function flag(value: any, name: string) {
  if (typeof value !== "boolean") throw new Fail(`${name}: serve true o false`);
  return value;
}

function has(a: Args, key: string) {
  return a[key] !== undefined && a[key] !== null;
}

function noChanges(a: Args, ids: string[]) {
  if (!Object.keys(a).some((k) => !ids.includes(k) && has(a, k))) throw new Fail("Nessuna modifica.");
}

function moveTo(items: any[], item: any, index: number) {
  items.splice(items.indexOf(item), 1);
  items.splice(Math.max(0, Math.min(Math.trunc(index), items.length)), 0, item);
}

// pos per mettere la scheda nella colonna, in fondo o al posto index (0 = in cima), senza toccare le altre.
function slot(others: any[], card: any, listId: string, index?: number) {
  const column = others.filter((c) => c.list === listId && !c.archived && c.id !== card.id).map((c) => c.pos).sort((x, y) => x - y);
  if (index == null || index >= column.length) return column.length ? column[column.length - 1] + 1 : 0;
  const k = Math.max(0, Math.trunc(index));
  const before = k ? column[k - 1] : column[0] - 1;
  return (before + column[k]) / 2;
}

// Sottovoci (19 novembre): parent è l'id di un'altra voce della stessa checklist, fino a 3 livelli. Stesse regole di
// static/store.js: spuntare una voce spunta le sue sotto-voci, una voce madre è fatta quando lo sono tutte le figlie,
// eliminarla elimina anche le sotto-voci.
const MAX_DEPTH = 3;
const kidsOf = (items: any[], id: string) => items.filter((x) => (x.parent || "") === id);
function subtree(items: any[], item: any) {
  const out = [item];
  for (let i = 0; i < out.length; i++) out.push(...kidsOf(items, out[i].id));
  return out;
}
function depth(items: any[], item: any) {
  let n = 1;
  for (let p = item.parent; p; p = items.find((x) => x.id === p)?.parent) n++;
  return n;
}
const height = (items: any[], item: any): number => 1 + Math.max(0, ...kidsOf(items, item.id).map((k) => height(items, k)));
function syncUp(items: any[], parentId?: string) {
  for (let p = items.find((x) => x.id === parentId); p; p = items.find((x) => x.id === p.parent)) {
    const kids = kidsOf(items, p.id);
    if (kids.length) p.done = kids.every((k) => k.done);
  }
}
function setDone(items: any[], item: any, value: boolean) {
  for (const x of subtree(items, item)) x.done = value;
  syncUp(items, item.parent);
}
function relocate(items: any[], item: any, after: any) {
  const block = subtree(items, item);
  const rest = items.filter((x) => !block.includes(x));
  const anchor = after ? subtree(rest, after).at(-1) : null;
  rest.splice(anchor ? rest.indexOf(anchor) + 1 : rest.length, 0, ...block);
  items.splice(0, items.length, ...rest);
}
function reparent(items: any[], item: any, parentId: string) {
  const old = item.parent || "";
  if (parentId === old) return;
  if (parentId) {
    const p = find(items, parentId, "voce madre");
    if (subtree(items, item).includes(p)) throw new Fail("Una voce non va sotto sé stessa.");
    if (depth(items, p) + height(items, item) > MAX_DEPTH) throw new Fail(`Al massimo ${MAX_DEPTH} livelli.`);
    item.parent = p.id;
    relocate(items, item, p);
  } else {
    delete item.parent;
    relocate(items, item, items.find((x) => x.id === old));
  }
  syncUp(items, old);
  syncUp(items, item.parent);
}
const leaves = (items: any[]) => items.filter((i) => !items.some((x) => x.parent === i.id));

// Letture compatte (21 novembre): quello che torna resta nel contesto di Claude per tutta la chat, quindi si filtra
// qui e non dopo. Stesse regole di jb.py (card_line, card_filter, limited, searchable, brief_card).
function cardLine(c: any, column = "") {
  const items = c.checklists.flatMap((cl: any) => leaves(cl.items));
  const done = items.filter((x: any) => x.done).length;
  return `${c.id}  ${c.done ? "[x]" : "[ ]"} ${c.title}${c.priority ? ` P${c.priority}` : ""}` +
    `${items.length ? ` ${done}/${items.length}` : ""}${c.due ? ` scade ${c.due}` : ""}${column ? ` [${column}]` : ""}`;
}
const LIMITE = i("al massimo N schede (per colonna)");
const FILTRI = {
  aperte: b("solo le schede non fatte"),
  entro: i("solo le schede con scadenza (loro o di una voce aperta) entro N giorni, comprese le scadute"),
  limite: LIMITE,
};
const isFiltered = (a: Args) => !!a.aperte || has(a, "entro");
function cardFilter(a: Args) {
  const limit = has(a, "entro") ? local(new Date(Date.now() + Number(a.entro) * 86400_000)).date : "";
  const dueSoon = (c: any) => [c.due, ...c.checklists.flatMap((cl: any) => cl.items.filter((x: any) => x.due && !x.done).map((x: any) => x.due))]
    .some((d: string) => d && d.slice(0, 10) <= limit);
  return (c: any) => !(a.aperte && c.done) && (!limit || dueSoon(c));
}
function limited(lines: string[], cap: any) {
  const n = Number(cap);
  return n > 0 && lines.length > n ? [...lines.slice(0, n), `… altre ${lines.length - n}`] : lines;
}
function searchable(c: any) {
  return [c.title, c.desc ?? "", ...c.checklists.flatMap((cl: any) => [cl.title ?? "", ...cl.items.map((x: any) => x.text ?? "")]),
    ...c.comments.map((x: any) => x.text ?? "")].join("\n").toLowerCase();
}
const SKIP_FIELDS = new Set(["pos", "color"]); // pos è solo per l'ordine, il colore delle schede non c'è più
function briefCard(card: any, full: boolean) {
  let hidden = 0;
  card = { ...card };
  if (!full) {
    const closed = new Set(card.comments.filter((c: any) => c.resolved && !c.replyTo).map((c: any) => c.id));
    const keep = card.comments.filter((c: any) => !closed.has(c.id) && !closed.has(c.replyTo));
    [hidden, card.comments] = [card.comments.length - keep.length, keep];
  }
  const empty = (v: any) => v === "" || v == null || (Array.isArray(v) && !v.length) ||
    (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
  const prune = (x: any): any => Array.isArray(x) ? x.map(prune)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k, v]) => !SKIP_FIELDS.has(k) && !empty(v)).map(([k, v]) => [k, prune(v)]))
    : x;
  const out = prune(card);
  if (hidden) out.commenti_risolti_nascosti = hidden;
  return JSON.stringify(out);
}

export const TOOLS: Record<string, Tool> = {
  commenti: {
    description: "Commenti di {OWNER} ancora aperti (o tutti con tutti=true), con le risposte e il link alla scheda.",
    properties: { tutti: b("includi anche quelli risolti") }, required: [],
    async run(store, a) {
      const data = await store.board();
      const names = Object.fromEntries(data.lists.map((l) => [l.id, l.name]));
      const out: string[] = [];
      for (const card of data.cards) {
        if (card.archived) continue; // una scheda archiviata è chiusa: i suoi commenti non si citano più
        for (const c of card.comments) {
          if (c.author !== "utente" || c.replyTo || (!a.tutti && c.resolved)) continue;
          out.push(`## ${card.title} [${names[card.list] ?? ""}] scheda=${card.id} commento=${c.id} ${c.resolved ? "risolto" : "aperto"} ${c.created}`);
          out.push(`${CFG.url}/#c/${card.id}`);
          out.push(c.text + "\n");
          for (const r of card.comments.filter((r: any) => r.replyTo === c.id)) {
            out.push(`> ${r.author === "claude" ? "Claude" : CFG.owner}, ${r.created}:`);
            out.push("> " + r.text.replace(/\n/g, "\n> ") + "\n");
          }
        }
      }
      return out.length ? out.join("\n").trim() : "Nessun commento aperto.";
    },
  },

  cronologia: {
    description: "Commenti di {OWNER} degli ultimi N giorni (default 7) in ordine di tempo, con la scheda e lo stato. " +
      "Non sposta il segno di lettura di /buongiorno.",
    properties: { giorni: { type: "number", description: "ultimi N giorni (default 7)" } }, required: [],
    async run(store, a) {
      const since = new Date(Date.now() - (Number(a.giorni) || 7) * 86400_000);
      const data = await store.board();
      const names = Object.fromEntries(data.lists.map((l) => [l.id, l.name]));
      const found: [Date, any, any][] = [];
      for (const card of data.cards) {
        if (card.archived) continue; // le schede archiviate non entrano nella cronologia
        for (const c of card.comments) {
          if (c.author !== "utente") continue;
          const last = new Date(Math.max(...[c.created, c.edited].filter(Boolean).map((t: string) => Date.parse(t))));
          if (last > since) found.push([new Date(c.created), card, c]);
        }
      }
      found.sort((x, y) => +x[0] - +y[0]);
      const l = local(since);
      const out = [`Commenti di ${CFG.owner} dal ${l.day} ${MONTHS[l.month - 1]} ${l.time}: ${found.length}`];
      let day = "";
      for (const [created, card, c] of found) {
        const t = local(created);
        if (t.date !== day) {
          day = t.date;
          out.push(`\n### ${t.day} ${MONTHS[t.month - 1]}`);
        }
        const column = names[card.list] ?? card.list;
        let state: string;
        if (c.replyTo) {
          const parent = card.comments.find((p: any) => p.id === c.replyTo);
          state = "risposta a " + (parent?.author === "claude" ? "Claude" : "un commento");
        } else {
          state = c.resolved ? "risolto" : "aperto";
          if (card.comments.some((r: any) => r.replyTo === c.id && r.author === "claude")) state += ", Claude ha risposto";
        }
        out.push(`- ${t.time} · ${card.title} [${column}] · ${state}${c.edited ? ", modificato" : ""} · scheda=${card.id} commento=${c.id}`);
        out.push("  " + c.text.trim().replace(/\n/g, "\n  "));
      }
      return out.join("\n");
    },
  },

  colonna: {
    description: "Sottotitolo, note e schede non archiviate di una colonna, in ordine, una riga ciascuna con avanzamento " +
      "checklist e scadenza. Per esempio 'settimana' o il nome di un ambito.",
    properties: { colonna: s("id o nome della colonna"), ...FILTRI }, required: ["colonna"],
    async run(store, a) {
      const data = await store.board();
      const target = pickList(data, a.colonna);
      const keep = cardFilter(a);
      const column = data.cards.filter((c) => c.list === target.id && !c.archived && keep(c)).sort((x, y) => x.pos - y.pos);
      const head = (target.subtitle ? `# ${target.name} · ${target.subtitle}\n` : "") +
        (target.notes ? `Note della colonna:\n${String(target.notes).trim()}\n---\n` : "");
      return head + (limited(column.map((c) => cardLine(c)), a.limite).join("\n") || "Nessuna scheda.");
    },
  },

  cerca: {
    description: "Schede con il testo in titolo, descrizione, checklist o commenti, una riga ciascuna con la colonna.",
    properties: {
      testo: s("testo da cercare"), attive: b("escludi le archiviate"),
      colonna: s("solo le schede di questa colonna (id o nome)"), limite: LIMITE,
    },
    required: ["testo"],
    async run(store, a) {
      const needle = String(a.testo).toLowerCase();
      const data = await store.board();
      const names: Record<string, string> = Object.fromEntries(data.lists.map((l) => [l.id, l.name]));
      const target = a.colonna ? pickList(data, a.colonna).id : "";
      const hits = data.cards.filter((c) => searchable(c).includes(needle) && !(a.attive && c.archived) && (!target || c.list === target));
      return limited(hits.map((c) => cardLine(c, names[c.list] ?? "") + (c.archived ? " (archiviata)" : "")), a.limite).join("\n") ||
        "Nessuna scheda trovata.";
    },
  },

  scheda: {
    description: "Una scheda in JSON compatto: descrizione, checklist con id delle voci, commenti aperti con id, tempo, allegati. " +
      "I campi vuoti non ci sono; i commenti risolti si contano in commenti_risolti_nascosti (tutto=true li mostra).",
    properties: { scheda: SCHEDA, tutto: b("includi i commenti risolti") }, required: ["scheda"],
    async run(store, a) {
      return briefCard(await getCard(store, a.scheda), !!a.tutto);
    },
  },

  bacheca: {
    description: "Indice della bacheca: per ogni colonna una riga per scheda non archiviata (id, fatta, titolo, priorità, " +
      "avanzamento, scadenza), più le etichette. Per i dettagli usa scheda. completa=true dà tutto il JSON (grande).",
    properties: { ...FILTRI, completa: b("tutta la bacheca in JSON, con descrizioni e commenti") }, required: [],
    async run(store, a) {
      const data = await store.board();
      if (a.completa) return JSON.stringify(data, null, 1);
      const keep = cardFilter(a);
      const out: string[] = [];
      for (const l of data.lists) {
        const column = data.cards.filter((c) => c.list === l.id && !c.archived && keep(c)).sort((x, y) => x.pos - y.pos);
        if (!column.length && isFiltered(a)) continue; // filtrando, le colonne vuote non si mostrano
        out.push(`## ${l.name} (${l.id}, ${column.length})`, ...limited(column.map((c) => cardLine(c)), a.limite));
      }
      if (data.labels.length) out.push("Etichette: " + data.labels.map((l) => l.name).join(", "));
      return out.join("\n");
    },
  },

  nuova_scheda: {
    description: "Aggiunge una scheda in fondo a un ambito e ne restituisce l'id. In Questa settimana non si creano schede: " +
      "si crea nell'ambito e poi si sposta con modifica colonna='settimana'.",
    properties: { colonna: s("id o nome dell'ambito (non 'settimana')"), titolo: s("titolo della scheda") }, required: ["colonna", "titolo"],
    writes: true,
    async run(store, a) {
      const data = await store.board();
      const target = pickList(data, a.colonna);
      if (target.kind === "week") throw new Fail("In Questa settimana non si creano schede: creala in un ambito, poi spostala con modifica colonna='settimana'.");
      const area = target.id;
      const positions = data.cards.filter((c) => c.list === target.id && !c.archived).map((c) => c.pos);
      const title = String(a.titolo).trim();
      if (!title) throw new Fail("Titolo vuoto");
      const card = {
        id: newId(), list: target.id, area, pos: Math.max(-1, ...positions) + 1,
        title, desc: "", color: "", labels: [], due: "", priority: 0, done: false,
        archived: false, archivedAt: "", created: now(), updated: now(),
        checklists: [], attachments: [], comments: [],
      };
      await store.write("schede", card.id, card);
      return `${card.id}  ${card.title}\n${CFG.url}/#c/${card.id}`;
    },
  },

  aggiungi_voce: {
    description: "Aggiunge una voce di checklist a una scheda (nella prima checklist, o in quella indicata; " +
      "se non ce n'è una la crea). Con sotto è una sotto-voce di quella voce (fino a 3 livelli). Restituisce l'id della voce.",
    properties: {
      scheda: SCHEDA, testo: s("testo della voce"),
      checklist: s("id della checklist (facoltativo)"), scade: s("scadenza AAAA-MM-GG o AAAA-MM-GGTHH:MM (facoltativa)"),
      sotto: s("id della voce madre: la nuova voce va sotto di lei (facoltativo)"), avvisi: AVVISI,
    },
    required: ["scheda", "testo"], writes: true,
    async run(store, a) {
      const due = has(a, "scade") ? dueValue(a.scade) : "";
      const codes = codesArg(a);
      const defs = due && codes === undefined ? await alertDefaults(store, "voci") : [];
      return store.modify(a.scheda, (card) => {
        if (a.sotto) {
          const cl = card.checklists.find((x: any) => x.items.some((i: any) => i.id === a.sotto));
          if (!cl) throw new Fail(`voce inesistente: ${a.sotto}`);
          const parent = find(cl.items, a.sotto, "voce");
          if (depth(cl.items, parent) >= MAX_DEPTH) throw new Fail(`Al massimo ${MAX_DEPTH} livelli.`);
          const item: any = { id: newId(), text: a.testo, done: false, due: "", parent: parent.id };
          applyDue(item, due, codes, defs);
          cl.items.splice(cl.items.indexOf(subtree(cl.items, parent).at(-1)) + 1, 0, item);
          syncUp(cl.items, parent.id);
          return item.id;
        }
        let checklist;
        if (a.checklist) checklist = find(card.checklists, a.checklist, "checklist");
        else if (card.checklists.length) checklist = card.checklists[0];
        else {
          checklist = { id: newId(), title: "Checklist", hideDone: false, items: [] };
          card.checklists.push(checklist);
        }
        const item: any = { id: newId(), text: a.testo, done: false, due: "" };
        applyDue(item, due, codes, defs);
        checklist.items.push(item);
        return item.id;
      });
    },
  },

  spunta: {
    description: "Segna fatta una voce di checklist (o da fare con fatta=false), con le sue sotto-voci; " +
      "una voce madre è fatta quando lo sono tutte le figlie.",
    properties: { scheda: SCHEDA, voce: s("id della voce"), fatta: b("default true") }, required: ["scheda", "voce"],
    writes: true,
    async run(store, a) {
      return store.modify(a.scheda, (card) => {
        for (const checklist of card.checklists) {
          for (const item of checklist.items) {
            if (item.id === a.voce) {
              setDone(checklist.items, item, a.fatta !== false);
              return item.text;
            }
          }
        }
        throw new Fail(`voce inesistente: ${a.voce}`);
      });
    },
  },

  modifica: {
    description: "Cambia una scheda in una chiamata: passa solo i campi da cambiare. " +
      "Spostare in un'altra colonna la toglie dall'archivio; posizione 0 = in cima.",
    properties: {
      scheda: SCHEDA, titolo: s("titolo"), descrizione: s("descrizione in Markdown (sostituisce quella attuale)"),
      scade: DUE, priorita: i("priorità da 1 (la più alta) a 5 (la più bassa), 0 per toglierla"), fatta: b("completata"),
      etichette: { type: "array", items: { type: "string" }, description: "nomi o id delle etichette (sostituiscono quelle attuali)" },
      ambito: s("id o nome della colonna di ambito"), colonna: s("id o nome della colonna in cui spostarla"),
      posizione: i("posto nella colonna, 0 = in cima"), archiviata: b("archiviata o ripristinata"), avvisi: AVVISI,
    },
    required: ["scheda"], writes: true,
    async run(store, a) {
      noChanges(a, ["scheda"]);
      const data = await store.stato();
      const others = has(a, "colonna") || has(a, "ambito") || has(a, "archiviata") || has(a, "posizione") ? await store.cards() : [];
      const kinds: Record<string, string> = Object.fromEntries(data.lists.map((l) => [l.id, l.kind]));
      let labels: string[] | undefined;
      if (has(a, "etichette")) {
        if (!Array.isArray(a.etichette)) throw new Fail("etichette: serve una lista di nomi o id");
        const byKey: Record<string, string> = {};
        for (const l of data.labels) [byKey[l.id], byKey[l.name.toLowerCase()]] = [l.id, l.id];
        const missing = a.etichette.filter((x: any) => !(String(x).toLowerCase() in byKey));
        if (missing.length) throw new Fail(`Etichette inesistenti: ${missing.join(", ")}. Ci sono: ${data.labels.map((l) => l.name).join(", ")}`);
        labels = [...new Set(a.etichette.map((x: any) => byKey[String(x).toLowerCase()]))] as string[];
      }
      const area = has(a, "ambito") ? pickList(data, a.ambito) : null;
      if (area && area.kind !== "area") throw new Fail("L'ambito deve essere una colonna di ambito.");
      const target = has(a, "colonna") ? pickList(data, a.colonna) : null;
      const due = has(a, "scade") ? dueValue(a.scade) : undefined;
      const codes = codesArg(a);
      const defs = await alertDefaults(store, "schede", data);
      const prio = has(a, "priorita") ? Number(a.priorita) : undefined;
      if (prio !== undefined && (!Number.isInteger(prio) || prio < 0 || prio > 5)) throw new Fail(`Priorità non valida: ${a.priorita} (da 1, la più alta, a 5; 0 per toglierla)`);
      let edited: any;
      const result = await store.modify(a.scheda, (card) => {
        edited = card;
        if (prio !== undefined) card.priority = prio;
        if (has(a, "titolo")) card.title = String(a.titolo).trim() || card.title;
        if (has(a, "descrizione")) card.desc = String(a.descrizione);
        if (due !== undefined || codes !== undefined) applyDue(card, due, codes, defs);
        if (has(a, "fatta")) card.done = flag(a.fatta, "fatta");
        if (labels) card.labels = labels;
        if (area) {
          card.area = area.id;
          if (card.archived) card.list = area.id;
          else if (kinds[card.list] === "area" && card.list !== area.id) [card.list, card.pos] = [area.id, slot(others, card, area.id)];
        }
        if (has(a, "archiviata") && flag(a.archiviata, "archiviata") !== card.archived) {
          if (a.archiviata) {
            if (kinds[card.list] === "week") card.list = card.area;
            [card.archived, card.archivedAt] = [true, now()];
          } else {
            [card.archived, card.archivedAt] = [false, ""];
            card.pos = slot(others, card, card.list);
          }
        }
        if (target || has(a, "posizione")) {
          const dest = target ?? { id: card.list, kind: kinds[card.list] };
          if (card.archived) [card.archived, card.archivedAt] = [false, ""];
          if (dest.kind === "area") card.area = dest.id;
          card.list = dest.id;
          card.pos = slot(others, card, dest.id, has(a, "posizione") ? Number(a.posizione) : undefined);
        }
        const where = card.archived ? "archiviata" : `in ${card.list}`;
        return `${card.id}  ${card.title}${card.priority ? ` P${card.priority}` : ""} (${where}${card.due ? ", scade " + card.due : ""}${alertsText(card)})`;
      });
      // Cambiando priorità o posto la colonna si riordina: a mano si ordina solo dentro la stessa priorità.
      const moved = ["priorita", "colonna", "posizione", "ambito", "archiviata"].some((k) => has(a, k));
      if (moved && !edited.archived) await store.sortByPriority([edited.list]);
      return result;
    },
  },

  modifica_voce: {
    description: "Cambia o elimina una voce di checklist in una chiamata: passa solo i campi da cambiare.",
    properties: {
      scheda: SCHEDA, voce: s("id della voce"), testo: s("testo"), scade: DUE, fatta: b("fatta"),
      posizione: i("posto nella checklist, 0 = in cima"), checklist: s("id della checklist in cui spostarla"),
      elimina: b("elimina la voce, con le sue sotto-voci"),
      padre: s("id della voce sotto cui metterla (fino a 3 livelli); vuoto la porta al primo livello"), avvisi: AVVISI,
    },
    required: ["scheda", "voce"], writes: true,
    async run(store, a) {
      noChanges(a, ["scheda", "voce"]);
      const due = has(a, "scade") ? dueValue(a.scade) : undefined;
      const codes = codesArg(a);
      const defs = due && codes === undefined ? await alertDefaults(store, "voci") : [];
      return store.modify(a.scheda, (card) => {
        for (let checklist of card.checklists) {
          const item = checklist.items.find((x: any) => x.id === a.voce);
          if (!item) continue;
          if (a.elimina) {
            const gone = subtree(checklist.items, item);
            checklist.items = checklist.items.filter((x: any) => !gone.includes(x));
            syncUp(checklist.items, item.parent);
            return `Eliminata la voce: ${item.text}${gone.length > 1 ? `, con ${gone.length - 1} sotto-voci` : ""}`;
          }
          if (has(a, "testo")) item.text = String(a.testo).trim() || item.text;
          if (due !== undefined || codes !== undefined) applyDue(item, due, codes, defs);
          if (has(a, "fatta")) setDone(checklist.items, item, flag(a.fatta, "fatta"));
          if (a.checklist && a.checklist !== checklist.id) {
            const dest = find(card.checklists, a.checklist, "checklist");
            const block = subtree(checklist.items, item); // la voce va con le sue sotto-voci
            checklist.items = checklist.items.filter((x: any) => !block.includes(x));
            const old = item.parent;
            delete item.parent;
            syncUp(checklist.items, old);
            dest.items.push(...block);
            checklist = dest;
          }
          if (has(a, "padre")) reparent(checklist.items, item, String(a.padre || ""));
          if (has(a, "posizione")) moveTo(checklist.items, item, Number(a.posizione));
          return `${item.id}  ${item.done ? "[x]" : "[ ]"} ${item.text}${item.due ? " scade " + item.due : ""}${alertsText(item)}`;
        }
        throw new Fail(`voce inesistente: ${a.voce}`);
      });
    },
  },

  nuova_checklist: {
    description: "Aggiunge una checklist vuota a una scheda e ne restituisce l'id.",
    properties: { scheda: SCHEDA, titolo: s("titolo della checklist") }, required: ["scheda", "titolo"], writes: true,
    async run(store, a) {
      return store.modify(a.scheda, (card) => {
        const checklist = { id: newId(), title: String(a.titolo).trim() || "Checklist", hideDone: false, items: [] };
        card.checklists.push(checklist);
        return checklist.id;
      });
    },
  },

  modifica_checklist: {
    description: "Rinomina, sposta, nasconde le voci fatte o elimina una checklist (con tutte le sue voci).",
    properties: {
      scheda: SCHEDA, checklist: s("id della checklist"), titolo: s("titolo"),
      nascondi_fatte: b("nasconde le voci fatte"), posizione: i("posto tra le checklist, 0 = prima"),
      elimina: b("elimina la checklist"),
    },
    required: ["scheda", "checklist"], writes: true,
    async run(store, a) {
      noChanges(a, ["scheda", "checklist"]);
      return store.modify(a.scheda, (card) => {
        const checklist = find(card.checklists, a.checklist, "checklist");
        if (a.elimina) {
          card.checklists.splice(card.checklists.indexOf(checklist), 1);
          return `Eliminata la checklist ${checklist.title} (${checklist.items.length} voci).`;
        }
        if (has(a, "titolo")) checklist.title = String(a.titolo).trim() || checklist.title;
        if (has(a, "nascondi_fatte")) checklist.hideDone = flag(a.nascondi_fatte, "nascondi_fatte");
        if (has(a, "posizione")) moveTo(card.checklists, checklist, Number(a.posizione));
        return `${checklist.id}  ${checklist.title}`;
      });
    },
  },

  modifica_commento: {
    description: "Cambia il testo di un commento, lo segna risolto o aperto, o lo elimina con le sue risposte.",
    properties: {
      scheda: SCHEDA, commento: s("id del commento"), testo: s("nuovo testo, in Markdown"),
      risolto: b("risolto (false per riaprirlo)"), elimina: b("elimina il commento e le risposte"),
    },
    required: ["scheda", "commento"], writes: true,
    async run(store, a) {
      noChanges(a, ["scheda", "commento"]);
      return store.modify(a.scheda, (card) => {
        const c = find(card.comments, a.commento, "commento");
        if (a.elimina) {
          const gone = new Set([c.id, ...card.comments.filter((r: any) => r.replyTo === c.id).map((r: any) => r.id)]);
          card.comments = card.comments.filter((r: any) => !gone.has(r.id));
          return `Eliminato il commento (${gone.size - 1} risposte).`;
        }
        if (has(a, "testo")) [c.text, c.edited] = [String(a.testo).trim() || c.text, now()];
        if (has(a, "risolto")) {
          c.resolved = flag(a.risolto, "risolto");
          c.resolvedAt = c.resolved ? now() : "";
        }
        return "Commento aggiornato.";
      });
    },
  },

  modifica_colonna: {
    description: "Cambia una colonna: nome, sottotitolo (riga sotto il titolo) e note in Markdown (sostituiscono quelle " +
      "attuali; si aprono dal sottotitolo), colore del pallino. Passa solo i campi da cambiare. " +
      "Le note si leggono con lo strumento colonna.",
    properties: {
      colonna: s("id o nome della colonna"), nome: s("nome della colonna"),
      sottotitolo: s("sottotitolo, vuoto per toglierlo"), note: s("note in Markdown, vuote per toglierle"),
      colore: s(`colore: ${COLORI}, vuoto per toglierlo`),
    },
    required: ["colonna"], writes: true,
    async run(store, a) {
      noChanges(a, ["colonna"]);
      for (const key of ["nome", "sottotitolo", "note"]) if (has(a, key) && typeof a[key] !== "string") throw new Fail(`${key}: serve un testo`);
      if (has(a, "colore") && !COLORS.has(a.colore)) throw new Fail(`Colore non valido. Validi: ${COLORI} (vuoto per toglierlo)`);
      for (let attempt = 0; attempt < 5; attempt++) {
        const doc = await store.get("/bacheca/stato");
        if (!doc) throw new Fail("Bacheca vuota.");
        const data = fields(doc);
        const item = pickList(data, a.colonna);
        if (has(a, "nome") && a.nome.trim()) item.name = a.nome.trim().slice(0, 80);
        if (has(a, "sottotitolo")) item.subtitle = a.sottotitolo.trim().slice(0, 200);
        if (has(a, "note")) item.notes = a.note;
        if (has(a, "colore")) item.color = a.colore;
        try {
          await store.write("bacheca", "stato", data, doc.updateTime);
          const notes = item.notes || "";
          return `${item.id}  ${item.name}${item.subtitle ? ` · ${item.subtitle}` : ""}${notes ? ` (note: ${notes.length} caratteri)` : ""}`;
        } catch (error) {
          if (!(error instanceof Conflict)) throw error;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      throw new Fail("La bacheca continua a cambiare, riprova.");
    },
  },

  elimina_scheda: {
    description: "Elimina definitivamente una scheda (per toglierla senza perderla usa modifica con archiviata=true). " +
      "Rifiuta le schede con file allegati, che vanno eliminate dall'app.",
    properties: { scheda: SCHEDA }, required: ["scheda"], writes: true,
    async run(store, a) {
      const card = await getCard(store, a.scheda);
      if (card.attachments.some((x: any) => x.kind === "file")) throw new Fail("La scheda ha dei file allegati: eliminala dall'app, che toglie anche i file.");
      await store.call("DELETE", `/schede/${encodeURIComponent(a.scheda)}`);
      await store.bump();
      return `Eliminata ${card.id}  ${card.title}`;
    },
  },

  commenta: {
    description: "Aggiunge un commento di Claude a una scheda.",
    properties: { scheda: SCHEDA, testo: s("testo, in Markdown") }, required: ["scheda", "testo"], writes: true,
    async run(store, a) {
      await store.modify(a.scheda, (card) => card.comments.push(comment("claude", a.testo)));
      return "Commento aggiunto.";
    },
  },

  rispondi: {
    description: "Risponde a un commento di {OWNER}, e se risolvi=true lo segna risolto.",
    properties: {
      scheda: SCHEDA, commento: s("id del commento"), testo: s("risposta, in Markdown"), risolvi: b("segna risolto il commento"),
    },
    required: ["scheda", "commento", "testo"], writes: true,
    async run(store, a) {
      await store.modify(a.scheda, (card) => {
        const parent = find(card.comments, a.commento, "commento");
        card.comments.push(comment("claude", a.testo, parent.id));
        if (a.risolvi) [parent.resolved, parent.resolvedAt] = [true, now()];
      });
      return "Risposta inviata" + (a.risolvi ? " e commento risolto." : ".");
    },
  },

  risolvi: {
    description: "Segna risolto un commento.",
    properties: { scheda: SCHEDA, commento: s("id del commento") }, required: ["scheda", "commento"], writes: true,
    async run(store, a) {
      await store.modify(a.scheda, (card) => {
        const c = find(card.comments, a.commento, "commento");
        [c.resolved, c.resolvedAt] = [true, now()];
      });
      return "Segnato risolto.";
    },
  },

  tempo: {
    description: "Minuti di lavoro registrati su una scheda. Con data, focus e agenti scrive (o sostituisce) quel giorno.",
    properties: {
      scheda: SCHEDA, data: s("AAAA-MM-GG"), focus: i("minuti di focus di {OWNER}"), agenti: i("minuti di lavoro degli agenti"),
    },
    required: ["scheda"], writes: true,
    async run(store, a) {
      let card;
      if (a.data) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(a.data) || isNaN(Date.parse(a.data))) throw new Fail(`Data non valida: ${a.data}`);
        if (a.focus == null || a.agenti == null) throw new Fail("Con data servono anche focus e agenti.");
        card = await store.modify(a.scheda, (c) => {
          const entries = (c.time || []).filter((e: any) => e.date !== a.data);
          entries.push({ date: a.data, focus: Math.round(a.focus), agents: Math.round(a.agenti) });
          c.time = entries.sort((x: any, y: any) => x.date.localeCompare(y.date));
          return c;
        });
      } else {
        card = await getCard(store, a.scheda);
      }
      const entries = card.time || [];
      const sum = (k: string) => entries.reduce((t: number, e: any) => t + e[k], 0);
      return [`${card.title}: focus ${sum("focus")} min, agenti ${sum("agents")} min`,
        ...entries.map((e: any) => `  ${e.date}  focus ${e.focus} min · agenti ${e.agents} min`)].join("\n");
    },
  },
};

export function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description.replaceAll("{OWNER}", CFG.owner),
    inputSchema: { type: "object", properties: t.properties, required: t.required },
    annotations: { readOnlyHint: !t.writes, destructiveHint: name === "elimina_scheda", openWorldHint: false },
  }));
}

export async function callTool(store: Store, name: string, args: Args) {
  const tool = TOOLS[name];
  if (!tool) return null;
  const missing = tool.required.filter((k) => args[k] == null || args[k] === "");
  if (missing.length) return { text: `Mancano: ${missing.join(", ")}`, isError: true };
  try {
    return { text: (await tool.run(store, args)) || "Fatto.", isError: false };
  } catch (error) {
    if (error instanceof Fail) return { text: error.message, isError: true };
    return { text: `${(error as Error).name}: ${(error as Error).message}`, isError: true };
  }
}
