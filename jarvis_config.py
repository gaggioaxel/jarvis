"""Configurazione privata di Jarvis, condivisa da tutti gli script Python.

Legge ~/.config/jarvis/config.json (o il file indicato da JARVIS_CONFIG). Il file non sta nel
repository: si parte da config.example.json. Ogni chiave assente prende il valore predefinito
qui sotto, così gli script funzionano anche senza config (per esempio contro l'emulatore).
"""
import json
import os
from pathlib import Path

REPO = Path(__file__).resolve().parent
CONFIG_DIR = Path.home() / ".config" / "jarvis"
CONFIG_FILE = Path(os.environ.get("JARVIS_CONFIG", CONFIG_DIR / "config.json")).expanduser()

DEFAULTS = {
    # Chi usa la bacheca: compare nei testi ("commenti di …") e come autore dei commenti.
    "owner_name": "Utente",
    # Gli unici account Google che entrano nella bacheca e nel connettore MCP.
    "allowed_emails": [],
    # Progetto Firebase e indirizzi pubblici dell'istanza.
    "firebase_project": "demo-bacheca",
    "bacheca_url": "",            # predefinito: https://<firebase_project>.web.app
    "worker_name": "jarvis-bacheca-mcp",
    "worker_url": "",             # https://<worker_name>.<sottodominio>.workers.dev
    "kv_namespace_id": "",        # namespace KV del Worker (OAUTH_KV)
    "vapid_public": "",           # chiave pubblica VAPID (la privata resta in vapid.json e nel secret del Worker)
    "timezone": "Europe/Rome",
    # File privati: chiave dell'account di servizio, dati locali (token, backup, impronte).
    "service_account": str(CONFIG_DIR / "bacheca-sa.json"),
    "data_dir": str(REPO / "bacheca" / "dati"),
    # File personali della radice (diario, storico, mappa dei progetti, correzioni, scansione).
    "storico": str(REPO / "storico.csv"),
    "diario_dir": str(REPO / "diario"),
    "mappa": str(REPO / "mappa.json"),
    "correzioni": str(REPO / "correzioni.json"),
    "state": str(REPO / "state.json"),
    "tracker_dir": "~/Documents/tracker/data",
    "transcripts_dir": "~/.claude/projects",
    # scan.py: cartelle che contengono progetti, progetti singoli, contenitori, nomi da saltare.
    "scan": {"roots": ["~/Documents"], "singles": [], "containers": [], "skip_names": ["jarvis"]},
    # Vista Tempo e bacheca: ambiti (id, nome, colore della bacheca).
    "areas": [
        {"id": "lavoro", "name": "Lavoro", "color": "blue"},
        {"id": "studio", "name": "Studio", "color": "purple"},
        {"id": "side", "name": "Side project", "color": "pink"},
    ],
    # Vista Tempo: codici che vanno in un ambito diverso da quello della mappa ({"area": ..., "code_regex": ..., "to": ...}).
    "area_rules": [],
    # Vista Agenti: canone mensile in euro per account e ordine degli account.
    "abbonamenti": {},
    # Vista Agenti, scheda Sessioni: contesto (token) oltre cui una chat conviene chiuderla e ripartire.
    "contesto_lungo": 300000,
    # Vista Agenti: prezzi di listino in USD per milione di token (in: input, out: output, cr: rilettura
    # dalla cache; le scritture in cache costano 1,25 volte l'input, o 2 volte se durano un'ora).
    # Vale la chiave uguale al modello, altrimenti la più lunga contenuta nel suo nome ("neon" per
    # "gemini-4-neon-high"). Claude: listino Anthropic del 24/11/2026. Gemini: blog di Google, novembre
    # 2026; la rilettura è nota solo per Neon, per gli altri è stimata al 10% dell'input.
    "prezzi": {
        "claude-opus-5-5": {"in": 4, "out": 20, "cr": 0.20},
        "claude-sonnet-5-5": {"in": 2, "out": 10, "cr": 0.10},
        "claude-haiku-5-5": {"in": 0.10, "out": 0.50, "cr": 0.01},
        "claude-fable-5-2": {"in": 8, "out": 40, "cr": 0.20},
        "hydrogen": {"in": 1.50, "out": 7.50, "cr": 0.15},
        "neon": {"in": 3, "out": 15, "cr": 0.15},
        "flash": {"in": 0.75, "out": 3.75, "cr": 0.075},
    },
    # giornata.py: cronologia del browser, per dare un tipo di lavoro ai minuti passati nel browser.
    # "categorie": nome -> domini (accetta * come in "webmail.*"); vale la prima che combacia.
    # "categorie_mie": come "categorie", ma si aggiungono davanti invece di sostituirle (per i domini personali).
    "browser": {
        "history": "~/.config/BraveSoftware/Brave-Browser/Default/History",
        "storico": str(REPO / "storico_browser.csv"),
        # Pezzi di titolo che dicono gia' il sito, anche quando la pagina non e' in cronologia (riunioni, chat, video).
        # Qui solo segnaposto: i tuoi vanno in "browser.titoli" di config.json.
        "titoli": {
            " - posta": "mail.example.com",
        },
        # Segnaposto: le categorie vere vanno in "browser.categorie" di config.json (che sostituisce queste).
        "categorie": {
            "Posta": ["mail.example.com"],
            "Codice": ["github.com", "localhost", "127.0.0.1"],
            "Documenti": ["docs.example.com"],
            "Ricerche web": ["www.example.com"],
        },
    },
    # agenti_raccolta.py: sorgenti delle statistiche.
    "agenti": {
        "projects_dir": "~/.claude/projects",
        "sessions_glob": "~/.config/Claude*/claude-code-sessions",
        "usage_config": "~/.config/claude-usage-bar/config.json",
        "usage_log": "~/.local/share/claude-usage-bar/usage-log.csv",
        "gemini_calls": "~/.local/share/gemini-delegate/calls.jsonl",
        # Righe scritte dalle chat (Edit e Write): estensioni che contano come documentazione (il resto
        # è codice) e file che non contano (accetta * e ~): memoria e piani di Claude, file generati.
        "righe_doc": [".md", ".txt", ".rst", ".tex", ".adoc"],
        "righe_escludi": ["~/.claude/*", "/tmp/*", "*/package-lock.json", "*.lock", "*.min.js", "*.min.css"],
    },
}


def _load():
    data = dict(DEFAULTS)
    try:
        user = json.loads(CONFIG_FILE.read_text())
    except FileNotFoundError:
        user = {}
    for key, value in user.items():
        if key.startswith("_"):
            continue
        if isinstance(value, dict) and isinstance(DEFAULTS.get(key), dict):
            data[key] = {**DEFAULTS[key], **value}
        else:
            data[key] = value
    if not data["bacheca_url"]:
        data["bacheca_url"] = f"https://{data['firebase_project']}.web.app"
    return data


CONFIG = _load()


def get(key):
    return CONFIG[key]


def path(key):
    """Valore di config come Path, con ~ espansa."""
    return Path(os.path.expanduser(str(CONFIG[key])))


def expand(value):
    return Path(os.path.expanduser(str(value)))
