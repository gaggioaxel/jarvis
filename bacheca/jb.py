#!/usr/bin/python3
"""Accesso di Claude alla bacheca su Firestore, con l'account di servizio. Solo libreria standard più openssl.

Valori dell'istanza in ~/.config/jarvis/config.json (vedi config.example.json e jarvis_config.py);
chiave dell'account di servizio in ~/.config/jarvis/bacheca-sa.json (o nel file indicato da BACHECA_SA).
Con FIRESTORE_EMULATOR_HOST impostato lavora sull'emulatore locale.

  jb.py commenti [--tutti]                  commenti del proprietario da risolvere
  jb.py commenti --claude                   commenti di Claude che il proprietario non ha ancora valutato (da proporre nel buongiorno);
                                            valido: modifica-commento ... '{"risolto":true}'
  jb.py chiusi [--elimina]                  commenti chiusi: risolti, con le risposte di Claude già valutate;
                                            --elimina li cancella (solo dopo la conferma del proprietario)
  jb.py cronologia [--giorni N]             commenti del proprietario in ordine di tempo, con la scheda;
                                            senza --giorni quelli nuovi dall'ultima lettura (o degli ultimi 7 giorni)
  jb.py tempo <scheda> [AAAA-MM-GG <focus_min> <agenti_min>]
                                            minuti di lavoro sulla scheda; con la data scrive (o sostituisce) quel giorno
  jb.py ore [--giorni N]                    carica storico.csv (minuti per progetto e giorno) per la vista Tempo
  jb.py agenti [--giorni N] [--tutti]       carica l'uso dei modelli (solo i giorni cambiati; --tutti li riscrive)
  jb.py rispondi <scheda> <commento> <testo> [--risolvi]
  jb.py risolvi <scheda> <commento>
  jb.py commenta <scheda> <testo>
  jb.py indice [--aperte] [--entro N] [--limite N]   una riga per scheda, colonna per colonna
  jb.py colonna <id|nome> [--aperte] [--entro N] [--limite N]   schede di una colonna
                                            --aperte: non fatte; --entro N: scadenza (della scheda o di una voce aperta)
                                            entro N giorni, anche passata; --limite N: al massimo N schede per colonna
  jb.py cerca <testo> [--attive] [--colonna <id|nome>] [--limite N]
                                            schede con il testo in titolo, descrizione, checklist o commenti
  jb.py scheda <id> [--breve [--tutto]]     scheda completa in JSON; --breve: compatta, senza campi vuoti né commenti
                                            risolti (--tutto li tiene)
  jb.py nuova <ambito> <titolo>             aggiunge una scheda in fondo a un ambito (non in Questa settimana)
  jb.py voce <scheda> <testo> [--checklist <id>] [--sotto <voce>] [--scade AAAA-MM-GG] [--avvisi '["1g@09:00"]']
                                            con --sotto è una sotto-voce di quella voce (fino a 3 livelli)
  jb.py spunta <scheda> <voce> [--no]       segna fatta (o da fare) una voce di checklist, con le sue sotto-voci
  jb.py modifica <scheda> <json>            cambia campi della scheda: titolo, descrizione, scade, avvisi, priorita (1-5, 0 la toglie), fatta,
                                            etichette, ambito, colonna, posizione, archiviata
  jb.py modifica-voce <scheda> <voce> <json>          testo, scade, avvisi, fatta, elimina, posizione, checklist,
                                            padre (id della voce sotto cui metterla; "" la porta al primo livello)
  jb.py modifica-checklist <scheda> <checklist> <json> titolo, nascondi_fatte, elimina, posizione
  jb.py nuova-checklist <scheda> <titolo>
  jb.py modifica-commento <scheda> <commento> <json>  testo, risolto, elimina
  jb.py modifica-colonna <colonna> <json>   nome, sottotitolo, note (Markdown), colore
  jb.py modifica-etichetta <etichetta> <json>  nome, colore, elimina; con elimina e priorita (1-5) le sue schede prendono quella priorità
  jb.py elimina <scheda>                    elimina la scheda (se non ha file allegati)
  jb.py salva <file.json|->                 riscrive una scheda intera da JSON
  jb.py json                                tutta la bacheca in JSON
  jb.py token [--rinnova]                   quanto resta al token salvato in <data_dir>/token.json (lo chiede se serve)
  jb.py backup [cartella]                   salva bacheca.json con data (default <data_dir>/backup)
  jb.py importa <bacheca.json> [--forza]    carica una bacheca esportata
"""
import base64
import csv
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
import jarvis_config  # noqa: E402

OWNER = jarvis_config.get("owner_name")
DATA = jarvis_config.path("data_dir")
KEY = Path(os.environ.get("BACHECA_SA", jarvis_config.path("service_account")))
EMULATOR = os.environ.get("FIRESTORE_EMULATOR_HOST", "")
PROJECT = os.environ.get("BACHECA_PROGETTO", "demo-bacheca" if EMULATOR else jarvis_config.get("firebase_project"))
URL = jarvis_config.get("bacheca_url")
MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]
BASE = (f"http://{EMULATOR}" if EMULATOR else "https://firestore.googleapis.com") + \
    f"/v1/projects/{PROJECT}/databases/(default)/documents"
_token = None


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id():
    return secrets.token_hex(4)


# Accesso: JWT firmato con la chiave dell'account di servizio, scambiato con un token di Google.

def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


# Il token di Google vale un'ora: si salva con l'ora della richiesta e si rinnova dopo 50 minuti,
# così i comandi successivi non rifanno firma e scambio (circa mezzo secondo ciascuno).
TOKEN_FILE = DATA / "token.json"
TOKEN_REFRESH = 50 * 60


def cached_token():
    try:
        saved = json.loads(TOKEN_FILE.read_text())
        age = time.time() - saved["richiesto_ts"]
        if 0 <= age < TOKEN_REFRESH and saved.get("account") == json.loads(KEY.read_text())["client_email"]:
            return saved["access_token"]
    except (OSError, ValueError, KeyError):
        pass
    return None


def save_token(value, account, stamp, lifetime):
    data = {
        "access_token": value, "account": account, "richiesto_ts": stamp,
        "richiesto": datetime.fromtimestamp(stamp).astimezone().isoformat(timespec="seconds"),
        "rinnovo_dopo": datetime.fromtimestamp(stamp + TOKEN_REFRESH).astimezone().isoformat(timespec="seconds"),
        "scade": datetime.fromtimestamp(stamp + lifetime).astimezone().isoformat(timespec="seconds"),
    }
    # Leggibile solo da te: chi ha il token legge e scrive la bacheca per un'ora.
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1)
    os.chmod(TOKEN_FILE, 0o600)


