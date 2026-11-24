#!/usr/bin/python3
"""Rielabora una giornata: unisce tracker e sessioni Claude in diario/AAAA-MM-GG.md e storico.csv.

La giornata AAAA-MM-GG va dalle 4 del mattino di quel giorno alle 4 del giorno dopo."""
import argparse
import csv
import json
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import jarvis_config

HOME = Path.home()
HERE = Path(__file__).resolve().parent
TRACKER = jarvis_config.path("tracker_dir")
TRANSCRIPTS = jarvis_config.path("transcripts_dir")
DIARY = jarvis_config.path("diario_dir")
HISTORY = jarvis_config.path("storico")
FIELDS = ["data", "codice", "progetto", "area", "focus_min", "agente_min", "file_tu", "file_agente"]
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit"}
GAP = 180
BUCKET = 300
UNKNOWN = {"codice": "?", "nome": "Non classificato", "area": "Altro"}
CLAUDE_CHAT = "O"
DAY_START = 4  # la giornata va dalle 4 del mattino alle 4 del giorno dopo: a mezzanotte si puo' essere ancora al lavoro


def window(day):
    start = datetime.combine(day, datetime.min.time()) + timedelta(hours=DAY_START)
    return start, start + timedelta(days=1)


def current_day():
    return (datetime.now() - timedelta(hours=DAY_START)).date()


def is_desktop(event):
    """La scrivania vuota, senza finestre aperte: non conta come tempo al computer."""
    return event.get("app") == "gjs" and (event.get("titolo") or "").startswith("Desktop Icons")


def is_browser(app):
    return any(name in (app or "").lower() for name in ("brave", "firefox", "chrom"))


class Mapper:
    def __init__(self):
        entries = json.loads(jarvis_config.path("mappa").read_text())
        self.codes = {e["codice"]: e for e in entries}
        self.paths = sorted(
            ((str(HOME / p), e) for e in entries for p in e["percorsi"]), key=lambda x: len(x[0]), reverse=True
        )
        self.words = sorted(((w, e) for e in entries for w in e["parole"]), key=lambda x: len(x[0]), reverse=True)

    def by_path(self, path):
        for prefix, entry in self.paths:
            if path == prefix or path.startswith(prefix + "/"):
                return entry
        return UNKNOWN

    def by_title(self, title):
        low = (title or "").lower()
        for word, entry in self.words:
            if word in low:
                return entry
        return UNKNOWN


def tracker_events(day):
    """Eventi dei due file di calendario che la giornata tocca; il taglio alle 4 lo fa analyze."""
    events = []
    for log in (TRACKER / f"{day}.jsonl", TRACKER / f"{day + timedelta(days=1)}.jsonl"):
        if not log.exists():
            continue
        for line in log.read_text(errors="replace").splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            event["t"] = datetime.fromisoformat(event["t"])
            events.append(event)
    return events


def clip(spans, start, stop):
    """Tiene solo la parte degli intervalli dentro la giornata."""
    kept = []
    for span in spans:
        begin, end = max(span["start"], start), min(span["end"], stop)
        if end > begin:
            kept.append({**span, "start": begin, "end": end})
    return kept


def focus_spans(events):
    """Intervalli di finestra attiva, chiusi da assenza, finestra privata, scrivania vuota, sospensione o fine dei dati."""
    spans, current, last_seen = [], None, None

    def close(end):
        nonlocal current
        if current:
            current["end"] = end
            if end > current["start"]:
                spans.append(current)
            current = None

    for event in events:
        if last_seen and (event["t"] - last_seen).total_seconds() > GAP:
            close(last_seen)
        last_seen = event["t"]
        if (event["k"] == "assente" and event["on"]) or event["k"] == "privato":
            close(event["t"])
        elif event["k"] == "focus":
            close(event["t"])
            if is_desktop(event):
                continue
            current = {
                "start": event["t"],
                "app": event.get("app") or "",
                "titolo": event.get("titolo") or "",
                "cartella": event.get("cartella"),
            }
    close(last_seen)
    return spans


def agent_activity(day, mapper):
    """Azioni degli agenti Claude nel giorno, lette dai transcript locali."""
    start, stop = window(day)
    actions = []
    for log in TRANSCRIPTS.glob("*/*.jsonl"):
        modified = datetime.fromtimestamp(log.stat().st_mtime)
        if modified < start:
            continue
        with log.open(errors="replace") as fh:
            for line in fh:
                if '"tool_use"' not in line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                stamp = event.get("timestamp")
                content = (event.get("message") or {}).get("content")
                if not stamp or not isinstance(content, list):
                    continue
                when = datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
                if not start <= when < stop:
                    continue
                for block in content:
                    if block.get("type") != "tool_use":
                        continue
                    path = (block.get("input") or {}).get("file_path") if block.get("name") in EDIT_TOOLS else None
                    entry = mapper.by_path(path) if path else UNKNOWN
                    if entry is UNKNOWN:
                        entry = mapper.by_path(event.get("cwd") or "")
                    actions.append({"t": when, "path": path if entry is not UNKNOWN else None, "entry": entry})
    return sorted(actions, key=lambda a: a["t"])


