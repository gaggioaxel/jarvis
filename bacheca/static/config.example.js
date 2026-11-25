// Esempio di static/config.js: il vero lo genera scripts/genera.py da ~/.config/jarvis/config.json.
// Finisce su Firebase Hosting ed è leggibile da chiunque: solo valori pubblici, mai segreti.
self.JARVIS = {
  "owner_name": "Utente",
  "allowed_emails": ["tu@example.com"],
  "worker_url": "https://jarvis-bacheca-mcp.tuo-sottodominio.workers.dev",
  "vapid_public": "",
  "areas": [
    { "id": "lavoro", "name": "Lavoro", "color": "blue" },
    { "id": "studio", "name": "Studio", "color": "purple" },
    { "id": "side", "name": "Side project", "color": "pink" }
  ],
  "area_rules": [],
  "abbonamenti": {},
  "contesto_lungo": 300000,
  "prezzi": {
    "claude-opus-5-5": { "in": 4, "out": 20, "cr": 0.2 },
    "claude-sonnet-5-5": { "in": 2, "out": 10, "cr": 0.1 },
    "claude-haiku-5-5": { "in": 0.1, "out": 0.5, "cr": 0.01 },
    "claude-fable-5-2": { "in": 8, "out": 40, "cr": 0.2 },
    "hydrogen": { "in": 1.5, "out": 7.5, "cr": 0.15 },
    "neon": { "in": 3, "out": 15, "cr": 0.15 },
    "flash": { "in": 0.75, "out": 3.75, "cr": 0.075 }
  }
};