def token(fresh=False):
    global _token
    if EMULATOR:
        return "owner"
    if _token and not fresh:
        return _token
    if not fresh and (saved := cached_token()):
        _token = saved
        return _token
    if not KEY.exists():
        sys.exit(f"Manca la chiave dell'account di servizio in {KEY}")
    key = json.loads(KEY.read_text())
    stamp = int(time.time())
    header = b64(json.dumps({"alg": "RS256", "typ": "JWT", "kid": key["private_key_id"]}).encode())
    claims = b64(json.dumps({
        "iss": key["client_email"], "scope": "https://www.googleapis.com/auth/datastore",
        "aud": key["token_uri"], "iat": stamp, "exp": stamp + 3600,
    }).encode())
    unsigned = f"{header}.{claims}".encode()
    # La chiave passa a openssl da una pipe, senza file temporanei.
    read, write = os.pipe()
    os.write(write, key["private_key"].encode())
    os.close(write)
    try:
        signature = subprocess.run(
            [shutil.which("openssl") or "openssl", "dgst", "-sha256", "-sign", f"/dev/fd/{read}"],
            input=unsigned, capture_output=True, check=True, pass_fds=(read,),
        ).stdout
    finally:
        os.close(read)
    form = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": f"{unsigned.decode()}.{b64(signature)}",
    }).encode()
    with urllib.request.urlopen(key["token_uri"], form, timeout=20) as response:
        answer = json.loads(response.read())
    _token = answer["access_token"]
    save_token(_token, key["client_email"], stamp, int(answer.get("expires_in", 3600)))
    return _token


def token_status():
    try:
        saved = json.loads(TOKEN_FILE.read_text())
    except (OSError, ValueError):
        return "Nessun token salvato."
    left = TOKEN_REFRESH - (time.time() - saved["richiesto_ts"])
    when = f"rinnovo tra {int(left // 60)} min" if left > 0 else "da rinnovare al prossimo comando"
    return f"Token richiesto {saved['richiesto']}, scade {saved['scade']}: {when}."


class Conflict(Exception):
    pass


def call(method, path, body=None, query=None, retry=True):
    url = BASE + path + ("?" + urllib.parse.urlencode(query, doseq=True) if query else "")
    request = urllib.request.Request(url, method=method, headers={"Authorization": f"Bearer {token()}"})
    if body is not None:
        request.data = json.dumps(body).encode()
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        if error.code == 401 and retry and not EMULATOR:
            # Token salvato ma non più valido (revocato o chiave cambiata): se ne chiede uno nuovo e si riprova.
            token(fresh=True)
            return call(method, path, body, query, retry=False)
        if error.code == 404 and method == "GET":
            return None
        if error.code in (409, 412) or "FAILED_PRECONDITION" in detail:
            raise Conflict(detail)
        sys.exit(f"{error.code}: {detail}")
    return json.loads(raw) if raw else None


# Valori Firestore <-> Python

def encode(value):
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [encode(v) for v in value]}}
    if isinstance(value, dict):
        return {"mapValue": {"fields": {k: encode(v) for k, v in value.items()}}}
    raise TypeError(f"valore non supportato: {value!r}")


def decode(value):
    kind, inner = next(iter(value.items()))
    if kind == "integerValue":
        return int(inner)
    if kind == "arrayValue":
        return [decode(v) for v in inner.get("values", [])]
    if kind == "mapValue":
        return {k: decode(v) for k, v in inner.get("fields", {}).items()}
    if kind == "nullValue":
        return None
    return inner


def fields(doc):
    data = {k: decode(v) for k, v in doc.get("fields", {}).items()}
    if "/schede/" in doc.get("name", ""):
        for key in KEYED:
            data[key] = list_field(key, data.get(key) or {})
    return data


# Commenti, checklist e voci di una scheda stanno su Firestore come mappe id -> elemento (17 novembre):
# l'app scrive solo l'elemento che tocca, così una modifica fatta offline non cancella quelle arrivate
# intanto. Qui si lavora con gli elenchi: commenti per data di creazione, checklist e voci per `pos`.
KEYED = ("comments", "checklists")


def _by_pos(by_id):
    return [{k: v for k, v in x.items() if k != "pos"}
            for x in sorted(by_id.values(), key=lambda x: (x.get("pos", 0), x.get("id", "")))]


def list_field(key, by_id):
    if key == "comments":
        return sorted(by_id.values(), key=lambda c: (c.get("created", ""), c.get("id", "")))
    return [{**cl, "items": _by_pos(cl.get("items") or {})} for cl in _by_pos(by_id)]


def doc_field(key, items):
    if key == "comments":
        return {c["id"]: c for c in items}
    return {cl["id"]: {**cl, "pos": i, "items": {it["id"]: {**it, "pos": j} for j, it in enumerate(cl.get("items", []))}}
            for i, cl in enumerate(items)}


# Bacheca

def cards():
    found, page = [], None
    while True:
        data = call("GET", "/schede", query={"pageSize": 300, **({"pageToken": page} if page else {})}) or {}
        found += [fields(d) for d in data.get("documents", [])]
        page = data.get("nextPageToken")
        if not page:
            return found


def stato():
    doc = call("GET", "/bacheca/stato")
    return fields(doc) if doc else {"lists": [], "labels": []}


def board():
    return {**stato(), "cards": cards()}


def write(collection, doc_id, data, update_time=None, bump=False):
    """Riscrive il documento intero; con update_time solo se nel frattempo non è cambiato.
    Con bump avvisa il controllo delle notifiche (avvisi/agenda.richieste) che una scadenza è cambiata."""
    name = BASE.split("/v1/", 1)[1] + f"/{collection}/{doc_id}"
    if collection == "schede":
        data = {**data, **{k: doc_field(k, data.get(k, [])) for k in KEYED}}
    op = {"update": {"name": name, "fields": {k: encode(v) for k, v in data.items()}}}
    if update_time:
        op["currentDocument"] = {"updateTime": update_time}
    call("POST", ":commit", {"writes": [op, bump_write()] if bump else [op]})


def bump_write():
    return {"transform": {"document": BASE.split("/v1/", 1)[1] + "/avvisi/agenda",
                          "fieldTransforms": [{"fieldPath": "richieste", "increment": {"integerValue": "1"}}]}}


def alert_sig(c):
    """Quello che conta per le notifiche: se cambia, il Worker rilegge le schede."""
    return json.dumps([c.get("title"), c.get("due"), c.get("reminders"), c.get("done"), c.get("archived"),
                       [[[i["id"], i.get("text"), i.get("due"), i.get("reminders"), i.get("done")] for i in cl.get("items", [])]
                        for cl in c.get("checklists", [])]])


def sort_by_priority(list_ids):
    """Riordina le colonne dall'alto: P1…P5, poi le schede senza priorità; a parità resta l'ordine di prima.
    Scrive solo il campo pos delle schede che cambiano posto, tutte in un commit."""
    rank = lambda c: c["priority"] if c.get("priority") in (1, 2, 3, 4, 5) else 6
    base = BASE.split("/v1/", 1)[1]
    every = cards()
    writes = []
    for list_id in set(list_ids):
        column = sorted((c for c in every if c["list"] == list_id and not c["archived"]), key=lambda c: c["pos"])
        for pos, c in enumerate(sorted(column, key=rank)):
            if c["pos"] != pos:
                writes.append({"update": {"name": f"{base}/schede/{c['id']}", "fields": {"pos": encode(pos)}},
                               "updateMask": {"fieldPaths": ["pos"]}, "currentDocument": {"exists": True}})
    if writes:
        call("POST", ":commit", {"writes": writes})


