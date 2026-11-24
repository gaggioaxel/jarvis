#!/usr/bin/python3
"""Server MCP (stdio) della bacheca di Jarvis: espone i comandi di jb.py come strumenti.

Solo libreria standard, come jb.py. Ogni strumento chiama jb.main() nello stesso processo,
raccoglie quello che stampa e lo restituisce; un sys.exit() di jb.py diventa un errore dello strumento.

Registrazione in Claude Code (tutte le sessioni):
  claude mcp add bacheca --scope user -- python3 /percorso/di/jarvis/bacheca/mcp_server.py
"""
import contextlib
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jb  # noqa: E402

OWNER = jb.OWNER

PROTOCOL = "2025-06-18"
OUT = sys.stdout  # il canale del protocollo; durante gli strumenti sys.stdout punta a un buffer


def s(desc):
    return {"type": "string", "description": desc}


def i(desc):
    return {"type": "integer", "description": desc}


def b(desc):
    return {"type": "boolean", "description": desc}


SCHEDA = s("id della scheda (8 caratteri esadecimali)")
DUE = s("scadenza AAAA-MM-GG o AAAA-MM-GGTHH:MM, vuota per toglierla")
AVVISI = {"type": "array", "items": {"type": "string"}, "description":
          'notifiche della scadenza (sostituiscono quelle attuali): "10m", "1h", "1g", "1s" = 10 minuti, 1 ora, 1 giorno, '
          '1 settimana prima; "0g@09:00" = il giorno stesso alle 9, "1g@18:00" = il giorno prima alle 18. Le scadenze senza ora '
          "valgono come alle 9:00. Se non lo passi, una nuova scadenza prende gli avvisi predefiniti; [] li toglie tutti."}
COLORI = ", ".join(sorted(jb.COLORS - {""}))


LIMITE = i("al massimo N schede (per colonna)")
FILTRI = {"aperte": b("solo le schede non fatte"),
          "entro": i("solo le schede con scadenza (loro o di una voce aperta) entro N giorni, comprese le scadute"),
          "limite": LIMITE}


def filters(a):
    return ((["--aperte"] if a.get("aperte") else []) + (["--entro", str(a["entro"])] if a.get("entro") is not None else [])
            + (["--limite", str(a["limite"])] if a.get("limite") else []))


def changes(args, *ids):
    """Gli argomenti dello strumento, tolti gli id, come JSON per i comandi modifica di jb.py."""
    return json.dumps({k: v for k, v in args.items() if k not in ids}, ensure_ascii=False)