def minute(moment):
    return moment.replace(second=0, microsecond=0)


def corrections(mapper):
    """Fasce orarie da riattribuire, scritte a mano in correzioni.json: tutto quello che nella fascia cade
    nell'area indicata passa al codice indicato."""
    path = jarvis_config.path("correzioni")
    if not path.exists():
        return []
    return [(datetime.fromisoformat(c["dal"]), datetime.fromisoformat(c["al"]), c["area"], mapper.codes[c["codice"]])
            for c in json.loads(path.read_text())]


def corrected(entry, moment, rules):
    plain = moment.replace(tzinfo=None)
    for start, stop, area, target in rules:
        if start <= plain < stop and entry["area"] == area:
            return target
    return entry


def analyze(day, mapper):
    start, stop = window(day)
    events = tracker_events(day)
    plain = lambda e: e["t"].replace(tzinfo=None)
    spans = clip(focus_spans(events), start.replace(tzinfo=events[0]["t"].tzinfo), stop.replace(tzinfo=events[0]["t"].tzinfo)) if events else []
    events = [e for e in events if start <= plain(e) < stop]
    actions = agent_activity(day, mapper)
    rules = corrections(mapper)
    for action in actions:
        action["entry"] = corrected(action["entry"], action["t"], rules)
    agent_minutes = defaultdict(set)
    agent_files = defaultdict(set)
    for action in actions:
        agent_minutes[action["entry"]["codice"]].add(minute(action["t"]))
        if action["path"]:
            agent_files[action["path"]].add(minute(action["t"]))

    def nearest_agent(moment):
        window = [a for a in actions if abs((a["t"] - moment).total_seconds()) <= GAP]
        return min(window, key=lambda a: abs((a["t"] - moment).total_seconds()))["entry"] if window else UNKNOWN

    rows = defaultdict(lambda: {"focus": 0.0, "agent": 0, "yours": set(), "theirs": set(), "entry": UNKNOWN})
    apps = Counter()
    for span in spans:
        # Nel browser la cartella e' un falso positivo: il titolo di una scheda (WhatsApp, Inbox) puo' coincidere
        # con il nome di una cartella qualsiasi. Li' conta solo il titolo.
        entry = mapper.by_path(span["cartella"]) if span["cartella"] and not is_browser(span["app"]) else UNKNOWN
        if entry is UNKNOWN:
            entry = mapper.by_title(span["titolo"])
        if entry is UNKNOWN and "claude" in span["app"].lower():
            entry = nearest_agent(span["start"])
            if entry is UNKNOWN:
                # L'app Claude senza una sessione di codice vicina e' chat, non lavoro su un progetto.
                entry = mapper.codes.get(CLAUDE_CHAT, UNKNOWN)
        entry = corrected(entry, span["start"], rules)
        span["entry"] = entry
        seconds = (span["end"] - span["start"]).total_seconds()
        rows[entry["codice"]]["focus"] += seconds / 60
        rows[entry["codice"]]["entry"] = entry
        apps[span["app"] or "?"] += seconds / 60
    for code, minutes in agent_minutes.items():
        rows[code]["agent"] = len(minutes)
    for action in actions:
        rows[action["entry"]["codice"]]["entry"] = action["entry"]

    for event in events:
        if event["k"] != "file":
            continue
        entry = mapper.by_path(event["p"])
        code = entry["codice"]
        rows[code]["entry"] = entry
        moment = minute(event["t"])
        near = {moment + timedelta(minutes=m) for m in (-1, 0, 1)}
        by_agent = agent_files[event["p"]] & near or agent_minutes[code] & near
        rows[code]["theirs" if by_agent else "yours"].add(event["p"])
    for path in agent_files:
        entry = mapper.by_path(path)
        rows[entry["codice"]]["theirs"].add(path)
        rows[entry["codice"]]["entry"] = entry
    return {"spans": spans, "rows": rows, "apps": apps, "agent_files": agent_files, "events": events, "actions": actions}


def timeline(spans):
    """Progetto prevalente ogni 5 minuti, con i blocchi uguali uniti."""
    buckets = defaultdict(Counter)
    for span in spans:
        moment = span["start"]
        while moment < span["end"]:
            slot = moment.timestamp() // BUCKET * BUCKET
            step = min(span["end"].timestamp(), slot + BUCKET) - moment.timestamp()
            buckets[slot][span["entry"]["nome"]] += step
            moment = datetime.fromtimestamp(slot + BUCKET)
    blocks = []
    for slot in sorted(buckets):
        name = buckets[slot].most_common(1)[0][0]
        if blocks and blocks[-1][2] == name and blocks[-1][1] == slot:
            blocks[-1][1] = slot + BUCKET
        else:
            blocks.append([slot, slot + BUCKET, name])
    return blocks


def slot(moment):
    """Posizione dell'ora nella giornata: 0 sono le 4 del mattino, 23 le 3 del giorno dopo."""
    return (moment.hour - DAY_START) % 24