def modify(card_id, change):
    """Legge, modifica e riscrive una scheda; se nel frattempo è cambiata riprova."""
    for _ in range(5):
        doc = call("GET", f"/schede/{card_id}")
        if not doc:
            sys.exit(f"Scheda inesistente: {card_id}")
        card = fields(doc)
        before = alert_sig(card)
        result = change(card)
        card["updated"] = now()
        try:
            write("schede", card_id, card, doc["updateTime"], bump=alert_sig(card) != before)
            return result
        except Conflict:
            time.sleep(0.5)
    sys.exit("La scheda continua a cambiare, riprova.")


def find(items, item_id, what):
    for item in items:
        if item["id"] == item_id:
            return item
    sys.exit(f"{what} inesistente: {item_id}")


def comment(author, text, reply_to=""):
    return {"id": new_id(), "author": author, "text": text, "created": now(), "edited": "",
            "resolved": False, "resolvedAt": "", "replyTo": reply_to}


def option(rest, name):
    if name in rest:
        i = rest.index(name)
        value = rest[i + 1]
        del rest[i:i + 2]
        return value
    return None


def pick_list(data, wanted):
    wanted = wanted.lower()
    for item in data["lists"]:
        if item["id"] == wanted or item["name"].lower() == wanted:
            return item
    sys.exit("Colonna inesistente: " + ", ".join(f"{l['id']} ({l['name']})" for l in data["lists"]))


# Modifiche: le stesse regole di static/store.js, con i nomi dei campi degli strumenti MCP.

COLORS = {"", "green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink", "black"}


def check_keys(changes, allowed):
    unknown = set(changes) - allowed
    if unknown:
        sys.exit(f"Campi sconosciuti: {', '.join(sorted(unknown))}. Validi: {', '.join(sorted(allowed))}")
    if not changes:
        sys.exit("Nessuna modifica.")


def due_value(value):
    if value in (None, ""):
        return ""
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M" if "T" in value else "%Y-%m-%d")
    except (TypeError, ValueError):
        sys.exit(f"Scadenza non valida: {value} (AAAA-MM-GG o AAAA-MM-GGTHH:MM, vuota per toglierla)")
    return value


# Notifiche delle scadenze (20 novembre), come in static/store.js e mcp-worker/src/avvisi.ts:
# "10m", "1h", "1g", "1s" prima della scadenza; "0g@09:00", "1g@18:00" il giorno stesso / prima a quell'ora.
# Le scadenze senza ora valgono come alle 9:00. Una scadenza nuova prende gli avvisi predefiniti (bacheca/stato.avvisi).
REMINDER = re.compile(r"^(\d{1,3})([mhgs])(?:@(\d{1,2}):(\d{2}))?$")
UNIT_MIN = {"m": 1, "h": 60, "g": 1440, "s": 10080}
DEFAULT_ALERTS = {"schede": ["1g@09:00"], "voci": ["0g@09:00"]}


def normalize_reminder(code):
    m = REMINDER.match(str(code or "").strip().lower())
    if not m:
        return None
    n, u, hh, mm = m.groups()
    if hh is None:
        return f"{int(n)}{u}"
    if u not in "gs" or int(hh) > 23 or int(mm) > 59:
        return None
    return f"{int(n)}{u}@{int(hh):02d}:{mm}"


def reminder_weight(code):
    n, u, hh, mm = REMINDER.match(code).groups()
    base = int(n) * UNIT_MIN[u]
    return base if hh is None else base + 1440 - (int(hh) * 60 + int(mm))


def reminder_codes(value):
    if not isinstance(value, list):
        sys.exit('avvisi: serve un elenco, per esempio ["1g@09:00", "1h"]')
    out = []
    for v in value:
        code = normalize_reminder(v)
        if not code:
            sys.exit(f'Avviso non valido: {v}. Esempi: "10m", "1h", "1g", "1s" (minuti, ore, giorni, settimane prima), '
                     '"0g@09:00" (il giorno stesso alle 9), "1g@18:00".')
        out.append(code)
    if len(out) > 10:
        sys.exit("Al massimo 10 avvisi.")
    return sorted(set(out), key=reminder_weight)


def describe_reminder(code):
    m = REMINDER.match(code)
    if not m:
        return code
    n, u, hh, mm = m.groups()
    names = {"m": ("minuto", "minuti"), "h": ("ora", "ore"), "g": ("giorno", "giorni"), "s": ("settimana", "settimane")}
    unit = names[u][0 if int(n) == 1 else 1]
    if hh is not None:
        at = f"{int(hh)}:{mm}"
        return f"il giorno stesso alle {at}" if int(n) == 0 else f"{int(n)} {unit} prima alle {at}"
    return "all'ora della scadenza" if int(n) == 0 else f"{int(n)} {unit} prima"


def alert_defaults(kind, data=None):
    data = data if data is not None else stato()
    value = (data.get("avvisi") or {}).get(kind)
    return value if isinstance(value, list) else DEFAULT_ALERTS[kind]


def apply_due(target, changes, kind, data=None):
    """Scadenza e avvisi: una scadenza nuova prende i predefiniti; senza scadenza niente avvisi."""
    if "scade" in changes:
        target["due"] = due_value(changes["scade"])
    if "avvisi" in changes:
        codes = reminder_codes(changes["avvisi"])
        if codes and not target.get("due"):
            sys.exit("Gli avvisi servono a una scadenza: passa anche scade.")
        target["reminders"] = codes
    elif "scade" in changes and target.get("due") and "reminders" not in target:
        target["reminders"] = list(alert_defaults(kind, data))
    if not target.get("due"):
        target.pop("reminders", None)


def alerts_text(x):
    return f", avvisi: {', '.join(map(describe_reminder, x['reminders']))}" if x.get("due") and x.get("reminders") else ""


def priority_value(value):
    if value in (None, "", 0) and value is not False:
        return 0
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 5:
        sys.exit(f"Priorità non valida: {value} (da 1, la più alta, a 5; 0 per toglierla)")
    return value


def prio_tag(card):
    return f" P{card['priority']}" if card.get("priority") else ""


def flag(value, name):
    if not isinstance(value, bool):
        sys.exit(f"{name}: serve true o false")
    return value