# nome -> (descrizione, proprietà, obbligatorie, funzione che costruisce gli argomenti di jb.py)
TOOLS = {
    "commenti": (
        f"Commenti di {OWNER} ancora aperti (o tutti con tutti=true), con le risposte e il link alla scheda. "
        f"Con claude=true i commenti di Claude che {OWNER} non ha ancora valutato (risolto = valido).",
        {"tutti": b("includi anche quelli risolti"), "claude": b("commenti di Claude da valutare")}, [],
        lambda a: ["commenti"] + (["--tutti"] if a.get("tutti") else []) + (["--claude"] if a.get("claude") else [])),
    "chiusi": (
        "Commenti chiusi: risolti, con le risposte di Claude già valutate. Con elimina=true li cancella "
        f"insieme alle risposte: solo dopo la conferma di {OWNER}.",
        {"elimina": b("cancella i commenti chiusi")}, [],
        lambda a: ["chiusi"] + (["--elimina"] if a.get("elimina") else [])),
    "cronologia": (
        f"Commenti di {OWNER} in ordine di tempo. Senza giorni mostra quelli nuovi dall'ultima lettura "
        "e sposta il segno di lettura in avanti (lo usa /buongiorno); con giorni non sposta il segno.",
        {"giorni": {"type": "number", "description": "ultimi N giorni"}}, [],
        lambda a: ["cronologia"] + (["--giorni", str(a["giorni"])] if a.get("giorni") else [])),
    "colonna": (
        "Sottotitolo, note e schede non archiviate di una colonna, in ordine, una riga ciascuna con avanzamento "
        "checklist e scadenza. Per esempio 'settimana' o il nome di un ambito.",
        {"colonna": s("id o nome della colonna"), **FILTRI}, ["colonna"],
        lambda a: ["colonna", a["colonna"]] + filters(a)),
    "cerca": (
        "Schede con il testo in titolo, descrizione, checklist o commenti, una riga ciascuna con la colonna.",
        {"testo": s("testo da cercare"), "attive": b("escludi le archiviate"),
         "colonna": s("solo le schede di questa colonna (id o nome)"), "limite": LIMITE}, ["testo"],
        lambda a: ["cerca", a["testo"]] + (["--attive"] if a.get("attive") else [])
        + (["--colonna", a["colonna"]] if a.get("colonna") else []) + (["--limite", str(a["limite"])] if a.get("limite") else [])),
    "scheda": (
        "Una scheda in JSON compatto: descrizione, checklist con id delle voci, commenti aperti con id, tempo, allegati. "
        "I campi vuoti non ci sono; i commenti risolti si contano in commenti_risolti_nascosti (tutto=true li mostra).",
        {"scheda": SCHEDA, "tutto": b("includi i commenti risolti")}, ["scheda"],
        lambda a: ["scheda", a["scheda"], "--breve"] + (["--tutto"] if a.get("tutto") else [])),
    "bacheca": (
        "Indice della bacheca: per ogni colonna una riga per scheda non archiviata (id, fatta, titolo, priorità, "
        "avanzamento, scadenza), più le etichette. Per i dettagli usa scheda. completa=true dà tutto il JSON (grande).",
        {**FILTRI, "completa": b("tutta la bacheca in JSON, con descrizioni e commenti")}, [],
        lambda a: ["json"] if a.get("completa") else ["indice"] + filters(a)),
    "nuova_scheda": (
        "Aggiunge una scheda in fondo a un ambito e ne restituisce l'id. In Questa settimana non si creano schede: "
        "si crea nell'ambito e poi si sposta con modifica colonna='settimana'.",
        {"colonna": s("id o nome dell'ambito (non 'settimana')"), "titolo": s("titolo della scheda")}, ["colonna", "titolo"],
        lambda a: ["nuova", a["colonna"], a["titolo"]]),
    "aggiungi_voce": (
        "Aggiunge una voce di checklist a una scheda (nella prima checklist, o in quella indicata; "
        "se non ce n'è una la crea). Con sotto è una sotto-voce di quella voce (fino a 3 livelli). Restituisce l'id della voce.",
        {"scheda": SCHEDA, "testo": s("testo della voce"),
         "checklist": s("id della checklist (facoltativo)"), "scade": s("scadenza AAAA-MM-GG o AAAA-MM-GGTHH:MM (facoltativa)"),
         "sotto": s("id della voce madre: la nuova voce va sotto di lei (facoltativo)"), "avvisi": AVVISI},
        ["scheda", "testo"],
        lambda a: ["voce", a["scheda"], a["testo"]]
        + (["--checklist", a["checklist"]] if a.get("checklist") else [])
        + (["--sotto", a["sotto"]] if a.get("sotto") else [])
        + (["--scade", a["scade"]] if a.get("scade") else [])
        + (["--avvisi", json.dumps(a["avvisi"])] if a.get("avvisi") is not None else [])),
    "spunta": (
        "Segna fatta una voce di checklist (o da fare con fatta=false), con le sue sotto-voci; "
        "una voce madre è fatta quando lo sono tutte le figlie.",
        {"scheda": SCHEDA, "voce": s("id della voce"), "fatta": b("default true")}, ["scheda", "voce"],
        lambda a: ["spunta", a["scheda"], a["voce"]] + (["--no"] if a.get("fatta") is False else [])),
    "modifica": (
        "Cambia una scheda in una chiamata: passa solo i campi da cambiare. "
        "Spostare in un'altra colonna la toglie dall'archivio; posizione 0 = in cima.",
        {"scheda": SCHEDA, "titolo": s("titolo"), "descrizione": s("descrizione in Markdown (sostituisce quella attuale)"),
         "scade": DUE, "priorita": i("priorità da 1 (la più alta) a 5 (la più bassa), 0 per toglierla"), "fatta": b("completata"),
         "etichette": {"type": "array", "items": {"type": "string"}, "description": "nomi o id delle etichette (sostituiscono quelle attuali)"},
         "ambito": s("id o nome della colonna di ambito"), "colonna": s("id o nome della colonna in cui spostarla"),
         "posizione": i("posto nella colonna, 0 = in cima"), "archiviata": b("archiviata o ripristinata"), "avvisi": AVVISI},
        ["scheda"],
        lambda a: ["modifica", a["scheda"], changes(a, "scheda")]),
    "modifica_voce": (
        "Cambia o elimina una voce di checklist in una chiamata: passa solo i campi da cambiare.",
        {"scheda": SCHEDA, "voce": s("id della voce"), "testo": s("testo"), "scade": DUE, "fatta": b("fatta"),
         "posizione": i("posto nella checklist, 0 = in cima"), "checklist": s("id della checklist in cui spostarla"),
         "elimina": b("elimina la voce, con le sue sotto-voci"),
         "padre": s("id della voce sotto cui metterla (fino a 3 livelli); vuoto la porta al primo livello"), "avvisi": AVVISI},
        ["scheda", "voce"],
        lambda a: ["modifica-voce", a["scheda"], a["voce"], changes(a, "scheda", "voce")]),
    "nuova_checklist": (
        "Aggiunge una checklist vuota a una scheda e ne restituisce l'id.",
        {"scheda": SCHEDA, "titolo": s("titolo della checklist")}, ["scheda", "titolo"],
        lambda a: ["nuova-checklist", a["scheda"], a["titolo"]]),
    "modifica_checklist": (
        "Rinomina, sposta, nasconde le voci fatte o elimina una checklist (con tutte le sue voci).",
        {"scheda": SCHEDA, "checklist": s("id della checklist"), "titolo": s("titolo"),
         "nascondi_fatte": b("nasconde le voci fatte"), "posizione": i("posto tra le checklist, 0 = prima"),
         "elimina": b("elimina la checklist")},
        ["scheda", "checklist"],
        lambda a: ["modifica-checklist", a["scheda"], a["checklist"], changes(a, "scheda", "checklist")]),
    "modifica_commento": (
        "Cambia il testo di un commento, lo segna risolto o aperto, o lo elimina con le sue risposte.",
        {"scheda": SCHEDA, "commento": s("id del commento"), "testo": s("nuovo testo, in Markdown"),
         "risolto": b("risolto (false per riaprirlo)"), "elimina": b("elimina il commento e le risposte")},
        ["scheda", "commento"],
        lambda a: ["modifica-commento", a["scheda"], a["commento"], changes(a, "scheda", "commento")]),
    "modifica_colonna": (
        "Cambia una colonna: nome, sottotitolo (riga sotto il titolo) e note in Markdown (sostituiscono quelle "
        "attuali; si aprono dal sottotitolo), colore del pallino. Passa solo i campi da cambiare. "
        "Le note si leggono con lo strumento colonna.",
        {"colonna": s("id o nome della colonna"), "nome": s("nome della colonna"),
         "sottotitolo": s("sottotitolo, vuoto per toglierlo"), "note": s("note in Markdown, vuote per toglierle"),
         "colore": s(f"colore: {COLORI}, vuoto per toglierlo")},
        ["colonna"],
        lambda a: ["modifica-colonna", a["colonna"], changes(a, "colonna")]),
    "elimina_scheda": (
        "Elimina definitivamente una scheda (per toglierla senza perderla usa modifica con archiviata=true). "
        "Rifiuta le schede con file allegati, che vanno eliminate dall'app.",
        {"scheda": SCHEDA}, ["scheda"],
        lambda a: ["elimina", a["scheda"]]),
    "commenta": (
        "Aggiunge un commento di Claude a una scheda.",
        {"scheda": SCHEDA, "testo": s("testo, in Markdown")}, ["scheda", "testo"],
        lambda a: ["commenta", a["scheda"], a["testo"]]),
    "rispondi": (
        f"Risponde a un commento di {OWNER}, e se risolvi=true lo segna risolto.",
        {"scheda": SCHEDA, "commento": s("id del commento"), "testo": s("risposta, in Markdown"),
         "risolvi": b("segna risolto il commento")}, ["scheda", "commento", "testo"],
        lambda a: ["rispondi", a["scheda"], a["commento"], a["testo"]] + (["--risolvi"] if a.get("risolvi") else [])),
    "risolvi": (
        "Segna risolto un commento.",
        {"scheda": SCHEDA, "commento": s("id del commento")}, ["scheda", "commento"],
        lambda a: ["risolvi", a["scheda"], a["commento"]]),
    "tempo": (
        "Minuti di lavoro registrati su una scheda. Con data, focus e agenti scrive (o sostituisce) quel giorno.",
        {"scheda": SCHEDA, "data": s("AAAA-MM-GG"), "focus": i(f"minuti di focus di {OWNER}"),
         "agenti": i("minuti di lavoro degli agenti")}, ["scheda"],
        lambda a: ["tempo", a["scheda"]]
        + ([a["data"], str(a["focus"]), str(a["agenti"])] if a.get("data") else [])),
}