def hourly(spans, actions):
    """Minuti di focus per ora e per progetto, e minuti degli agenti per ora."""
    focus = defaultdict(Counter)
    for span in spans:
        moment = span["start"]
        while moment < span["end"]:
            stop = min(span["end"], moment.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1))
            focus[slot(moment)][span["entry"]["nome"]] += (stop - moment).total_seconds() / 60
            moment = stop
    agents = defaultdict(set)
    for action in actions:
        agents[slot(action["t"])].add(minute(action["t"]))
    return focus, {hour: len(mins) for hour, mins in agents.items()}


def bar(minutes):
    """Un blocco ogni 5 minuti: un'ora piena vale 12 blocchi."""
    return ("█" * round(minutes / 5)).ljust(12)


def chart(spans, actions):
    focus, agents = hourly(spans, actions)
    busy = sorted(set(focus) | set(agents))
    if not busy:
        return []
    lines = ["", "## Ore", "", "```", "ora  focus              agenti             progetti"]
    for hour in range(busy[0], busy[-1] + 1):
        mins = sum(focus[hour].values())
        names = ", ".join(f"{name} {m:.0f}m" for name, m in focus[hour].most_common(2) if m >= 5)
        lines.append(f"{(hour + DAY_START) % 24:02d}   {bar(mins)} {mins:3.0f}m   {bar(agents.get(hour, 0))} {agents.get(hour, 0):3d}m   {names}")
    return lines + ["```"]


def clock(minutes):
    return f"{int(minutes // 60)}h {int(minutes % 60):02d}m"


def render(day, data):
    rows, spans = data["rows"], data["spans"]
    total = sum(r["focus"] for r in rows.values())
    switches = sum(
        1 for a, b in zip(spans, spans[1:]) if a["entry"]["codice"] != b["entry"]["codice"]
    )
    lines = [f"# Giornata del {day}", ""]
    if data["events"]:
        lines.append(f"Davanti al computer {clock(total)}, {switches} cambi di progetto.")
    else:
        lines.append("Tracker non attivo: contano solo le sessioni degli agenti.")
    lines += ["", "| Progetto | Area | Focus | Agenti | File tuoi | File agenti |", "|---|---|---|---|---|---|"]
    ordered = sorted(rows.values(), key=lambda r: r["focus"] + r["agent"], reverse=True)
    for row in ordered:
        entry = row["entry"]
        lines.append(
            f"| {entry['codice']} {entry['nome']} | {entry['area']} | {clock(row['focus'])} | "
            f"{clock(row['agent'])} | {len(row['yours'])} | {len(row['theirs'])} |"
        )
    blocks = timeline(spans)
    if blocks:
        lines += ["", "## Linea del tempo", ""]
        for start, end, name in blocks:
            lines.append(f"- {datetime.fromtimestamp(start):%H:%M}-{datetime.fromtimestamp(end):%H:%M} {name}")
    lines += chart(spans, data["actions"])
    if data["apps"]:
        lines += ["", "## Applicazioni", ""]
        lines += [f"- {app}: {clock(m)}" for app, m in data["apps"].most_common(8)]
    if data["agent_files"]:
        lines += ["", "## File più lavorati dagli agenti", ""]
        busiest = sorted(data["agent_files"].items(), key=lambda kv: len(kv[1]), reverse=True)[:12]
        lines += [f"- {path.replace(str(HOME) + '/', '')}: {len(mins)} min" for path, mins in busiest]
    return "\n".join(lines) + "\n"


def update_history(day, rows):
    kept = []
    if HISTORY.exists():
        with HISTORY.open() as fh:
            kept = [r for r in csv.DictReader(fh) if r["data"] != str(day)]
    for row in rows.values():
        entry = row["entry"]
        kept.append({
            "data": str(day), "codice": entry["codice"], "progetto": entry["nome"], "area": entry["area"],
            "focus_min": round(row["focus"]), "agente_min": row["agent"],
            "file_tu": len(row["yours"]), "file_agente": len(row["theirs"]),
        })
    kept.sort(key=lambda r: (r["data"], r["codice"]))
    with HISTORY.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, FIELDS)
        writer.writeheader()
        writer.writerows(kept)


def complete(day):
    """Un diario scritto prima che la sua giornata finisca, alle 4 del giorno dopo, e' parziale."""
    diary = DIARY / f"{day}.md"
    return diary.exists() and datetime.fromtimestamp(diary.stat().st_mtime) >= window(day)[1]


def process(day, mapper):
    data = analyze(day, mapper)
    if not data["rows"]:
        return False
    DIARY.mkdir(exist_ok=True)
    (DIARY / f"{day}.md").write_text(render(day, data))
    update_history(day, data["rows"])
    print(f"{DIARY / f'{day}.md'}")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("giorno", nargs="?", help="AAAA-MM-GG, predefinito oggi")
    parser.add_argument("--arretrati", action="store_true", help="rielabora gli ultimi 7 giorni senza diario completo")
    args = parser.parse_args()
    mapper = Mapper()
    if args.arretrati:
        today = current_day()
        for back in range(7, 0, -1):
            day = today - timedelta(days=back)
            if not complete(day):
                process(day, mapper)
    else:
        process(date.fromisoformat(args.giorno) if args.giorno else current_day(), mapper)


if __name__ == "__main__":
    main()
