#!/usr/bin/env python3
"""Scansiona i progetti sul computer e scrive i fatti in state.json. Solo lettura, nessuna dipendenza."""
import json
import os
import subprocess
import time
from datetime import datetime, timedelta
from pathlib import Path

import jarvis_config

HOME = Path.home()
OUT = jarvis_config.path("state")
_SCAN = jarvis_config.get("scan")

# Cartelle che contengono progetti: ogni sottocartella diretta e' un candidato (config: scan.roots).
ROOTS = [jarvis_config.expand(p) for p in _SCAN["roots"]]
# Progetti singoli fuori da quelle cartelle (scan.singles).
SINGLES = [jarvis_config.expand(p) for p in _SCAN["singles"]]
# Contenitori: si guardano i figli, non il contenitore stesso (scan.containers).
CONTAINERS = {jarvis_config.expand(p) for p in _SCAN["containers"]}
SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env", "target", "build", "dist",
    ".next", ".cache", "third_party", ".idea", ".vscode", ".gradle", ".pio", "site-packages",
}
SKIP_NAMES = set(_SCAN["skip_names"])
NOTE_FILES = ["README.md", "readme.md", "README.txt", "README.rst", "README", "CLAUDE.md", "TODO.md", "ROADMAP.md"]
MAX_FILES = 40000


def git(path, *args):
    try:
        res = subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True, timeout=20)
        return res.stdout.strip() if res.returncode == 0 else ""
    except (subprocess.SubprocessError, OSError):
        return ""


def repos_in(path, depth=3):
    """Repository git dentro path, fino a depth livelli, saltando dipendenze di terzi."""
    found = []
    for root, dirs, _ in os.walk(path):
        level = len(Path(root).relative_to(path).parts)
        if ".git" in dirs:
            found.append(Path(root))
        dirs[:] = [] if level >= depth else [d for d in dirs if d not in SKIP_DIRS]
    return found


def git_facts(repo):
    since = lambda days: (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    count = lambda days: int(git(repo, "rev-list", "--count", "HEAD", f"--since={since(days)}") or 0)
    return {
        "path": str(repo),
        "remote": git(repo, "remote", "get-url", "origin"),
        "branch": git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
        "last_commit": git(repo, "log", "-1", "--format=%cs"),
        "commits_30d": count(30),
        "commits_90d": count(90),
        "dirty_files": len(git(repo, "status", "--porcelain").splitlines()),
        "unpushed": int(git(repo, "rev-list", "--count", "@{u}..HEAD") or 0),
        "recent_subjects": git(repo, "log", "-8", "--format=%cs %s").splitlines(),
    }


def last_touch(path):
    """File modificato piu' di recente, ignorando dipendenze e artefatti."""
    newest, newest_path, seen = 0.0, "", 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in files:
            seen += 1
            if seen > MAX_FILES:
                return newest, newest_path
            full = os.path.join(root, name)
            try:
                mtime = os.lstat(full).st_mtime
            except OSError:
                continue
            if mtime > newest:
                newest, newest_path = mtime, full
    return newest, newest_path


def notes(path):
    out = {}
    for name in NOTE_FILES:
        note = path / name
        if note.is_file():
            try:
                out[name] = note.read_text(errors="replace")[:1500]
            except OSError:
                pass
    return out


def claude_sessions():
    """Attivita' Claude Code per cartella di lavoro, letta dai transcript locali."""
    base = HOME / ".claude" / "projects"
    sessions = {}
    for proj in base.glob("*"):
        logs = sorted(proj.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not logs:
            continue
        prompts = []
        cwd = None
        for log in logs[:6]:
            try:
                with log.open(errors="replace") as fh:
                    for line in fh:
                        try:
                            ev = json.loads(line)
                        except ValueError:
                            continue
                        cwd = cwd or ev.get("cwd")
                        if ev.get("type") != "user" or ev.get("isMeta"):
                            continue
                        content = (ev.get("message") or {}).get("content")
                        if isinstance(content, str) and not content.startswith(("<", "Caveat")):
                            prompts.append(content.strip()[:220])
                            break
            except OSError:
                continue
        if cwd:
            sessions[cwd] = {
                "sessions": len(logs),
                "last": time.strftime("%Y-%m-%d", time.localtime(logs[0].stat().st_mtime)),
                "prompts": prompts,
            }
    return sessions


def candidates():
    out = []
    for root in ROOTS:
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            if child.is_dir() and not child.name.startswith(".") and child not in CONTAINERS and child.name not in SKIP_NAMES:
                out.append(child)
    out += [p for p in SINGLES if p.is_dir()]
    return out


def main():
    sessions = claude_sessions()
    projects = []
    for path in candidates():
        touched, touched_path = last_touch(path)
        repos = [git_facts(r) for r in repos_in(path)]
        related = {
            cwd: info for cwd, info in sessions.items()
            if cwd == str(path) or cwd.startswith(str(path) + os.sep)
        }
        projects.append({
            "name": path.name,
            "path": str(path),
            "last_touch": time.strftime("%Y-%m-%d", time.localtime(touched)) if touched else None,
            "last_touch_file": touched_path.replace(str(path), ".", 1),
            "repos": repos,
            "notes": notes(path),
            "claude": related,
        })
    projects.sort(key=lambda p: p["last_touch"] or "", reverse=True)
    OUT.write_text(json.dumps({"scanned_at": datetime.now().isoformat(timespec="minutes"), "projects": projects}, indent=1, ensure_ascii=False))
    print(f"{len(projects)} progetti scritti in {OUT}\n")
    print_recent(projects)


def print_recent(projects, days=14):
    """Riepilogo breve: cosa e' stato toccato negli ultimi giorni. Non indica priorita'."""
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    print(f"Toccati dal {cutoff}:")
    for p in projects:
        if (p["last_touch"] or "") >= cutoff:
            print(f"  {p['last_touch']}  {p['path'].replace(str(HOME) + '/', '')}")


if __name__ == "__main__":
    main()