def run(name, args):
    _, props, required, build = TOOLS[name]
    missing = [k for k in required if args.get(k) in (None, "")]
    if missing:
        return f"Mancano: {', '.join(missing)}", True
    if name == "tempo" and args.get("data") and (args.get("focus") is None or args.get("agenti") is None):
        return "Con data servono anche focus e agenti.", True
    # Il token in memoria può avere più di un'ora: si riparte da quello salvato in dati/token.json,
    # che jb.py rinnova da solo dopo 50 minuti.
    jb._token = None
    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer):
            jb.main(build(args))
    except SystemExit as stop:
        message = stop.code if isinstance(stop.code, str) else f"uscita {stop.code}"
        return (buffer.getvalue() + message).strip(), True
    except Exception as error:  # rete, Firestore, dati inattesi
        return (buffer.getvalue() + f"{type(error).__name__}: {error}").strip(), True
    return buffer.getvalue().strip() or "Fatto.", False


def tool_list():
    return [{"name": name, "description": desc,
             "inputSchema": {"type": "object", "properties": props, "required": required}}
            for name, (desc, props, required, _) in TOOLS.items()]


def handle(msg):
    method, params = msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion", PROTOCOL),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "bacheca", "version": "1.0"},
                "instructions": f"Bacheca di Jarvis (Trello personale di {OWNER} su Firestore). "
                                f"Ogni scheda si apre da {jb.URL}/#c/<id scheda>."}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": tool_list()}
    if method == "tools/call":
        name = params.get("name")
        if name not in TOOLS:
            raise LookupError(f"Strumento sconosciuto: {name}")
        text, failed = run(name, params.get("arguments") or {})
        return {"content": [{"type": "text", "text": text}], "isError": failed}
    raise LookupError(f"Metodo non supportato: {method}")


def send(obj):
    OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    OUT.flush()


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "JSON non valido"}})
            continue
        if "id" not in msg:  # notifiche (initialized, cancelled): nessuna risposta
            continue
        try:
            send({"jsonrpc": "2.0", "id": msg["id"], "result": handle(msg)})
        except LookupError as error:
            send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": str(error)}})
        except Exception as error:
            send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32603, "message": f"{type(error).__name__}: {error}"}})


if __name__ == "__main__":
    main()
