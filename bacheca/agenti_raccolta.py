#!/usr/bin/python3
"""Raccolta giornaliera dell'uso dei modelli (Claude e Gemini) per la vista Agenti.

Solo libreria standard. Costruisce i documenti della collezione Firestore `agenti`
secondo il contratto: uno per giorno (id "AAAA-MM-GG" in ora locale, fuso "timezone" della config).
"""
from __future__ import annotations

import argparse
import csv
import fnmatch
import glob
import json
import math
import os
import subprocess
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path, PurePosixPath
from zoneinfo import ZoneInfo

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import jarvis_config  # noqa: E402

# Fuso della giornata (chiave "timezone" della config; il nome ROME resta per compatibilità).
ROME = ZoneInfo(jarvis_config.get("timezone"))

# Percorsi delle sorgenti: chiave "agenti" della config (sovrascrivibili dall'esterno per i test).
_SRC = jarvis_config.get("agenti")
PROJECTS_DIR = jarvis_config.expand(_SRC["projects_dir"])
SESSIONS_GLOB = str(jarvis_config.expand(_SRC["sessions_glob"]))
USAGE_CONFIG = jarvis_config.expand(_SRC["usage_config"])
USAGE_LOG = jarvis_config.expand(_SRC["usage_log"])
GEMINI_CALLS = jarvis_config.expand(_SRC["gemini_calls"])
DOC_EXT = tuple(str(e).lower() for e in _SRC.get("righe_doc") or [])
SKIP_FILES = [os.path.expanduser(str(p)) for p in _SRC.get("righe_escludi") or []]
# Una chiamata Gemini è della chat il cui risultato di gemini_ask arriva entro questi secondi dal log.
GEMINI_MATCH_SECS = 60
# Un commit è della chat se cade tra la prima modifica e questo margine dopo l'ultima, e tocca i suoi file.
COMMIT_MARGIN = timedelta(minutes=20)
HOME = Path.home()
# Correzioni a mano: {"<id della sessione>": "<codice di mappa.json o nome libero>"}; file privato.
CHAT_PROGETTI = jarvis_config.expand(_SRC.get("chat_progetti") or (jarvis_config.REPO / "chat_progetti.json"))
SENZA_PROGETTO = "senza progetto"


def _as_path(value: Path | str) -> Path:
    return Path(os.path.expanduser(str(value)))