def edit_column(column_id, changes):
    """Nome, sottotitolo, note e colore di una colonna, in bacheca/stato; se nel frattempo è cambiato riprova."""
    check_keys(changes, {"nome", "sottotitolo", "note", "colore"})
    for key in ("nome", "sottotitolo", "note"):
        if key in changes and not isinstance(changes[key], str):
            sys.exit(f"{key}: serve un testo")
    if "colore" in changes and changes["colore"] not in COLORS:
        sys.exit(f"Colore non valido. Validi: {', '.join(sorted(COLORS - {''}))} (vuoto per toglierlo)")
    for _ in range(5):
        doc = call("GET", "/bacheca/stato")
        data = fields(doc)
        item = pick_list(data, column_id)
        if changes.get("nome", "").strip():
            item["name"] = changes["nome"].strip()[:80]
        if "sottotitolo" in changes:
            item["subtitle"] = changes["sottotitolo"].strip()[:200]
        if "note" in changes:
            item["notes"] = changes["note"]
        if "colore" in changes:
            item["color"] = changes["colore"]
        try:
            write("bacheca", "stato", data, doc["updateTime"])
            notes = item.get("notes", "")
            return f"{item['id']}  {item['name']}" + (f" · {item['subtitle']}" if item.get("subtitle") else "") + \
                (f" (note: {len(notes)} caratteri)" if notes else "")
        except Conflict:
            time.sleep(0.5)
    sys.exit("La bacheca continua a cambiare, riprova.")


def edit_label(label_ref, changes):
    """Nome e colore di un'etichetta; con "elimina" la toglie da bacheca/stato e da tutte le schede.
    Con "elimina" e "priorita": N le schede che l'avevano prendono priorità N, se non ne hanno già una più alta."""
    check_keys(changes, {"nome", "colore", "elimina", "priorita"})
    if "colore" in changes and changes["colore"] not in COLORS - {""}:
        sys.exit(f"Colore non valido. Validi: {', '.join(sorted(COLORS - {''}))}")
    level = changes.get("priorita")
    if level is not None and (not isinstance(level, int) or not 1 <= level <= 5):
        sys.exit("priorita: da 1 (più alta) a 5")
    for _ in range(5):
        doc = call("GET", "/bacheca/stato")
        data = fields(doc)
        ref = label_ref.strip().lower()
        item = next((l for l in data["labels"] if l["id"] == label_ref or l["name"].lower() == ref), None)
        if not item:
            sys.exit(f"Etichetta inesistente: {label_ref}. Ci sono: {', '.join(l['name'] for l in data['labels'])}")
        if changes.get("elimina"):
            data["labels"] = [l for l in data["labels"] if l is not item]
        else:
            if changes.get("nome", "").strip():
                item["name"] = changes["nome"].strip()[:60]
            if "colore" in changes:
                item["color"] = changes["colore"]
        try:
            write("bacheca", "stato", data, doc["updateTime"])
            break
        except Conflict:
            time.sleep(0.5)
    else:
        sys.exit("La bacheca continua a cambiare, riprova.")
    if not changes.get("elimina"):
        return f"{item['id']}  {item['name']} ({item['color']})"
    touched, lists = [], set()
    for card in cards():
        if item["id"] not in card.get("labels", []):
            continue
        def change(c):
            c["labels"] = [x for x in c["labels"] if x != item["id"]]
            if level is not None and not (1 <= (c.get("priority") or 0) <= level):
                c["priority"] = level
        modify(card["id"], change)
        lists.add(card["list"])
        touched.append(f"  {card['id']}  {card['title']}" + (f"  → P{level}" if level else ""))
    if level is not None:
        sort_by_priority(lists)
    return f"Eliminata l'etichetta {item['name']}" + (":\n" + "\n".join(touched) if touched else ", non era su nessuna scheda.")


def move(items, item, index):
    items.remove(item)
    items.insert(max(0, min(int(index), len(items))), item)


def slot(others, card, list_id, index=None):
    """pos per mettere la scheda nella colonna, in fondo o al posto index (0 = in cima), senza toccare le altre."""
    column = sorted((c["pos"] for c in others if c["list"] == list_id and not c["archived"] and c["id"] != card["id"]))
    if index is None or index >= len(column):
        return (column[-1] + 1) if column else 0
    index = max(0, int(index))
    before = column[index - 1] if index else column[0] - 1
    return (before + column[index]) / 2


def edit_card(card, changes, data, others):
    check_keys(changes, {"titolo", "descrizione", "scade", "avvisi", "priorita", "fatta", "etichette",
                         "ambito", "colonna", "posizione", "archiviata"})
    kinds = {l["id"]: l["kind"] for l in data["lists"]}
    if "titolo" in changes:
        card["title"] = str(changes["titolo"]).strip() or card["title"]
    if "descrizione" in changes:
        card["desc"] = str(changes["descrizione"])
    if "scade" in changes or "avvisi" in changes:
        apply_due(card, changes, "schede", data)
    if "priorita" in changes:
        card["priority"] = priority_value(changes["priorita"])
    if "fatta" in changes:
        card["done"] = flag(changes["fatta"], "fatta")
    if "etichette" in changes:
        labels = {**{l["id"]: l["id"] for l in data["labels"]}, **{l["name"].lower(): l["id"] for l in data["labels"]}}
        wanted = changes["etichette"]
        if not isinstance(wanted, list):
            sys.exit("etichette: serve una lista di nomi o id")
        missing = [x for x in wanted if str(x).lower() not in labels]
        if missing:
            sys.exit(f"Etichette inesistenti: {', '.join(missing)}. Ci sono: {', '.join(l['name'] for l in data['labels'])}")
        card["labels"] = list(dict.fromkeys(labels[str(x).lower()] for x in wanted))
    if "ambito" in changes:
        area = pick_list(data, changes["ambito"])
        if area["kind"] != "area":
            sys.exit("L'ambito deve essere una colonna di ambito.")
        card["area"] = area["id"]
        if card["archived"]:
            card["list"] = area["id"]
        elif kinds.get(card["list"]) == "area" and card["list"] != area["id"]:
            card["list"], card["pos"] = area["id"], slot(others, card, area["id"])
    if "archiviata" in changes and flag(changes["archiviata"], "archiviata") != card["archived"]:
        if changes["archiviata"]:
            if kinds.get(card["list"]) == "week":
                card["list"] = card["area"]
            card["archived"], card["archivedAt"] = True, now()
        else:
            card["archived"], card["archivedAt"] = False, ""
            card["pos"] = slot(others, card, card["list"])
    if "colonna" in changes or "posizione" in changes:
        target = pick_list(data, changes["colonna"]) if "colonna" in changes else {"id": card["list"], "kind": kinds.get(card["list"])}
        if card["archived"]:
            card["archived"], card["archivedAt"] = False, ""
        if target["kind"] == "area":
            card["area"] = target["id"]
        card["list"] = target["id"]
        card["pos"] = slot(others, card, target["id"], changes.get("posizione"))
    where = "archiviata" if card["archived"] else f"in {card['list']}"
    return f"{card['id']}  {card['title']}{prio_tag(card)} ({where}{', scade ' + card['due'] if card['due'] else ''}{alerts_text(card)})"


