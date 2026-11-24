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
  "abbonamenti": {}
};