def _parse_iso(stamp: str, *, assume_tz=timezone.utc) -> datetime | None:
    """Converte un timestamp ISO (anche con 'Z' o '+0100') in datetime locale (fuso della config)."""
    if not stamp or not isinstance(stamp, str):
        return None
    text = stamp.strip()
    if text[-1:] in ("Z", "z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=assume_tz)
    return dt.astimezone(ROME)


def _parse_since(since: date | datetime | str | None) -> date | None:
    if since is None:
        return None
    if isinstance(since, datetime):
        return (since.astimezone(ROME) if since.tzinfo else since).date()
    if isinstance(since, date):
        return since
    if isinstance(since, str):
        text = since.strip()
        if "T" in text or " " in text:
            dt = _parse_iso(text, assume_tz=ROME)
            if dt is not None:
                return dt.date()
        return date.fromisoformat(text[:10])
    raise TypeError(f"Valore since non valido: {since!r}")


def _first_day(days: int | None, since: date | datetime | str | None) -> tuple[date | None, bool]:
    """Restituisce (primo_giorno_incluso, vuoto_immediato)."""
    starts: list[date] = []
    if days is not None:
        if days <= 0:
            return None, True
        today = datetime.now(ROME).date()
        starts.append(today - timedelta(days=days - 1))
    since_date = _parse_since(since)
    if since_date is not None:
        starts.append(since_date)
    return (max(starts) if starts else None), False


def _load_org_labels() -> dict[str, str]:
    """org -> nome mostrato in Jarvis: il campo "jarvis" del config della barra, altrimenti "label".
    Include "gemini" -> "gemini_jarvis" (default "Gemini")."""
    cfg_path = _as_path(USAGE_CONFIG)
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data = data if isinstance(data, dict) else {}
    names: dict[str, str] = {"gemini": str(data.get("gemini_jarvis") or "Gemini")}
    accounts = data.get("accounts")
    for item in accounts if isinstance(accounts, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("org"), str):
            continue
        name = item.get("jarvis") or item.get("label")
        if isinstance(name, str) and name:
            names[item["org"]] = name
    return names


def _load_session_accounts(titles_out: dict[str, str] | None = None) -> dict[str, str]:
    """Mappa cliSessionId -> etichetta account leggendo `cliSessionId` dai file di sessione dell'app.
    Se titles_out è un dict, ci mette anche il titolo di ogni chat (serve solo a classificarla, non si carica)."""
    org_labels = _load_org_labels()
    mapping: dict[str, str] = {}
    pattern = os.path.expanduser(str(SESSIONS_GLOB))
    for base_str in sorted(glob.glob(pattern)):
        base = Path(base_str)
        if not base.is_dir():
            continue
        for session_file in sorted(base.glob("*/*/local_*.json")):
            org_id = session_file.parent.name
            try:
                raw = json.loads(session_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(raw, dict):
                continue
            cli_id = raw.get("cliSessionId")
            if isinstance(cli_id, str) and cli_id:
                mapping[cli_id] = org_labels.get(org_id) or org_id[:8] or "CLI"
                if titles_out is not None and isinstance(raw.get("title"), str):
                    titles_out[cli_id] = raw["title"]
    return mapping


def _load_overrides() -> dict[str, str]:
    """Correzioni a mano da chat_progetti.json (le chiavi che iniziano con "_" sono note)."""
    try:
        data = json.loads(CHAT_PROGETTI.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: str(v) for k, v in data.items() if isinstance(data, dict) and not k.startswith("_") and v}


def _project_name(cwd: object) -> str:
    if not isinstance(cwd, str) or not cwd:
        return ""
    if "/scratch-workspaces/" in cwd or cwd.rstrip("/").endswith("/scratch-workspaces"):
        return "scratch"
    return PurePosixPath(cwd).name


class _Mappa:
    """Progetti di mappa.json per percorso, come Mapper.by_path di giornata.py: vince il percorso più lungo."""

    def __init__(self):
        try:
            entries = json.loads(jarvis_config.path("mappa").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            entries = []
        self.paths = sorted(
            ((str(HOME / p).rstrip("/"), e) for e in entries if isinstance(e, dict)
             for p in e.get("percorsi") or [] if isinstance(p, str) and p),
            key=lambda x: len(x[0]), reverse=True)
        self.codes = {str(e.get("codice")): e for e in entries if isinstance(e, dict) and e.get("codice")}
        self.words = sorted(
            ((w.lower(), e) for e in entries if isinstance(e, dict) for w in e.get("parole") or [] if isinstance(w, str) and w),
            key=lambda x: len(x[0]), reverse=True)
        self._cache: dict[str, dict | None] = {}
        self._folders: dict[str, str] = {}

    def by_path(self, path: str) -> dict | None:
        if path not in self._cache:
            self._cache[path] = next(
                (e for prefix, e in self.paths if path == prefix or path.startswith(prefix + "/")), None)
        return self._cache[path]

    def label(self, cwd: object) -> tuple[str, str]:
        """(codice, nome) del progetto di una cartella; fuori dalla mappa ("", nome della cartella)."""
        entry = self.by_path(cwd) if isinstance(cwd, str) and cwd else None
        if entry:
            return str(entry.get("codice") or ""), str(entry.get("nome") or entry.get("codice") or "")
        name = _project_name(cwd)
        return "", (SENZA_PROGETTO if name in ("scratch", "") else name)

    @staticmethod
    def _entry(entry: dict) -> tuple[str, str]:
        return str(entry.get("codice") or ""), str(entry.get("nome") or entry.get("codice") or "")

    def by_code(self, value: str) -> tuple[str, str]:
        """Correzione a mano: codice della mappa, o nome libero per un progetto che non c'è."""
        return self._entry(self.codes[value]) if value in self.codes else ("", value)

    def by_title(self, title: str | None) -> tuple[str, str] | None:
        low = (title or "").lower()
        return next((self._entry(e) for w, e in self.words if w in low), None) if low else None

    def folder(self, file_path: str) -> str:
        """Nome del progetto di un file fuori dalla mappa: la radice del suo repository git, altrimenti la
        sua cartella; "" per i file sparsi nella home o fuori."""
        folder = os.path.dirname(file_path)
        if folder not in self._folders:
            top = _git(folder, "rev-parse", "--show-toplevel").strip() if os.path.isdir(folder) else ""
            self._folders[folder] = self._folder_name(top or self._project_root(folder))
        return self._folders[folder]

    @staticmethod
    def _project_root(folder: str) -> str:
        """Radice del progetto di una cartella senza git, con le cartelle di progetti di scan.py: la figlia
        diretta della cartella di progetti più vicina, un progetto singolo, altrimenti il primo livello
        sotto la home."""
        scan = jarvis_config.get("scan")
        roots = sorted((str(jarvis_config.expand(p)) for p in scan.get("roots") or []), key=len, reverse=True)
        for root in roots:
            if folder.startswith(root + "/"):
                return os.path.join(root, folder[len(root) + 1:].split("/")[0])
        for single in (str(jarvis_config.expand(p)) for p in scan.get("singles") or []):
            if folder == single or folder.startswith(single + "/"):
                return single
        if folder.startswith(str(HOME) + "/"):
            return os.path.join(str(HOME), folder[len(str(HOME)) + 1:].split("/")[0])
        return ""

    @staticmethod
    def _folder_name(base: str) -> str:
        """Nome mostrato per la radice di un progetto; "" per la home, le cartelle generiche e quelle nascoste."""
        generic = {str(HOME / d) for d in ("", "Documents", "Downloads", "Desktop", "Scaricati", "Documenti")}
        if not base.startswith(str(HOME) + "/") or base.rstrip("/") in generic or "/." in base[len(str(HOME)):]:
            return ""
        return os.path.basename(base.rstrip("/"))


def _skip_file(path: str) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in SKIP_FILES)


def _patch_counts(result: dict) -> tuple[int, int]:
    """Righe aggiunte e tolte da un Edit o un Write: dal diff, o tutto il contenuto per un file nuovo."""
    if result.get("type") == "create":
        content = result.get("content")
        return (len(content.splitlines()) if isinstance(content, str) else 0), 0
    added = removed = 0
    for hunk in result.get("structuredPatch") or []:
        for line in (hunk.get("lines") if isinstance(hunk, dict) else None) or []:
            if isinstance(line, str):
                if line.startswith("+"):
                    added += 1
                elif line.startswith("-"):
                    removed += 1
    return added, removed


def _git(repo: str, *args: str) -> str:
    try:
        return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=20,
                              check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _repo_commits(repo: str, since: datetime) -> list[tuple[datetime, str, set[str]]]:
    """Commit del repository da `since`: (istante, titolo, file toccati in percorso assoluto)."""
    out = _git(repo, "log", "--all", f"--since={since.isoformat()}", "--no-merges",
               "--format=\x1e%ct\x1f%s", "--name-only")
    commits = []
    for chunk in out.split("\x1e")[1:]:
        head, _, names = chunk.partition("\n")
        stamp, _, subject = head.partition("\x1f")
        try:
            when = datetime.fromtimestamp(int(stamp), ROME)
        except ValueError:
            continue
        files = {os.path.join(repo, n) for n in names.splitlines() if n.strip()}
        commits.append((when, subject.strip()[:120], files))
    return commits


def _subagent_type(jsonl_path: Path) -> str:
    meta_path = jsonl_path.with_suffix(".meta.json")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "subagent"
    if isinstance(meta, dict):
        agent_type = meta.get("agentType")
        if isinstance(agent_type, str) and agent_type:
            return agent_type
    return "subagent"


def _int_field(mapping: dict, key: str) -> int:
    val = mapping.get(key)
    try:
        n = int(val) if val is not None else 0
    except (TypeError, ValueError, OverflowError):
        return 0
    return n if n >= 0 else 0


def _collect_transcripts(
    first_day: date | None,
    first_ts: float | None,
    session_accounts: dict[str, str],
    raw_out: dict | None = None,
    mappa: _Mappa | None = None,
) -> dict[str, list[dict]]:
    """Legge le trascrizioni Claude Code e aggrega per (giorno, h, account, model, project, agent).
    "project" è il nome del progetto in mappa.json, o della cartella se non è in mappa.
    Se raw_out è un dict, ci mette anche quello che serve al riepilogo per sessione (_summarize_sessions):
    richieste, modifiche ai file (Edit e Write), risultati di gemini_ask e cartella di ogni sessione."""
    root = _as_path(PROJECTS_DIR)
    if not root.is_dir():
        return {}
    mappa = mappa or _Mappa()
    # Per sessione: (sessionId, istante, contesto della richiesta, è dell'agente principale), per chiave di dedup.
    meta: dict[tuple, tuple[str, datetime, int, bool]] = {}

    # Deduplica per (sessionId, requestId) mantenendo l'ultima occorrenza incontrata.
    dedup: dict[tuple, tuple[str, int, str, str, str, str, int, int, int, int, int, int]] = {}
    # Modifiche ai file per (sessionId, id della chiamata): (giorno, sessionId, istante, file, aggiunte, tolte).
    edits: dict[tuple, tuple[str, str, datetime, str, int, int]] = {}
    # Istanti in cui una sessione ha ricevuto il risultato di gemini_ask: (sessionId, istante).
    gem_results: set[tuple[str, datetime]] = set()
    # Cartella di lavoro di ogni sessione: dell'agente principale se c'è, altrimenti di un sottoagente.
    cwds: dict[str, tuple[bool, str]] = {}

    files: list[tuple[Path, str, str]] = []
    for project_dir in sorted(root.iterdir()):
        if not project_dir.is_dir():
            continue
        for main_file in sorted(project_dir.glob("*.jsonl")):
            if main_file.name.startswith("agent-"):
                files.append((main_file, None, main_file.stem))  # vecchio formato: sottoagente in radice
            else:
                files.append((main_file, "principale", main_file.stem))
        for sub_file in sorted(project_dir.glob("*/subagents/agent-*.jsonl")):
            files.append((sub_file, None, sub_file.parent.parent.name))

    # Margine di un'ora sul filtro per mtime: granularità del kernel e orologio possono far
    # risultare l'ultima scrittura appena prima della mezzanotte del primo giorno.
    min_mtime = first_ts - 3600 if first_ts is not None else None
    for path, agent, fallback_session in files:
        try:
            st = os.stat(path)
        except OSError:
            continue
        if min_mtime is not None and st.st_mtime < min_mtime:
            continue
        if agent is None:
            agent = _subagent_type(path)
        gem_ids: set[str] = set()

        try:
            fh = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            continue

        with fh:
            for line_no, line in enumerate(fh, 1):
                # Si decodificano solo le richieste al modello e i risultati delle modifiche o di gemini_ask:
                # il resto (messaggi, altri risultati, allegati) si scarta senza leggerlo.
                is_usage = '"assistant"' in line and '"usage"' in line
                # (i risultati degli strumenti MCP, come gemini_ask, non hanno "toolUseResult").
                is_result = ('"structuredPatch"' in line and '"toolUseResult"' in line) or (
                    bool(gem_ids) and '"tool_result"' in line)
                if not (is_usage or is_result):
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(obj, dict):
                    continue
                session_id = obj.get("sessionId")
                if not isinstance(session_id, str) or not session_id:
                    session_id = fallback_session
                msg = obj.get("message")
                if not isinstance(msg, dict):
                    continue
                cwd = obj.get("cwd")
                if isinstance(cwd, str) and cwd and not cwds.get(session_id, (False,))[0]:
                    cwds[session_id] = (agent == "principale", cwd)

                if obj.get("type") != "assistant":
                    _read_result(obj, msg, session_id, first_day, gem_ids, edits, gem_results, path, line_no)
                    continue

                if 'gemini_ask"' in line:
                    for block in msg.get("content") or []:
                        if (isinstance(block, dict) and block.get("type") == "tool_use"
                                and "gemini_ask" in str(block.get("name") or "") and block.get("id")):
                            gem_ids.add(block["id"])

                usage = msg.get("usage")
                if not isinstance(usage, dict):
                    continue
                model = msg.get("model")
                if not isinstance(model, str) or not model or model == "<synthetic>":
                    continue

                local_dt = _parse_iso(obj.get("timestamp"))
                if local_dt is None:
                    continue
                if first_day is not None and local_dt.date() < first_day:
                    continue

                req_id = obj.get("requestId")
                msg_id = msg.get("id")
                if isinstance(req_id, str) and req_id:
                    dedup_key: tuple = (session_id, req_id)
                elif isinstance(msg_id, str) and msg_id:
                    dedup_key = (session_id, "msg", msg_id)
                else:
                    dedup_key = ("_noid", str(path), line_no)

                account = session_accounts.get(session_id, "CLI")
                project = mappa.label(cwd)[1]

                details = usage.get("output_tokens_details")
                details = details if isinstance(details, dict) else {}
                stu = usage.get("server_tool_use")
                stu = stu if isinstance(stu, dict) else {}

                inp = _int_field(usage, "input_tokens")
                out = _int_field(usage, "output_tokens")
                think = _int_field(details, "thinking_tokens")
                cache_read = _int_field(usage, "cache_read_input_tokens")
                cache_write = _int_field(usage, "cache_creation_input_tokens")
                cc = usage.get("cache_creation")
                cache_write_1h = min(cache_write, _int_field(cc, "ephemeral_1h_input_tokens")) if isinstance(cc, dict) else 0
                web = _int_field(stu, "web_search_requests") + _int_field(stu, "web_fetch_requests")

                dedup[dedup_key] = (
                    local_dt.strftime("%Y-%m-%d"),
                    local_dt.hour,
                    account,
                    model,
                    project,
                    agent,
                    inp,
                    out,
                    think,
                    cache_read,
                    cache_write,
                    cache_write_1h,
                    web,
                )
                meta[dedup_key] = (session_id, local_dt, inp + cache_read + cache_write, agent == "principale")

    grouped: dict[tuple[str, int, str, str, str, str], list[int]] = {}
    for day, hour, account, model, project, agent, *vals in dedup.values():
        key = (day, hour, account, model, project, agent)
        acc = grouped.setdefault(key, [0] * (len(vals) + 1))
        acc[0] += 1
        for i, v in enumerate(vals, 1):
            acc[i] += v

    by_day: dict[str, list[dict]] = defaultdict(list)
    for (day, hour, account, model, project, agent), counts in grouped.items():
        by_day[day].append({
            "h": hour,
            "account": account,
            "model": model,
            "project": project,
            "agent": agent,
            "req": counts[0],
            "input": counts[1],
            "output": counts[2],
            "thinking": counts[3],
            "cache_read": counts[4],
            "cache_write": counts[5],
            "cache_write_1h": counts[6],
            "web": counts[7],
        })

    for rows in by_day.values():
        rows.sort(key=lambda r: (r["h"], r["account"], r["model"], r["project"], r["agent"]))
    if raw_out is not None:
        raw_out.update(dedup=dedup, meta=meta, edits=edits, gem_results=gem_results,
                       cwds={sid: cwd for sid, (_, cwd) in cwds.items()}, mappa=mappa,
                       accounts=session_accounts)
    return dict(by_day)


def _read_result(obj: dict, msg: dict, session_id: str, first_day: date | None, gem_ids: set[str],
                 edits: dict, gem_results: set, path: Path, line_no: int) -> None:
    """Risultato di uno strumento: righe cambiate da un Edit o un Write, o istante di un gemini_ask."""
    local_dt = _parse_iso(obj.get("timestamp"))
    if local_dt is None or (first_day is not None and local_dt.date() < first_day):
        return
    tool_ids = [b.get("tool_use_id") for b in msg.get("content") or []
                if isinstance(b, dict) and b.get("type") == "tool_result"]
    if any(t in gem_ids for t in tool_ids):
        gem_results.add((session_id, local_dt))
    result = obj.get("toolUseResult")
    if not isinstance(result, dict) or not isinstance(result.get("structuredPatch"), list):
        return
    file_path = result.get("filePath")
    if not isinstance(file_path, str) or not file_path or _skip_file(file_path):
        return
    added, removed = _patch_counts(result)
    if not (added or removed):
        return
    # Una chiamata può comparire in più file (sessioni riprese o biforcate): conta una volta.
    key = (session_id, tool_ids[0]) if tool_ids and tool_ids[0] else (session_id, "uuid", obj.get("uuid") or f"{path}:{line_no}")
    edits[key] = (local_dt.strftime("%Y-%m-%d"), session_id, local_dt, file_path, added, removed)


def _match_gemini(gem_calls: list[tuple[datetime, dict]], gem_results: set) -> dict[tuple[str, str], list[dict]]:
    """Chiamate Gemini legate alla sessione che le ha fatte: il log scrive l'istante di fine, che coincide
    col risultato di gemini_ask nella trascrizione. {(giorno, sessione): [chiamate]}."""
    results = sorted(gem_results, key=lambda x: x[1])
    used: set[tuple[str, datetime]] = set()
    out: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for when, call in gem_calls:
        best = None
        for item in results:
            gap = abs((item[1] - when).total_seconds())
            if gap <= GEMINI_MATCH_SECS and item not in used and (best is None or gap < best[0]):
                best = (gap, item)
        if best:
            used.add(best[1])
            out[(when.strftime("%Y-%m-%d"), best[1][0])].append(call)
    return out


def _session_commits(edits: dict, mappa: _Mappa) -> dict[tuple[str, str], list[dict]]:
    """Commit fatti durante una sessione: nel repository dei file che ha cambiato, tra la prima modifica
    e COMMIT_MARGIN dopo l'ultima, e che toccano almeno uno di quei file. {(giorno, sessione): [commit]}."""
    by_session: dict[str, dict] = {}
    for _day, sid, when, file_path, _a, _r in edits.values():
        s = by_session.setdefault(sid, {"first": when, "last": when, "files": set()})
        s["first"], s["last"] = min(s["first"], when), max(s["last"], when)
        s["files"].add(file_path)
    if not by_session:
        return {}
    roots: dict[str, str | None] = {}

    def repo_of(file_path: str) -> str | None:
        folder = os.path.dirname(file_path)
        if folder not in roots:
            top = _git(folder, "rev-parse", "--show-toplevel").strip() if os.path.isdir(folder) else ""
            roots[folder] = top or None
        return roots[folder]

    wanted: dict[str, datetime] = {}
    for s in by_session.values():
        s["repos"] = {r for r in map(repo_of, s["files"]) if r}
        for r in s["repos"]:
            wanted[r] = min(wanted.get(r, s["first"]), s["first"])
    commits = {r: _repo_commits(r, since - timedelta(minutes=1)) for r, since in wanted.items()}
    out: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for sid, s in by_session.items():
        seen: set[str] = set()
        for repo in sorted(s["repos"]):
            for when, subject, touched in commits.get(repo, []):
                if s["first"] <= when <= s["last"] + COMMIT_MARGIN and touched & s["files"] and subject not in seen:
                    seen.add(subject)
                    code = mappa.label(repo)[0]
                    out[(when.strftime("%Y-%m-%d"), sid)].append({"t": when.strftime("%H:%M"), "code": code, "title": subject})
    return out


def _summarize_sessions(raw: dict, gem_calls: list[tuple[datetime, dict]] | None = None) -> dict[str, list[dict]]:
    """Una voce per (giorno, sessione): token per modello (sottoagenti e chiamate Gemini compresi, per il
    costo), turni dell'agente principale, contesto letto a ogni turno (input + cache), massimo e dell'ultimo
    turno, progetto e righe cambiate per progetto (codice e documentazione), commit fatti nella sessione.
    Solo misure, id della sessione, nomi dei progetti e titoli dei commit: niente testi delle conversazioni."""
    mappa: _Mappa = raw.get("mappa") or _Mappa()
    cwds: dict[str, str] = raw.get("cwds", {})
    accounts: dict[str, str] = raw.get("accounts", {})
    titles: dict[str, str] = raw.get("titles", {})
    overrides: dict[str, str] = raw.get("overrides", {})

    def fallback(sid: str) -> tuple[str, str]:
        """Progetto di una chat senza file in mappa: correzione a mano, cartella in mappa, titolo, cartella."""
        if sid in overrides:
            return mappa.by_code(overrides[sid])
        code, name = mappa.label(cwds.get(sid))
        if code:
            return code, name
        return mappa.by_title(titles.get(sid)) or (code, name)
    acc: dict[tuple[str, str], dict] = {}

    def entry(day: str, sid: str, when: datetime) -> dict:
        s = acc.get((day, sid))
        if s is None:
            s = acc[(day, sid)] = {
                "id": sid, "account": accounts.get(sid, "CLI"), "first": when, "last": when, "turns": 0,
                "ctx_max": 0, "ctx_last": 0, "_ctx_at": None, "use": {}, "lines": {}, "commits": []}
        s["first"], s["last"] = min(s["first"], when), max(s["last"], when)
        return s

    for key, (day, _h, account, model, _project, _agent, inp, out, _think, cr, cw, cw1h, _web) in raw.get("dedup", {}).items():
        session_id, when, ctx, main = raw["meta"][key]
        s = entry(day, session_id, when)
        s["account"] = account
        u = s["use"].setdefault(model, [0, 0, 0, 0, 0, 0])
        for i, v in enumerate((1, inp, out, cr, cw, cw1h)):
            u[i] += v
        if main:
            s["turns"] += 1
            s["ctx_max"] = max(s["ctx_max"], ctx)
            if s["_ctx_at"] is None or when >= s["_ctx_at"]:
                s["_ctx_at"], s["ctx_last"] = when, ctx

    for (day, sid), calls in _match_gemini(gem_calls or [], raw.get("gem_results", set())).items():
        s = acc.get((day, sid))
        if s is None:
            continue
        for call in calls:
            u = s["use"].setdefault(call["model"] or "gemini", [0, 0, 0, 0, 0, 0])
            for i, v in enumerate((1, call["input_tokens"], call["output_tokens"] + call["thinking_tokens"],
                                   call["cache_read_tokens"], 0, 0)):
                u[i] += v

    # Righe per progetto: il file decide il progetto. Fuori dalla mappa vale la correzione a mano, poi la
    # cartella del file (il suo repository), poi il progetto della chat.
    for day, sid, when, file_path, added, removed in raw.get("edits", {}).values():
        s = entry(day, sid, when)
        code, name = mappa.label(file_path)
        if not code:
            if sid in overrides:
                code, name = mappa.by_code(overrides[sid])
            else:
                folder = mappa.folder(file_path)
                code, name = ("", folder) if folder else fallback(sid)
        ln = s["lines"].setdefault((code, name), {"code_add": 0, "code_del": 0, "doc_add": 0, "doc_del": 0, "files": set()})
        kind = "doc" if file_path.lower().endswith(DOC_EXT) else "code"
        ln[f"{kind}_add"] += added
        ln[f"{kind}_del"] += removed
        ln["files"].add(file_path)

    for (day, sid), commits in _session_commits(raw.get("edits", {}), mappa).items():
        if (day, sid) in acc:
            acc[(day, sid)]["commits"].extend(commits)

    out_by_day: dict[str, list[dict]] = defaultdict(list)
    for (day, sid), s in acc.items():
        projects = sorted(
            ({"code": code, "name": name, "code_add": ln["code_add"], "code_del": ln["code_del"],
              "doc_add": ln["doc_add"], "doc_del": ln["doc_del"], "files": len(ln["files"])}
             for (code, name), ln in s["lines"].items()),
            key=lambda p: -(p["code_add"] + p["code_del"] + p["doc_add"] + p["doc_del"]))
        # Progetto della sessione: la correzione a mano, altrimenti dove ha cambiato più righe, altrimenti
        # cartella in mappa, titolo della chat o cartella (fallback).
        fixed = sid in overrides
        if fixed:
            code, name = mappa.by_code(overrides[sid])
        else:
            code, name = (projects[0]["code"], projects[0]["name"]) if projects else fallback(sid)
        out_by_day[day].append({
            "id": s["id"], "project": name, "code": code, "account": s["account"],
            **({"fixed": True} if fixed else {}),
            "start": s["first"].strftime("%H:%M"), "end": s["last"].strftime("%H:%M"),
            "turns": s["turns"], "ctx_max": s["ctx_max"], "ctx_last": s["ctx_last"],
            "use": [{"model": m, "req": u[0], "input": u[1], "output": u[2], "cache_read": u[3],
                     "cache_write": u[4], "cache_write_1h": u[5]} for m, u in sorted(s["use"].items())],
            "lines": projects,
            "commits": sorted(s["commits"], key=lambda c: c["t"])[:12],
        })
    for items in out_by_day.values():
        items.sort(key=lambda x: (x["start"], x["id"]))
    return dict(out_by_day)


def _float_or_none(value: str | None) -> float | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        n = float(text)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


def _collect_limits(first_day: date | None) -> dict[str, list[dict]]:
    """Campioni dei limiti dal log della barra. Nome dell'account per org (come nei token); al più un
    campione ogni 10 minuti per account (l'ultimo), per tenere piccoli i documenti."""
    log_path = _as_path(USAGE_LOG)
    if not log_path.is_file():
        return {}
    names = _load_org_labels()
    keep: dict[tuple[str, str, int], tuple[datetime, dict]] = {}
    try:
        with log_path.open("r", encoding="utf-8-sig", errors="replace", newline="") as fh:
            for row in csv.DictReader(fh):
                local_dt = _parse_iso(row.get("time") or "", assume_tz=ROME)
                if local_dt is None or (first_day is not None and local_dt.date() < first_day):
                    continue
                fh_used = _float_or_none(row.get("five_hour_used"))
                sd_used = _float_or_none(row.get("weekly_used"))
                if fh_used is None and sd_used is None:
                    continue
                org = (row.get("org") or "").strip()
                account = names.get(org) or (row.get("account") or "").strip()
                if not account:
                    continue
                day = local_dt.strftime("%Y-%m-%d")
                slot = (local_dt.hour * 60 + local_dt.minute) // 10
                keep[(day, account, slot)] = (local_dt, {
                    "t": local_dt.strftime("%H:%M"), "account": account, "fh": fh_used, "sd": sd_used})
    except (OSError, csv.Error):
        pass  # riga troncata o file illeggibile: si tiene quello letto fin lì
    by_day: dict[str, list[tuple[datetime, dict]]] = defaultdict(list)
    for (day, _, _), item in keep.items():
        by_day[day].append(item)
    # Ordine per istante (non per "HH:MM", che si ripete al ritorno dell'ora solare).
    return {day: [x for _, x in sorted(items, key=lambda i: i[0])] for day, items in by_day.items()}


def _collect_gemini(first_day: date | None, raw_out: list | None = None) -> dict[str, list[dict]]:
    """Chiamate Gemini per giorno; se raw_out è una lista, ci mette anche (istante, chiamata) di ognuna."""
    calls_path = _as_path(GEMINI_CALLS)
    if not calls_path.is_file():
        return {}

    by_day: dict[str, list[dict]] = defaultdict(list)
    try:
        fh = calls_path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return {}

    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            local_dt = _parse_iso(obj.get("t"), assume_tz=ROME)
            if local_dt is None:
                continue
            if first_day is not None and local_dt.date() < first_day:
                continue
            day = local_dt.strftime("%Y-%m-%d")
            # Solo i campi del contratto, con tipi controllati.
            secs = _float_or_none(str(obj.get("secs", "")))
            entry = {
                "t": local_dt.strftime("%H:%M"),
                "model": str(obj.get("model") or "")[:80],
                "secs": round(secs, 1) if secs is not None else 0.0,
                "ok": obj.get("ok") is True,
            }
            for key in ("paths", "writable", "prompt_chars", "out_chars", "changed",
                        "input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens"):
                entry[key] = _int_field(obj, key)
            by_day[day].append((local_dt, entry))

    if raw_out is not None:
        raw_out.extend(item for items in by_day.values() for item in items)
    return {day: [e for _, e in sorted(items, key=lambda i: i[0])] for day, items in by_day.items()}


def collect(days: int | None = None, since: date | datetime | str | None = None) -> dict[str, dict]:
    """Costruisce i documenti giornalieri della collezione `agenti` ({'AAAA-MM-GG': documento})."""
    first_day, empty = _first_day(days, since)
    if empty:
        return {}

    first_ts = (
        datetime.combine(first_day, time.min, tzinfo=ROME).timestamp()
        if first_day is not None
        else None
    )

    titles: dict[str, str] = {}
    session_accounts = _load_session_accounts(titles)
    raw: dict = {}
    rows_by_day = _collect_transcripts(first_day, first_ts, session_accounts, raw)
    raw.update(titles=titles, overrides=_load_overrides())
    limits_by_day = _collect_limits(first_day)
    gem_calls: list[tuple[datetime, dict]] = []
    gemini_by_day = _collect_gemini(first_day, gem_calls)
    sessions_by_day = _summarize_sessions(raw, gem_calls) if raw else {}

    all_days = sorted(set(rows_by_day) | set(limits_by_day) | set(gemini_by_day))
    updated = datetime.now(ROME).isoformat(timespec="seconds")

    docs: dict[str, dict] = {}
    for day in all_days:
        rows = rows_by_day.get(day, [])
        limits = limits_by_day.get(day, [])
        gemini = gemini_by_day.get(day, [])
        if not (rows or limits or gemini):
            continue
        docs[day] = {
            "date": day,
            "updated": updated,
            "rows": rows,
            "limits": limits,
            "gemini": gemini,
            "sessions": sessions_by_day.get(day, []),
        }
    return docs


def _first_prompt(session_id: str) -> str:
    """Primo messaggio scritto nella chat (solo per --da-classificare, in locale)."""
    for path in _as_path(PROJECTS_DIR).glob(f"*/{session_id}.jsonl"):
        try:
            with path.open(encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if '"type":"user"' not in line:
                        continue
                    try:
                        content = (json.loads(line).get("message") or {}).get("content")
                    except ValueError:
                        continue
                    text = content if isinstance(content, str) else " ".join(
                        b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")
                    text = " ".join(text.split())
                    if text and not text.startswith("<"):
                        return text[:160]
        except OSError:
            continue
    return ""


def unclassified(days: int | None = 7) -> list[dict]:
    """Chat del periodo senza un progetto della mappa e senza correzione a mano, dalla più cara in token."""
    titles: dict[str, str] = {}
    _load_session_accounts(titles)
    by_id: dict[str, dict] = {}
    for day, doc in collect(days=days).items():
        for x in doc["sessions"]:
            s = by_id.setdefault(x["id"], {"id": x["id"], "days": [], "code": "", "project": "", "fixed": False,
                                           "tokens": 0, "folders": set()})
            s["days"].append(day)
            s["fixed"] = s["fixed"] or bool(x.get("fixed"))
            s["code"] = s["code"] or x["code"]
            s["project"] = x["project"]
            s["tokens"] += sum(u["input"] + u["output"] + u["cache_write"] for u in x["use"])
            s["folders"].update(l["name"] for l in x["lines"])
    out = []
    for s in by_id.values():
        if s["fixed"] or s["code"]:
            continue
        s.update(title=titles.get(s["id"], ""), prompt=_first_prompt(s["id"]), folders=sorted(s["folders"]))
        out.append(s)
    return sorted(out, key=lambda x: -x["tokens"])


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Raccoglie le statistiche giornaliere dei modelli Claude e Gemini."
    )
    parser.add_argument("--giorni", type=int, default=None, help="Limita agli ultimi N giorni (oggi compreso)")
    parser.add_argument("--json", action="store_true", help="Stampa i documenti interi in formato JSON")
    parser.add_argument("--da-classificare", action="store_true",
                        help=f"Elenca le chat senza progetto della mappa (si correggono in {CHAT_PROGETTI.name})")
    args = parser.parse_args(argv)

    if args.da_classificare:
        items = unclassified(args.giorni if args.giorni is not None else 7)
        if not items:
            print("Tutte le chat del periodo hanno un progetto.")
        for x in items:
            print(f"{x['id']}  {x['days'][0]}  {x['tokens']:>10,} token  ora: {x['project']}"
                  + (f"  file in: {', '.join(x['folders'])}" if x['folders'] else ""))
            print(f"    titolo: {x['title'] or '-'}")
            if x["prompt"]:
                print(f"    inizio: {x['prompt']}")
        return

    docs = collect(days=args.giorni)
    if args.json:
        print(json.dumps(docs, ensure_ascii=False, indent=2))
        return

    if not docs:
        print("Nessun dato trovato.")
        return

    for day, doc in docs.items():
        reqs = sum(r["req"] for r in doc["rows"])
        tokens = sum(r["input"] + r["output"] + r["cache_read"] + r["cache_write"] for r in doc["rows"])
        accounts = sorted({r["account"] for r in doc["rows"]} | {l["account"] for l in doc["limits"] if l.get("account")})
        acc_str = ", ".join(accounts) if accounts else "-"
        extra = f" · {len(doc['gemini'])} gemini" if doc["gemini"] else ""
        print(f"{day}  {reqs} req · {tokens:,} token · account: {acc_str}{extra}")


if __name__ == "__main__":
    main()