# Sottovoci (19 novembre): "parent" è l'id di un'altra voce della stessa checklist, fino a 3 livelli. Stesse regole
# di static/store.js: spuntare una voce spunta le sue sotto-voci, una voce madre è fatta quando lo sono tutte le figlie,
# eliminarla elimina anche le sotto-voci.
MAX_DEPTH = 3


def kids_of(items, item_id):
    return [x for x in items if (x.get("parent") or "") == item_id]


def subtree(items, item):
    out = [item]
    for x in out:
        out.extend(kids_of(items, x["id"]))
    return out


def depth(items, item):
    n, by_id = 1, {x["id"]: x for x in items}
    parent = item.get("parent")
    while parent and parent in by_id:
        n, parent = n + 1, by_id[parent].get("parent")
    return n


def height(items, item):
    return 1 + max((height(items, k) for k in kids_of(items, item["id"])), default=0)


def sync_up(items, parent_id):
    by_id = {x["id"]: x for x in items}
    parent = by_id.get(parent_id or "")
    while parent:
        kids = kids_of(items, parent["id"])
        if kids:
            parent["done"] = all(k["done"] for k in kids)
        parent = by_id.get(parent.get("parent") or "")


def set_done(items, item, value):
    for x in subtree(items, item):
        x["done"] = value
    sync_up(items, item.get("parent"))


def relocate(items, item, after):
    """Toglie la voce con le sotto-voci e le rimette subito dopo after (e le sue sotto-voci), o in fondo."""
    block = subtree(items, item)
    rest = [x for x in items if x not in block]
    at = rest.index(subtree(rest, after)[-1]) + 1 if after else len(rest)
    items[:] = rest[:at] + block + rest[at:]


def reparent(items, item, parent_id):
    old = item.get("parent") or ""
    if parent_id == old:
        return
    if parent_id:
        parent = find(items, parent_id, "voce madre")
        if parent in subtree(items, item):
            sys.exit("Una voce non va sotto sé stessa.")
        if depth(items, parent) + height(items, item) > MAX_DEPTH:
            sys.exit(f"Al massimo {MAX_DEPTH} livelli.")
        item["parent"] = parent["id"]
        relocate(items, item, parent)
    else:
        item.pop("parent", None)
        relocate(items, item, next((x for x in items if x["id"] == old), None))
    sync_up(items, old)
    sync_up(items, item.get("parent"))


def leaves(items):
    """Le voci che contano per l'avanzamento: quelle senza sotto-voci."""
    parents = {x.get("parent") for x in items}
    return [x for x in items if x["id"] not in parents]


# Letture compatte (21 novembre): quello che torna da una lettura resta nel contesto di Claude per tutta la chat,
# quindi si filtra qui e non dopo. Stesse regole nel Worker (mcp-worker/src/tools.ts).

def card_line(c, column=""):
    items = [i for cl in c["checklists"] for i in leaves(cl["items"])]
    done = sum(i["done"] for i in items)
    extra = f" {done}/{len(items)}" if items else ""
    due = f" scade {c['due']}" if c["due"] else ""
    where = f" [{column}]" if column else ""
    return f"{c['id']}  {'[x]' if c['done'] else '[ ]'} {c['title']}{prio_tag(c)}{extra}{due}{where}"


def card_filter(rest):
    """Filtri comuni: --aperte (non fatte), --entro N (scadenza della scheda o di una voce aperta entro N giorni,
    anche già passata). Toglie le opzioni da rest."""
    open_only = "--aperte" in rest
    if open_only:
        rest.remove("--aperte")
    within = option(rest, "--entro")
    limit = (datetime.now() + timedelta(days=float(within))).strftime("%Y-%m-%d") if within else None

    def due_soon(c):
        dues = [c["due"]] + [i["due"] for cl in c["checklists"] for i in cl["items"] if i.get("due") and not i["done"]]
        return any(d and d[:10] <= limit for d in dues)
    return lambda c: not (open_only and c["done"]) and (not limit or due_soon(c))


def limited(lines, cap):
    """Con un limite (il valore di --limite) tiene le prime righe e dice quante ne restano."""
    if cap and len(lines) > int(cap):
        return lines[:int(cap)] + [f"… altre {len(lines) - int(cap)}"]
    return lines


def searchable(c):
    """Il testo in cui cerca: titolo, descrizione, checklist e commenti (non id, date e nomi dei campi)."""
    parts = [c["title"], c.get("desc", "")]
    for cl in c["checklists"]:
        parts += [cl.get("title", "")] + [i.get("text", "") for i in cl["items"]]
    parts += [x.get("text", "") for x in c["comments"]]
    return "\n".join(parts).lower()


SKIP_FIELDS = {"pos", "color"}  # pos è solo per l'ordine, il colore delle schede non c'è più


def brief_card(card, full=False):
    """La scheda in JSON compatto: senza campi vuoti e, se non full, senza i commenti risolti e le loro risposte."""
    card, hidden = dict(card), 0
    if not full:
        closed = {c["id"] for c in card["comments"] if c.get("resolved") and not c.get("replyTo")}
        keep = [c for c in card["comments"] if c["id"] not in closed and c.get("replyTo") not in closed]
        hidden, card["comments"] = len(card["comments"]) - len(keep), keep

    def prune(x):
        if isinstance(x, dict):
            return {k: prune(v) for k, v in x.items() if k not in SKIP_FIELDS and v not in ("", [], {}, None)}
        return [prune(v) for v in x] if isinstance(x, list) else x
    out = prune(card)
    if hidden:
        out["commenti_risolti_nascosti"] = hidden
    return json.dumps(out, ensure_ascii=False, separators=(",", ":"))


def edit_item(card, item_id, changes, defaults=None):
    check_keys(changes, {"testo", "scade", "avvisi", "fatta", "elimina", "posizione", "checklist", "padre"})
    for checklist in card["checklists"]:
        for item in checklist["items"]:
            if item["id"] != item_id:
                continue
            if changes.get("elimina"):
                gone = subtree(checklist["items"], item)
                checklist["items"][:] = [x for x in checklist["items"] if x not in gone]
                sync_up(checklist["items"], item.get("parent"))
                return f"Eliminata la voce: {item['text']}" + (f", con {len(gone) - 1} sotto-voci" if len(gone) > 1 else "")
            if "testo" in changes:
                item["text"] = str(changes["testo"]).strip() or item["text"]
            if "scade" in changes or "avvisi" in changes:
                apply_due(item, changes, "voci", defaults)
            if "fatta" in changes:
                set_done(checklist["items"], item, flag(changes["fatta"], "fatta"))
            if changes.get("checklist") and changes["checklist"] != checklist["id"]:
                target = find(card["checklists"], changes["checklist"], "checklist")
                block = subtree(checklist["items"], item)  # la voce va con le sue sotto-voci
                checklist["items"][:] = [x for x in checklist["items"] if x not in block]
                sync_up(checklist["items"], item.pop("parent", None))
                target["items"].extend(block)
                checklist = target
            if "padre" in changes:
                reparent(checklist["items"], item, str(changes["padre"] or ""))
            if "posizione" in changes:
                move(checklist["items"], item, changes["posizione"])
            return f"{item['id']}  {'[x]' if item['done'] else '[ ]'} {item['text']}{' scade ' + item['due'] if item['due'] else ''}{alerts_text(item)}"
    sys.exit(f"voce inesistente: {item_id}")


