# Jarvis

Assistente personale costruito attorno a Claude: una bacheca stile Trello installabile come app, con notifiche delle scadenze, un connettore MCP per far lavorare Claude sulla bacheca da Claude Code e da claude.ai, statistiche del tempo e dell'uso dei modelli, e qualche script locale.

- **`bacheca/`**: la bacheca. PWA su Firebase Hosting + Firestore (`static/`), accesso di Claude con un account di servizio (`jb.py`), server MCP locale (`mcp_server.py`), Worker Cloudflare per il connettore MCP remoto e le notifiche push (`mcp-worker/`), raccolta delle statistiche dei modelli (`agenti_raccolta.py`: token e costo per modello, e per ogni chat il progetto di `mappa.json`, le righe di codice e documentazione cambiate e i commit). I prezzi per modello stanno nella chiave `prezzi` di `config.json`. Dettagli in [`bacheca/LEGGIMI.md`](bacheca/LEGGIMI.md).
- **`giornata.py`**: unisce un tracker delle finestre e le sessioni di Claude Code in un diario giornaliero e in `storico.csv` (minuti per progetto), che `jb.py ore` carica nella vista Tempo. Progetti e correzioni da `mappa.json` e `correzioni.json` (esempi in `esempi/`). Quando la finestra attiva è il browser, legge la cronologia di Brave (una copia, mai l'originale) e assegna i minuti a un tipo di lavoro (posta, codice, documenti, ricerca…) per dominio: sezione "Browser per tipo di lavoro" del diario e `storico_browser.csv`. Le categorie si cambiano nella chiave `browser.categorie` di `config.json`.
- **`scan.py`**: scansiona le cartelle dei progetti e scrive i fatti (git, note, file recenti) in `state.json`.

Testi e interfaccia sono in italiano. Solo libreria standard di Python; il Worker è TypeScript.

## Configurazione

Niente nel repository è legato a un'istanza: chiavi, ID e dati personali stanno fuori.

1. Crea un progetto Firebase (Hosting, Authentication con Google, Firestore) e un account di servizio con accesso a Firestore; salva la chiave in `~/.config/jarvis/bacheca-sa.json`.
2. Copia `config.example.json` in `~/.config/jarvis/config.json` (`chmod 600`) e compilalo: nome, mail ammesse, progetto Firebase, Worker, ambiti, fuso, cartelle.
3. Genera i file dell'istanza (`static/config.js`, `firestore.rules`, `.firebaserc`, `mcp-worker/wrangler.jsonc`, tutti esclusi da git):
   ```bash
   python3 scripts/genera.py
   ```
4. Pubblica: `scripts/deploy.sh hosting` e, per connettore e notifiche, `scripts/deploy.sh worker` (prima i secret `BACHECA_SA` e `VAPID_KEY`, vedi `bacheca/LEGGIMI.md`).

Per provare tutto in locale con gli emulatori di Firebase: `bacheca/LEGGIMI.md`, sezione "Provare in locale".

## Licenza

MIT, vedi [`LICENSE`](LICENSE).
