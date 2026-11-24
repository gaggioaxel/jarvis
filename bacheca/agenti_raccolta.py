#!/usr/bin/python3
"""Raccolta giornaliera dell'uso dei modelli (Claude e Gemini) per la vista Agenti.

Solo libreria standard. Costruisce i documenti della collezione Firestore `agenti`
secondo il contratto: uno per giorno (id "AAAA-MM-GG" in ora locale, fuso "timezone" della config).
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import math
import os
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


def _load_session_accounts() -> dict[str, str]:
    """Mappa cliSessionId -> etichetta account leggendo solo `cliSessionId` dai file di sessione."""
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
    return mapping


def _project_name(cwd: object) -> str:
    if not isinstance(cwd, str) or not cwd:
        return ""
    if "/scratch-workspaces/" in cwd or cwd.rstrip("/").endswith("/scratch-workspaces"):
        return "scratch"
    return PurePosixPath(cwd).name


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
) -> dict[str, list[dict]]:
    """Legge le trascrizioni Claude Code e aggrega per (giorno, h, account, model, project, agent)."""
    root = _as_path(PROJECTS_DIR)
    if not root.is_dir():
        return {}

    # Deduplica per (sessionId, requestId) mantenendo l'ultima occorrenza incontrata.
    dedup: dict[tuple, tuple[str, int, str, str, str, str, int, int, int, int, int, int]] = {}

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

        try:
            fh = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            continue

        with fh:
            for line_no, line in enumerate(fh, 1):
                # Le righe senza "assistant" (la gran parte: messaggi, risultati degli strumenti,
                # allegati) si scartano senza decodificarle.
                if '"assistant"' not in line or '"usage"' not in line:
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(obj, dict) or obj.get("type") != "assistant":
                    continue
                msg = obj.get("message")
                if not isinstance(msg, dict):
                    continue
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

                session_id = obj.get("sessionId")
                if not isinstance(session_id, str) or not session_id:
                    session_id = fallback_session

                req_id = obj.get("requestId")
                msg_id = msg.get("id")
                if isinstance(req_id, str) and req_id:
                    dedup_key: tuple = (session_id, req_id)
                elif isinstance(msg_id, str) and msg_id:
                    dedup_key = (session_id, "msg", msg_id)
                else:
                    dedup_key = ("_noid", str(path), line_no)

                account = session_accounts.get(session_id, "CLI")
                project = _project_name(obj.get("cwd"))

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
    return dict(by_day)


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


def _collect_gemini(first_day: date | None) -> dict[str, list[dict]]:
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

    session_accounts = _load_session_accounts()
    rows_by_day = _collect_transcripts(first_day, first_ts, session_accounts)
    limits_by_day = _collect_limits(first_day)
    gemini_by_day = _collect_gemini(first_day)

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
        }
    return docs


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Raccoglie le statistiche giornaliere dei modelli Claude e Gemini."
    )
    parser.add_argument("--giorni", type=int, default=None, help="Limita agli ultimi N giorni (oggi compreso)")
    parser.add_argument("--json", action="store_true", help="Stampa i documenti interi in formato JSON")
    args = parser.parse_args(argv)

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