def edit_checklist(card, checklist_id, changes):
    check_keys(changes, {"titolo", "nascondi_fatte", "elimina", "posizione"})
    checklist = find(card["checklists"], checklist_id, "checklist")
    if changes.get("elimina"):
        card["checklists"].remove(checklist)
        return f"Eliminata la checklist {checklist['title']} ({len(checklist['items'])} voci)."
    if "titolo" in changes:
        checklist["title"] = str(changes["titolo"]).strip() or checklist["title"]
    if "nascondi_fatte" in changes:
        checklist["hideDone"] = flag(changes["nascondi_fatte"], "nascondi_fatte")
    if "posizione" in changes:
        move(card["checklists"], checklist, changes["posizione"])
    return f"{checklist['id']}  {checklist['title']}"


def edit_comment(card, comment_id, changes):
    check_keys(changes, {"testo", "risolto", "elimina"})
    item = find(card["comments"], comment_id, "commento")
    if changes.get("elimina"):
        gone = {item["id"]} | {c["id"] for c in card["comments"] if c["replyTo"] == item["id"]}
        card["comments"] = [c for c in card["comments"] if c["id"] not in gone]
        return f"Eliminato il commento ({len(gone) - 1} risposte)."
    if "testo" in changes:
        item["text"] = str(changes["testo"]).strip() or item["text"]
        item["edited"] = now()
    if "risolto" in changes:
        item["resolved"] = flag(changes["risolto"], "risolto")
        item["resolvedAt"] = now() if item["resolved"] else ""
    return "Commento aggiornato."


