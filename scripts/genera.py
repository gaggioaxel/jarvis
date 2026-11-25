#!/usr/bin/python3
"""Genera i file dell'istanza dalla config privata (~/.config/jarvis/config.json).

  bacheca/static/config.js         valori pubblici per la PWA (finisce su Firebase Hosting)
  bacheca/firestore.rules          da firestore.rules.template, con le mail ammesse
  bacheca/.firebaserc              progetto Firebase
  bacheca/mcp-worker/wrangler.jsonc  da wrangler.template.jsonc, con progetto, URL e ID del KV

I file generati sono esclusi da git: rigenerali dopo ogni modifica della config.
  python3 scripts/genera.py [--controlla]   --controlla: dice solo se i file sono aggiornati
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import jarvis_config  # noqa: E402

REPO = jarvis_config.REPO
BACHECA = REPO / "bacheca"
C = jarvis_config.CONFIG

# Solo queste chiavi vanno nel browser: tutto il resto della config resta sul computer.
PUBLIC = ["owner_name", "allowed_emails", "worker_url", "vapid_public", "areas", "area_rules", "abbonamenti", "contesto_lungo", "prezzi"]


def fill(template, values):
    text = template.read_text()
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    if "{{" in text:
        sys.exit(f"Segnaposto non sostituiti in {template.name}")
    return text


def outputs():
    emails = [e.strip() for e in C["allowed_emails"] if e.strip()]
    if not emails:
        print("Attenzione: allowed_emails è vuoto, nessuno potrà entrare nella bacheca.", file=sys.stderr)
    public = {k: C[k] for k in PUBLIC}
    js = ("// Generato da scripts/genera.py: non modificarlo a mano. Solo valori pubblici.\n"
          f"self.JARVIS = {json.dumps(public, ensure_ascii=False, indent=2)};\n")
    url = C["bacheca_url"].rstrip("/")
    wrangler = fill(BACHECA / "mcp-worker" / "wrangler.template.jsonc", {
        "WORKER_NAME": C["worker_name"],
        "ALLOWED_EMAIL": ",".join(emails),
        "FIREBASE_PROJECT": C["firebase_project"],
        "BACHECA_URL": url,
        "OWNER_NAME": C["owner_name"],
        "TIMEZONE": C["timezone"],
        "KV_NAMESPACE_ID": C["kv_namespace_id"] or "DA-CREARE-CON-wrangler-kv-namespace-create",
    })
    rules = fill(BACHECA / "firestore.rules.template", {"ALLOWED_EMAILS": json.dumps(emails).replace('"', "'")})
    rc = json.dumps({"projects": {"default": C["firebase_project"]}}) + "\n"
    return {
        BACHECA / "static" / "config.js": js,
        BACHECA / "firestore.rules": rules,
        BACHECA / ".firebaserc": rc,
        BACHECA / "mcp-worker" / "wrangler.jsonc": wrangler,
    }


def main():
    check = "--controlla" in sys.argv
    if not jarvis_config.CONFIG_FILE.exists():
        print(f"Config assente ({jarvis_config.CONFIG_FILE}): uso i valori predefiniti. "
              "Parti da config.example.json.", file=sys.stderr)
    stale = []
    for path, text in outputs().items():
        old = path.read_text() if path.exists() else None
        if old == text:
            continue
        stale.append(path.relative_to(REPO))
        if not check:
            path.write_text(text)
    verb = "Da rigenerare" if check else "Scritti"
    print(f"{verb}: " + ", ".join(map(str, stale)) if stale else "Tutto aggiornato.")
    sys.exit(1 if check and stale else 0)


if __name__ == "__main__":
    main()