def main(args):
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return
    command, rest = args[0], args[1:]

    if command == "commenti" and "--claude" in rest:
        # I commenti di Claude restano aperti finché il proprietario non li valuta: risolto = valido.
        data = board()
        names = {l["id"]: l["name"] for l in data["lists"]}
        found = 0
        for card in data["cards"]:
            if card["archived"]:
                continue
            by_id = {c["id"]: c for c in card["comments"]}
            for c in card["comments"]:
                if c["author"] != "claude" or c["resolved"]:
                    continue
                found += 1
                print(f"## {card['title']} [{names.get(card['list'], '')}] scheda={card['id']} commento={c['id']} {c['created']}")
                print(f"{URL}/#c/{card['id']}")
                parent = by_id.get(c["replyTo"])
                if parent:
                    print(f"> in risposta a {'Claude' if parent['author'] == 'claude' else OWNER}:")
                    print("> " + parent["text"].replace("\n", "\n> "))
                print(c["text"], end="\n\n")
        if not found:
            print("Nessun commento di Claude da valutare.")

    elif command == "chiusi":
        # Un commento è chiuso se è risolto e le risposte di Claude sono già state valutate (risolte):
        # eliminarlo cancella anche le risposte.
        data = board()
        delete = "--elimina" in rest
        closed = {}
        for card in data["cards"]:
            for c in card["comments"]:
                replies = [r for r in card["comments"] if r["replyTo"] == c["id"]]
                if not c["replyTo"] and c["resolved"] and all(r["resolved"] for r in replies if r["author"] == "claude"):
                    closed.setdefault(card["id"], []).append(c)
        total = sum(len(v) for v in closed.values())
        titles = {c["id"]: c["title"] for c in data["cards"]}
        for card_id, items in closed.items():
            print(f"## {titles[card_id]} scheda={card_id}")
            for c in items:
                print(f"- {c['id']} ({'Claude' if c['author'] == 'claude' else OWNER}, {c['created'][:10]}): "
                      + c["text"].strip().split("\n")[0][:100])
            if delete:
                ids = {c["id"] for c in items}

                def drop(card):
                    card["comments"] = [c for c in card["comments"] if c["id"] not in ids and c["replyTo"] not in ids]
                modify(card_id, drop)
        print(f"\n{total} commenti chiusi" + (" eliminati, con le loro risposte." if delete else "."))

    elif command == "commenti":
        data = board()
        names = {l["id"]: l["name"] for l in data["lists"]}
        every = "--tutti" in rest
        found = 0
        for card in data["cards"]:
            if card["archived"]:  # una scheda archiviata è chiusa: i suoi commenti non si citano più
                continue
            for c in card["comments"]:
                if c["author"] == "utente" and not c["replyTo"] and (every or not c["resolved"]):
                    found += 1
                    state = "risolto" if c["resolved"] else "aperto"
                    print(f"## {card['title']} [{names.get(card['list'], '')}] scheda={card['id']} commento={c['id']} {state} {c['created']}")
                    print(f"{URL}/#c/{card['id']}")
                    print(c["text"], end="\n\n")
                    for r in (r for r in card["comments"] if r["replyTo"] == c["id"]):
                        print(f"> {'Claude' if r['author'] == 'claude' else OWNER}, {r['created']}:")
                        print("> " + r["text"].replace("\n", "\n> "), end="\n\n")
        if not found:
            print("Nessun commento aperto.")

    elif command == "cronologia":
        # Senza --giorni mostra i commenti nuovi dall'ultima lettura e sposta il segno in avanti.
        days = option(rest, "--giorni")
        mark = DATA / ("cronologia-letta-emulatore.txt" if EMULATOR else "cronologia-letta.txt")
        if days:
            since = datetime.now(timezone.utc) - timedelta(days=float(days))
        elif mark.exists():
            since = datetime.fromisoformat(mark.read_text().strip().replace("Z", "+00:00"))
        else:
            since = datetime.now(timezone.utc) - timedelta(days=7)
        data = board()
        names = {l["id"]: l["name"] for l in data["lists"]}

        def when(stamp):
            return datetime.fromisoformat(stamp.replace("Z", "+00:00")) if stamp else None

        found = []
        for card in data["cards"]:
            if card["archived"]:  # le schede archiviate non entrano nella cronologia
                continue
            for c in card["comments"]:
                if c["author"] != "utente":
                    continue
                last = max(t for t in (when(c["created"]), when(c.get("edited"))) if t)
                if last > since:
                    found.append((when(c["created"]), card, c))
        found.sort(key=lambda f: f[0])
        local = since.astimezone()
        print(f"Commenti di {OWNER} dal {local.day} {MONTHS[local.month - 1]} {local:%H:%M}: {len(found)}")
        day = None
        for created, card, c in found:
            t = created.astimezone()
            if t.date() != day:
                day = t.date()
                print(f"\n### {t.day} {MONTHS[t.month - 1]}")
            column = names.get(card["list"], card["list"])
            if c["replyTo"]:
                parent = next((p for p in card["comments"] if p["id"] == c["replyTo"]), None)
                state = "risposta a " + ("Claude" if parent and parent["author"] == "claude" else "un commento")
            else:
                state = "risolto" if c["resolved"] else "aperto"
                if any(r["replyTo"] == c["id"] and r["author"] == "claude" for r in card["comments"]):
                    state += ", Claude ha risposto"
            edited = ", modificato" if c.get("edited") else ""
            print(f"- {t:%H:%M} · {card['title']} [{column}] · {state}{edited} · scheda={card['id']} commento={c['id']}")
            print("  " + c["text"].strip().replace("\n", "\n  "))
        if not days:
            mark.parent.mkdir(parents=True, exist_ok=True)
            mark.write_text(now())

    elif command == "tempo":
        # card["time"]: [{"date": "AAAA-MM-GG", "focus": minuti tuoi, "agents": minuti degli agenti}]
        if len(rest) == 4:
            day, focus, agents = rest[1], int(rest[2]), int(rest[3])
            datetime.strptime(day, "%Y-%m-%d")

            def log(card):
                entries = [e for e in card.get("time", []) if e["date"] != day]
                entries.append({"date": day, "focus": focus, "agents": agents})
                card["time"] = sorted(entries, key=lambda e: e["date"])
                return card
            card = modify(rest[0], log)
        elif len(rest) == 1:
            doc = call("GET", f"/schede/{rest[0]}")
            if not doc:
                sys.exit(f"Scheda inesistente: {rest[0]}")
            card = fields(doc)
        else:
            sys.exit("Uso: jb.py tempo <scheda> [AAAA-MM-GG <focus_min> <agenti_min>]")
        entries = card.get("time", [])
        print(f"{card['title']}: focus {sum(e['focus'] for e in entries)} min, agenti {sum(e['agents'] for e in entries)} min")
        for e in entries:
            print(f"  {e['date']}  focus {e['focus']} min · agenti {e['agents']} min")

    elif command == "ore":
        # ore/{AAAA-MM-GG}: {"date", "rows": [{"code", "name", "area", "focus", "agents"}]}, dai minuti di giornata.py.
        # Solo codici, nomi dei progetti e minuti: niente file né finestre.
        days = option(rest, "--giorni")
        first = (datetime.now() - timedelta(days=int(days))).strftime("%Y-%m-%d") if days else ""
        history = jarvis_config.path("storico")
        by_day = {}
        with history.open(newline="") as f:
            for row in csv.DictReader(f):
                focus, agents = int(row["focus_min"] or 0), int(row["agente_min"] or 0)
                if row["data"] < first or not (focus or agents):
                    continue
                by_day.setdefault(row["data"], []).append(
                    {"code": row["codice"], "name": row["progetto"], "area": row["area"], "focus": focus, "agents": agents})
        for day, rows in sorted(by_day.items()):
            write("ore", day, {"date": day, "rows": rows})
        print(f"Caricati {len(by_day)} giorni" + (f", dal {min(by_day)} al {max(by_day)}." if by_day else "."))

    elif command == "agenti":
        # agenti/{AAAA-MM-GG}: token per ora, account, modello, progetto e agente, limiti e chiamate Gemini
        # (agenti_raccolta.py). Solo misure e nomi di cartelle: niente testi delle conversazioni.
        import hashlib
        import agenti_raccolta
        days = option(rest, "--giorni")
        force = "--tutti" in rest
        docs = agenti_raccolta.collect(days=int(days) if days else None)
        # Si caricano solo i giorni cambiati dall'ultimo invio (impronta senza "updated"): lanciato
        # ogni 15 minuti dalla barra, di solito scrive solo il documento di oggi.
        mark = DATA / ("agenti-impronte-emulatore.json" if EMULATOR else "agenti-impronte.json")
        try:
            seen = json.loads(mark.read_text())
        except (OSError, ValueError):
            seen = {}
        sent = []
        for day, doc in sorted(docs.items()):
            digest = hashlib.sha1(json.dumps({k: v for k, v in doc.items() if k != "updated"},
                                             sort_keys=True).encode()).hexdigest()
            if not force and seen.get(day) == digest:
                continue
            write("agenti", day, doc)
            seen[day] = digest
            sent.append(day)
        mark.parent.mkdir(exist_ok=True)
        mark.write_text(json.dumps(seen))
        print(f"Caricati {len(sent)} giorni su {len(docs)}" + (f": {', '.join(sent[-5:])}{' …' if len(sent) > 5 else ''}." if sent else " (niente di nuovo)."))

    elif command == "rispondi":
        card_id, parent_id, text = rest[0], rest[1], rest[2]

        def reply(card):
            parent = find(card["comments"], parent_id, "commento")
            card["comments"].append(comment("claude", text, parent["id"]))
            if "--risolvi" in rest:
                parent["resolved"], parent["resolvedAt"] = True, now()
        modify(card_id, reply)
        print("Risposta inviata" + (" e commento risolto." if "--risolvi" in rest else "."))

    elif command == "risolvi":
        def resolve(card):
            c = find(card["comments"], rest[1], "commento")
            c["resolved"], c["resolvedAt"] = True, now()
        modify(rest[0], resolve)
        print("Segnato risolto.")

    elif command == "commenta":
        modify(rest[0], lambda card: card["comments"].append(comment("claude", rest[1])))
        print("Commento aggiunto.")

    elif command == "colonna":
        cap, keep = option(rest, "--limite"), card_filter(rest)
        data = board()
        target = pick_list(data, rest[0])
        column = sorted((c for c in data["cards"] if c["list"] == target["id"] and not c["archived"] and keep(c)),
                        key=lambda c: c["pos"])
        if target.get("subtitle"):
            print(f"# {target['name']} · {target['subtitle']}")
        if target.get("notes"):
            print(f"Note della colonna:\n{target['notes'].strip()}\n---")
        print("\n".join(limited([card_line(c) for c in column], cap)) or "Nessuna scheda.")

    elif command == "indice":
        # Una riga per scheda non archiviata, colonna per colonna: per orientarsi senza scaricare tutto.
        filtered = "--aperte" in rest or "--entro" in rest  # filtrando, le colonne vuote non si mostrano
        cap, keep = option(rest, "--limite"), card_filter(rest)
        data = board()
        out = []
        for l in data["lists"]:
            column = sorted((c for c in data["cards"] if c["list"] == l["id"] and not c["archived"] and keep(c)),
                            key=lambda c: c["pos"])
            if column or not filtered:
                out.append(f"## {l['name']} ({l['id']}, {len(column)})")
                out += limited([card_line(c) for c in column], cap)
        if data["labels"]:
            out.append("Etichette: " + ", ".join(lab["name"] for lab in data["labels"]))
        print("\n".join(out))

    elif command == "cerca":
        active = "--attive" in rest
        if active:
            rest.remove("--attive")
        where, cap = option(rest, "--colonna"), option(rest, "--limite")
        needle = " ".join(rest).lower()
        data = board()
        names = {l["id"]: l["name"] for l in data["lists"]}
        target = pick_list(data, where)["id"] if where else None
        lines = [card_line(c, names.get(c["list"], "")) + (" (archiviata)" if c["archived"] else "")
                 for c in data["cards"]
                 if needle in searchable(c) and not (active and c["archived"]) and (not target or c["list"] == target)]
        print("\n".join(limited(lines, cap)) or "Nessuna scheda trovata.")

    elif command == "scheda":
        brief = "--breve" in rest
        doc = call("GET", f"/schede/{rest[0]}")
        if not doc:
            sys.exit(f"Scheda inesistente: {rest[0]}")
        print(brief_card(fields(doc), "--tutto" in rest) if brief else json.dumps(fields(doc), ensure_ascii=False, indent=1))

    elif command == "nuova":
        data = board()
        target = pick_list(data, rest[0])
        if target["kind"] == "week":
            sys.exit("In Questa settimana non si creano schede: creala in un ambito, poi spostala con modifica '{\"colonna\":\"settimana\"}'.")
        area = target["id"]
        column = [c["pos"] for c in data["cards"] if c["list"] == target["id"] and not c["archived"]]
        card = {
            "id": new_id(), "list": target["id"], "area": area, "pos": max(column, default=-1) + 1,
            "title": " ".join(rest[1:]).strip(), "desc": "", "color": "", "labels": [], "due": "", "priority": 0, "done": False,
            "archived": False, "archivedAt": "", "created": now(), "updated": now(),
            "checklists": [], "attachments": [], "comments": [],
        }
        if not card["title"]:
            sys.exit("Titolo vuoto")
        write("schede", card["id"], card)
        print(f"{card['id']}  {card['title']}")

    elif command == "voce":
        checklist_id = option(rest, "--checklist")
        under = option(rest, "--sotto")
        due = due_value(option(rest, "--scade") or "")
        alerts = option(rest, "--avvisi")
        due_changes = {"scade": due, **({"avvisi": json.loads(alerts)} if alerts else {})} if due or alerts else {}
        voce_data = stato() if due and not alerts else {}

        def add(card):
            if under:
                checklist = next((cl for cl in card["checklists"] if any(i["id"] == under for i in cl["items"])), None)
                if not checklist:
                    sys.exit(f"voce inesistente: {under}")
                parent = find(checklist["items"], under, "voce")
                if depth(checklist["items"], parent) >= MAX_DEPTH:
                    sys.exit(f"Al massimo {MAX_DEPTH} livelli.")
                item = {"id": new_id(), "text": rest[1], "done": False, "due": "", "parent": under}
                apply_due(item, due_changes, "voci", voce_data)
                last = subtree(checklist["items"], parent)[-1]
                checklist["items"].insert(checklist["items"].index(last) + 1, item)
                sync_up(checklist["items"], under)
                return item["id"]
            if checklist_id:
                checklist = find(card["checklists"], checklist_id, "checklist")
            elif card["checklists"]:
                checklist = card["checklists"][0]
            else:
                checklist = {"id": new_id(), "title": "Checklist", "hideDone": False, "items": []}
                card["checklists"].append(checklist)
            item = {"id": new_id(), "text": rest[1], "done": False, "due": ""}
            apply_due(item, due_changes, "voci", voce_data)
            checklist["items"].append(item)
            return item["id"]
        print(modify(rest[0], add))

    elif command == "spunta":
        def tick(card):
            for checklist in card["checklists"]:
                for item in checklist["items"]:
                    if item["id"] == rest[1]:
                        set_done(checklist["items"], item, "--no" not in rest)
                        return item["text"]
            sys.exit(f"voce inesistente: {rest[1]}")
        print(modify(rest[0], tick))

    elif command == "modifica":
        changes = json.loads(rest[1])
        data = stato()
        others = cards() if {"colonna", "ambito", "archiviata", "posizione"} & changes.keys() else None
        edited = {}
        def change(card):
            result = edit_card(card, changes, data, others)
            edited.update(card)
            return result
        result = modify(rest[0], change)
        # Cambiando priorità o posto la colonna si riordina: a mano si ordina solo dentro la stessa priorità.
        if {"priorita", "colonna", "posizione", "ambito", "archiviata"} & changes.keys() and not edited["archived"]:
            sort_by_priority([edited["list"]])
        print(result)

    elif command == "modifica-voce":
        changes = json.loads(rest[2])
        print(modify(rest[0], lambda card: edit_item(card, rest[1], changes)))

    elif command == "modifica-checklist":
        changes = json.loads(rest[2])
        print(modify(rest[0], lambda card: edit_checklist(card, rest[1], changes)))

    elif command == "nuova-checklist":
        def make(card):
            checklist = {"id": new_id(), "title": rest[1].strip() or "Checklist", "hideDone": False, "items": []}
            card["checklists"].append(checklist)
            return checklist["id"]
        print(modify(rest[0], make))

    elif command == "modifica-commento":
        changes = json.loads(rest[2])
        print(modify(rest[0], lambda card: edit_comment(card, rest[1], changes)))

    elif command == "modifica-colonna":
        print(edit_column(rest[0], json.loads(rest[1])))

    elif command == "modifica-etichetta":
        print(edit_label(rest[0], json.loads(rest[1])))

    elif command == "elimina":
        doc = call("GET", f"/schede/{rest[0]}")
        if not doc:
            sys.exit(f"Scheda inesistente: {rest[0]}")
        card = fields(doc)
        if any(a["kind"] == "file" for a in card["attachments"]):
            sys.exit("La scheda ha dei file allegati: eliminala dall'app, che toglie anche i file.")
        call("DELETE", f"/schede/{rest[0]}")
        call("POST", ":commit", {"writes": [bump_write()]})
        print(f"Eliminata {rest[0]}  {card['title']}")

    elif command == "salva":
        card = json.loads(sys.stdin.read() if rest[0] == "-" else Path(rest[0]).read_text())
        card["updated"] = now()
        write("schede", card["id"], card)
        print(f"Salvata {card['id']}.")

    elif command == "token":
        if "--rinnova" in rest:
            token(fresh=True)
        elif not EMULATOR:
            token()
        print(token_status())

    elif command == "json":
        print(json.dumps(board(), ensure_ascii=False, indent=1))

    elif command == "backup":
        folder = Path(rest[0]) if rest else DATA / "backup"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"bacheca-{datetime.now().strftime('%Y-%m-%d')}.json"
        path.write_text(json.dumps(board(), ensure_ascii=False, indent=1))
        print(path)

    elif command == "importa":
        data = json.loads(Path(rest[0]).read_text())
        if cards() and "--forza" not in rest:
            sys.exit("La bacheca online ha già delle schede: usa --forza per sovrascriverle.")
        write("bacheca", "stato", {"lists": data["lists"], "labels": data["labels"]})
        for card in data["cards"]:
            card.setdefault("attachments", [])
            card["attachments"] = [a for a in card["attachments"] if a["kind"] == "link"]
            write("schede", card["id"], card)
        print(f"Importate {len(data['cards'])} schede, {len(data['lists'])} colonne, {len(data['labels'])} etichette.")

    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
