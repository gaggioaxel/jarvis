# Bacheca di Jarvis

Trello a bacheca unica: "Questa settimana", un divisorio, poi una colonna per ambito. Ogni colonna di ambito ha sotto il suo archivio.

In "Questa settimana" non si creano schede (22 novembre): si creano in un ambito e poi ci si trascinano. Vale per l'app (la colonna non ha "Aggiungi una scheda" e `store.js` rifiuta), `jb.py nuova`, il server MCP locale e il Worker (`nuova_scheda`).

Gira su Firebase (Hosting + Auth + Firestore) con il piano gratuito Spark, senza fatturazione, più un Worker Cloudflare gratuito per il connettore MCP remoto e le notifiche.

## Configurazione

Tutti i valori dell'istanza stanno in un solo file privato, `~/.config/jarvis/config.json` (mai nel repository): si parte da `config.example.json` nella radice. Lo leggono gli script Python (`jarvis_config.py`) e `scripts/genera.py`, che da lì genera i file esclusi da git:

- `static/config.js`: solo i valori pubblici per la pagina (nome, mail ammesse, indirizzo del Worker, chiave pubblica VAPID, ambiti, canoni e prezzi per modello della vista Agenti). Finisce su Hosting, quindi mai segreti.
- `firestore.rules` (da `firestore.rules.template`), `.firebaserc`, `mcp-worker/wrangler.jsonc` (da `wrangler.template.jsonc`).

```bash
cp config.example.json ~/.config/jarvis/config.json && chmod 600 ~/.config/jarvis/config.json   # poi compilalo
python3 scripts/genera.py          # da rifare dopo ogni modifica della config
scripts/deploy.sh prova            # tsc e wrangler deploy --dry-run
scripts/deploy.sh hosting          # firebase deploy di pagina e regole
scripts/deploy.sh worker           # wrangler deploy
```

File privati fuori dal repository: la config, la chiave dell'account di servizio (`~/.config/jarvis/bacheca-sa.json`, o `service_account` nella config), la coppia VAPID (`~/.config/jarvis/vapid.json`) e la cartella dei dati locali (`data_dir`, predefinita `bacheca/dati/`: token, backup, segni di lettura).

- `static/`: la pagina. `store.js` contiene tutte le operazioni sulla bacheca e scrive su Firestore; `app.js` è l'interfaccia.

## Offline e app sul telefono

La bacheca è una PWA: su iPhone si installa da Safari con Condividi → Aggiungi alla schermata Home (le app nella Home non perdono i dati dopo 7 giorni, come i siti in Safari).

- **Dati:** Firestore usa la cache persistente (IndexedDB). Offline la bacheca si apre e si modifica; le modifiche restano in coda anche chiudendo l'app e partono da sole al ritorno della rete. `commit()` non aspetta il server.
- **Pagina:** `sw.js` tiene in cache pagina, script e libreria Firebase (prima la rete con 3 secondi di attesa, poi la cache). Cambiando la versione della libreria Firebase va aggiornato `FIREBASE` in `sw.js`; per forzare il ricaricamento di tutto si cambia `CACHE`.
- **Conflitti:** si scrivono solo i campi cambiati di una scheda (`update`, non `set`), così una modifica fatta offline non cancella quello che Claude ha scritto intanto in altri campi. Sullo stesso campo vince l'ultimo che scrive.
- **Commenti e checklist per id (17 novembre):** su Firestore `comments`, `checklists` e gli `items` di ogni checklist sono mappe id → elemento, non elenchi. L'app scrive solo i percorsi toccati (`comments.<id>`, `checklists.<id>.items.<id>.done`, ...), quindi una modifica fatta offline con la vista vecchia si somma a quelle arrivate intanto; si scontrano solo due modifiche allo stesso campo dello stesso elemento. Ordine: commenti per `created`, checklist e voci per `pos` (scritto solo su Firestore, l'app e `jb.py` vedono elenchi). App, `jb.py` e worker leggono e scrivono solo questo formato: tutte le schede sono state convertite il 17 novembre.
- **Annulla:** ogni modifica fatta dall'app si annulla per un'ora, dalla più recente, con il pulsante in alto o Ctrl+Z / Cmd+Z (fuori dai campi di testo, o in un campo non ancora toccato). Rimette i valori di prima solo nei campi non cambiati da allora; colonne ed etichette si annullano una per una (22 novembre), quindi una modifica fatta intanto a un'altra colonna non blocca l'annulla, e una colonna nuova si toglie solo se è ancora vuota. Vive in memoria: ricaricando la pagina si azzera. Eliminare una scheda con file allegati azzera l'elenco.
- **Allegati:** si caricano solo online; offline si vedono quelli già aperti. Le cancellazioni fatte offline restano in coda in `localStorage` (`allegati-da-togliere`).
- In alto compare "Offline · N da sincronizzare", e al ritorno della rete "Modifiche sincronizzate".
- Installata nella Home, l'accesso con Google passa dalla pagina intera invece che dal popup.
- `firestore.rules` (generato): entrano solo le mail di `allowed_emails`.
- `jb.py`: accesso di Claude con l'account di servizio (chiave in `~/.config/jarvis/bacheca-sa.json`). Il token di Google si salva in `<data_dir>/token.json` (solo per te, permessi 600) con l'ora della richiesta: vale un'ora e si rinnova dopo 50 minuti. `jb.py token` dice quanto gli resta; si può richiedere all'avvio delle sessioni con un hook di Claude Code.
- I backup di `jb.py backup` finiscono in `<data_dir>/backup/`; `jb.py importa` carica una bacheca esportata.

## Priorità

Ogni scheda può avere una priorità a 5 livelli nel campo `priority` (15 novembre): 1 Critica, 2 Alta, 3 Media, 4 Bassa, 5 Minima; 0 o assente vuol dire nessuna. Colori a scala di pericolo: rosso, arancio, giallo, verde, grigio. L'urgenza sta nella priorità: il 17 novembre l'etichetta Urgente è stata tolta e le sue schede sono passate a P1 (`jb.py modifica-etichetta urgente '{"elimina":true,"priorita":1}'`). Nel buongiorno Claude propone di alzare o abbassare le priorità in base alle scadenze vicine, e le cambia solo se approvate. Dal clic destro su una scheda: priorità, allegato, archivia, elimina. Sulla scheda in colonna è la pillola in alto a destra, di fronte alle etichette, solo per P1–P3 (dal 22 novembre: P4 e P5 sono quasi tutte e non distinguono niente); nella scheda aperta sta accanto a Scadenza e si cambia dal pulsante Priorità. `jb.py colonna` la mostra dopo il titolo.

**Ordinamento automatico (18 novembre):** ogni volta che cambia la priorità di una scheda, la sua colonna si riordina dall'alto: P1…P5, poi le schede senza priorità; a parità resta l'ordine di prima, quindi trascinando si decide l'ordine dentro lo stesso livello. Vale dall'app (`Board.sortByPriority` in `store.js`, si annulla con Ctrl+Z), da `jb.py modifica`/`modifica-etichetta` e dal server MCP locale (`sort_by_priority`), e dal Worker (`Store.sortByPriority`). Claude scrive solo il campo `pos` delle schede che cambiano posto, in un commit. A mano (trascinando, o con `colonna`/`posizione`/`ambito`/`archiviata` da Claude) una scheda si sposta solo tra quelle della stessa priorità: durante il trascinamento lo spazio si ferma ai bordi del gruppo, e dopo ogni spostamento la colonna si riordina, così una scheda lasciata fuori dal suo gruppo torna al bordo più vicino.

## Sottovoci delle checklist

Dal 19 novembre una voce di checklist può avere delle sotto-voci, fino a 3 livelli. Sulla voce c'è il campo `parent`, con l'id di un'altra voce della stessa checklist. L'elenco delle voci resta piatto, in ordine di `pos`, e l'albero si legge da `parent`. Le versioni vecchie dell'app le mostrano tutte allo stesso livello.

- **Regole** (uguali in `store.js`, `jb.py` e Worker): spuntare una voce spunta anche le sue sotto-voci; una voce con sotto-voci risulta fatta quando lo sono tutte; eliminarla elimina anche le sotto-voci (dall'app chiede conferma, e si annulla con Ctrl+Z); spostarla in un'altra checklist porta con sé le sotto-voci. L'avanzamento (barra e badge sulla scheda, `jb.py colonna`) conta solo le voci senza sotto-voci.
- **App:** ogni voce ha un solo ⋯ (dal 22 novembre) con Scadenza, "Aggiungi sottovoce", "Metti sotto la voce sopra" (la rientra), "Sposta fuori di un livello" (la riporta su) ed Elimina; la scadenza, se c'è, resta visibile sulla voce. Incollando un elenco rientrato (due spazi o un tab per livello, con o senza `-` e `[ ]`) le sotto-voci si creano da sole.
- **Claude:** `jb.py voce <scheda> "testo" --sotto <voce>`, `jb.py modifica-voce <scheda> <voce> '{"padre":"<voce>"}'` (vuoto la porta al primo livello). Nei server MCP: `sotto` in `aggiungi_voce`, `padre` in `modifica_voce`.

## Scheda aperta (20 novembre)

- **Aggiungi** (sotto il titolo, accanto a scadenza e priorità, dal 22 novembre) mostra solo quello che la scheda non ha ancora: etichette, scadenza, priorità, checklist. Quando c'è, si cambia da dove è mostrato (le etichette con il +, scadenza e priorità dal loro riquadro sotto il titolo); senza niente da aggiungere il gruppo sparisce. Una seconda checklist la aggiunge Claude (`nuova_checklist`).
- **Azioni** (22 novembre): Questa settimana / Togli dalla settimana e Archivia (Ripristina ed Elimina se archiviata) stanno in alto a destra, separate dalla X da uno spazio largo e una linea, perché chiudendo non si premano per sbaglio. La colonna laterale non c'è più.
- **Descrizione lunga** chiusa fino a "Mostra tutto", anche sul computer (22 novembre); il pulsante compare solo se il testo supera davvero la parte chiusa.
- **Barra in alto** (22 novembre): il filtro per etichette sta nel pulsante Etichette (spunte = filtro, si accende con il numero delle etichette scelte); Esci e Ricarica stanno nel menu del logo. Sulle schede in colonna non c'è più l'icona della descrizione.
- **Riquadri sopra la scheda aperta (23 novembre):** la scheda si ridisegna dopo ogni modifica; un riquadro aperto (come Etichette) che perde il suo pulsante si riaggancia al nuovo con lo stesso `data-a` (`placePop`), invece di finire in alto a sinistra.
- **Allegati:** zona fissa in fondo alla scheda (dopo i commenti; sul computer in fondo alla colonna di sinistra). Si clicca per scegliere i file o ci si trascinano sopra; trascinarli in qualsiasi punto della scheda e incollare un'immagine funzionano ancora.
- Tolti i pulsanti **Link** e **Colore**. I link già allegati restano tra gli allegati. Il colore delle schede non c'è più: niente copertina, e `colore` non si accetta più in `jb.py modifica`, nei server MCP e nell'app (le colonne e le etichette il colore lo tengono).

## Notifiche delle scadenze

Dal 20 novembre ogni scadenza, di una scheda o di una voce, può avere delle notifiche, come gli avvisi di Google Calendar.

- **Dove si impostano:** nel menu della scadenza (clic sulla scadenza nella scheda aperta, o sull'orologio di una voce): sotto data e ora c'è **Notifiche**, con l'elenco (✕ per toglierne una), "Aggiungi notifica…" con le scelte comuni e "Personalizza…" (numero, minuti/ore/giorni/settimane, e per giorni e settimane l'ora). Sulla scheda e sulla voce una campanella dice che ce ne sono.
- **Campanella in alto:** attiva o disattiva le notifiche su questo dispositivo, manda una prova, e imposta le **predefinite** (schede: 1 giorno prima alle 9; voci: il giorno stesso alle 9) che prende ogni nuova scadenza. Le scadenze già impostate prima del 20 novembre non ne hanno finché non si aprono e salvano.
- **Codici** (campo `reminders` su schede e voci, uguali in app, `jb.py` e Worker): `10m`, `1h`, `1g`, `1s` = minuti, ore, giorni, settimane prima della scadenza; `0g@09:00`, `1g@18:00` = il giorno stesso / il giorno prima a quell'ora. Le scadenze senza ora valgono come alle 9:00, nel fuso `timezone` della config. Una scadenza nuova senza avvisi espliciti prende le predefinite (`bacheca/stato.avvisi = {schede, voci}`); togliendo la scadenza si tolgono gli avvisi. Schede e voci fatte o archiviate non avvisano.
- **Testo (23 novembre):** sopra il sistema mostra il nome dell'app, **Jarvis** (`short_name` del manifest e `apple-mobile-web-app-title`; su iPhone vale il nome scelto all'installazione, quindi va reinstallata per vederlo cambiare). Titolo (in grassetto) = "colonna · scheda", con la colonna = l'ambito anche quando la scheda è in Questa settimana: "Studio · S2 Esame". Sotto, cosa scade: "Scheda in scadenza oggi alle 15:00", o per una voce "Ripassare il capitolo 4 · domani". `message()` in `mcp-worker/src/avvisi.ts`.
- **Notifica personalizzata (23 novembre):** compilata in "Personalizza…" e non ancora aggiunta, si aggiunge da sola premendo Salva. Una notifica la cui ora è già passata (per esempio "il giorno stesso alle 7:00" alle 8) si può tenere: è rossa con "· passata" e non arriverà.
- **Recapito:** Web Push standard (VAPID), senza Firebase Cloud Messaging (l'account di servizio non ha quel permesso, e non serve). `dispositivi/{id}` tiene l'iscrizione di ogni dispositivo; `sw.js` mostra la notifica e al tocco apre la scheda. Su iPhone e iPad funziona solo con la bacheca installata nella Home (iOS 16.4+): la campanella lo spiega.
- **Chi le manda:** il Worker (`mcp-worker/src/avvisi.ts`) ogni minuto con un Cron Trigger. Legge solo `avvisi/agenda` (le notifiche in arrivo); rilegge le schede quando `richieste` cambia (lo alzano app, `jb.py` e Worker quando cambia una scadenza, un avviso, una spunta, un titolo) o ogni 6 ore. Il Cron Trigger gira verso il secondo 47 di ogni minuto: ogni notifica parte dal giro più vicino alla sua ora, al più 30 secondi prima o dopo (provato il 21 novembre su iPhone). Una notifica parte una volta sola (`inviati`); se il Worker resta fermo, dopo 12 ore di ritardo non parte più.
- **Chiave VAPID:** `~/.config/jarvis/vapid.json` (la pubblica anche in `vapid_public` della config, che arriva alla pagina con `config.js`), nel Worker come secret `VAPID_KEY`. Cambiarla scollega tutti i dispositivi.
- **Claude:** `avvisi` in `modifica`, `aggiungi_voce`, `modifica_voce` (server MCP locale e Worker), `jb.py modifica <scheda> '{"scade":"2026-12-01T10:00","avvisi":["1g","1h"]}'`, `jb.py voce <scheda> "testo" --scade 2026-12-01 --avvisi '["0g@09:00"]'`. `[]` li toglie.
- **Installare l'app:** la freccia in alto compare dove si può installare. Su Android e computer (Chrome, Edge) installa con un clic; su iPhone mostra i passaggi (Condividi → Aggiungi alla schermata Home), perché Safari non permette di farlo da un pulsante.

## Al telefono (23 novembre)

Tocco su una scheda = la apre. Tenerla premuta 0,7 s senza muovere il dito = si solleva (vibrazione) e si trascina. Muovere il dito prima (oltre 10 px) = scorrere colonne e schede, e la scheda non viene toccata. Il bordo blu al passaggio del mouse c'è solo dove c'è un mouse (`@media (hover: hover)`), così sul telefono una scheda toccata per scorrere non sembra selezionata; il menu di sistema del tocco lungo è spento sulle schede. `LIFT_MS` e `TOUCH_SLOP` in `app.js`.

## Dati su Firestore

- `bacheca/stato`: colonne ed etichette. Ogni colonna può avere `subtitle` (riga sotto il titolo) e `notes` (Markdown, chiuse finché non si clicca il sottotitolo; dal menu della colonna "Aggiungi sottotitolo" e "Aggiungi note").
- `schede/{id}`: una scheda intera, con checklist, commenti, minuti (`time`) e l'elenco degli allegati.
- `ore/{AAAA-MM-GG}`: minuti per progetto di quel giorno, da `storico.csv`, per la vista Tempo.
- `allegati/{id}` e `allegati/{id}/parti/{n}`: i file allegati, a pezzi da 900 KB, fino a 10 MB.

## Pubblicare

```bash
scripts/deploy.sh hosting     # rigenera i file dalla config, poi firebase deploy --only hosting,firestore:rules
```

## Provare in locale

Serve Java 17 o più con `firebase-tools@13`, oppure Java 21 con l'ultima versione.

```bash
npx -y firebase-tools@13.35.1 emulators:start --only auth,firestore --project demo-bacheca
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 python3 jb.py importa <una bacheca esportata con jb.py json o backup>
cd static && python3 -m http.server 8781
```

Su http://localhost:8781 la pagina usa gli emulatori; dalla console del browser si entra con `provaAccesso("<una mail di allowed_emails>")`, e `provaRete(false)` / `provaRete(true)` stacca e riattacca Firestore per provare le modifiche offline.

## Claude

```bash
python3 jb.py commenti            # commenti del proprietario ancora aperti, con il link alla scheda
python3 jb.py commenti --claude   # commenti di Claude non ancora valutati dal proprietario (risolto = valido), proposti nel buongiorno
python3 jb.py chiusi              # commenti chiusi (risolti, risposte di Claude già valutate); --elimina li cancella, solo dopo conferma
python3 jb.py cronologia          # commenti del proprietario nuovi dall'ultima lettura, risolti compresi (letto a ogni buongiorno)
python3 jb.py cronologia --giorni 7   # gli ultimi 7 giorni, senza spostare il segno di lettura
python3 jb.py rispondi <scheda> <commento> "testo" --risolvi
python3 jb.py colonna settimana
python3 jb.py voce <scheda> "testo" --scade 2026-11-20
python3 jb.py voce <scheda> "testo" --sotto <voce>   # sotto-voce di quella voce, fino a 3 livelli
python3 jb.py tempo <scheda> 2026-11-07 45 30   # minuti di focus e degli agenti di quel giorno, nella sezione Tempo
python3 jb.py ore --giorni 14     # minuti per progetto da storico.csv, per la vista Tempo
python3 jb.py json                # tutta la bacheca
python3 jb.py modifica <scheda> '{"scade":"2026-11-12","colonna":"settimana"}'   # qualsiasi campo della scheda
python3 jb.py modifica-voce <scheda> <voce> '{"testo":"…","scade":""}'          # anche "elimina": true
python3 jb.py modifica-checklist <scheda> <checklist> '{"titolo":"…"}'
python3 jb.py modifica-commento <scheda> <commento> '{"risolto":false}'
python3 jb.py modifica-colonna lavoro '{"sottotitolo":"…","note":"### …"}'   # anche nome e colore
python3 jb.py modifica <scheda> '{"priorita":4}'   # priorità da 1 (Critica) a 5 (Minima), 0 la toglie
python3 jb.py elimina <scheda>    # definitivo; per toglierla senza perderla: modifica con "archiviata": true
```

Ogni parte della scheda si cambia con una chiamata sola (10 novembre): titolo, descrizione, scadenza, priorità, fatta, etichette (nomi o id), ambito, colonna, posizione, archivio; voci (testo, scadenza, fatta, posizione, checklist, eliminazione); checklist (titolo, nascondi fatte, posizione, eliminazione); commenti (testo, risolto, eliminazione). Le regole sono quelle di `static/store.js`. Spostare una scheda non rinumera le altre: prende un `pos` tra le vicine, e l'app rinumera al primo spostamento.

Ogni scheda si apre anche da link: `<bacheca_url>/#c/<id scheda>`.

## Server MCP

`mcp_server.py` espone gli stessi comandi come strumenti MCP (stdio, solo libreria standard): `commenti`, `cronologia`, `colonna`, `cerca`, `scheda`, `bacheca`, `nuova_scheda`, `aggiungi_voce`, `spunta`, `modifica`, `modifica_voce`, `nuova_checklist`, `modifica_checklist`, `modifica_commento`, `modifica_colonna`, `elimina_scheda`, `commenta`, `rispondi`, `risolvi`, `tempo`. Chiama `jb.main()` nello stesso processo, quindi usa la stessa chiave e lo stesso token. `importa`, `salva` e `backup` restano solo da riga di comando.

**Letture compatte (21 novembre):** quello che uno strumento restituisce resta nel contesto di Claude per tutta la chat, quindi si filtra nel server, non dopo. `bacheca` dà un indice (una riga per scheda non archiviata, colonna per colonna, più le etichette: circa 3 KB invece di 160); `completa=true` dà ancora tutto il JSON. `bacheca` e `colonna` accettano `aperte` (non fatte), `entro` (scadenza della scheda o di una voce aperta entro N giorni, comprese le scadute) e `limite` (schede per colonna). `cerca` guarda solo titolo, descrizione, checklist e commenti, mostra la colonna e accetta `attive`, `colonna`, `limite`. `scheda` dà JSON compatto senza campi vuoti né commenti risolti (contati in `commenti_risolti_nascosti`; `tutto=true` li mostra). Le scritture restituiscono già solo id e una riga. Da riga di comando: `jb.py indice`, le stesse opzioni con `--`, `jb.py scheda <id> --breve [--tutto]` (senza `--breve` resta il JSON intero, che serve a `salva`). Stesse regole nel Worker.

È registrato a livello utente in Claude Code (`~/.claude.json`), quindi lo vedono tutte le sessioni, in qualsiasi cartella e in entrambe le istanze del desktop:

```bash
claude mcp add bacheca --scope user -- python3 /percorso/di/jarvis/bacheca/mcp_server.py
```

## Server MCP remoto (Cloudflare)

`mcp-worker/` è lo stesso server per claude.ai (web, telefono, tab Chat), come connettore personalizzato: **`<worker_url>/mcp`**. Worker gratuito di Cloudflare; prima del primo deploy si crea il KV con `npx wrangler kv namespace create OAUTH_KV` e se ne mette l'id in `kv_namespace_id`.

- `src/tools.ts`: gli stessi strumenti, con gli stessi testi di `jb.py`. `cronologia` qui vuole i giorni (default 7) e non sposta il segno di lettura di `/buongiorno`.
- `src/firestore.ts`: Firestore via REST; il token di Google si firma con WebCrypto dalla chiave nel secret `BACHECA_SA`.
- `src/index.ts`: OAuth con `@cloudflare/workers-oauth-provider` (grant e client nel KV `OAUTH_KV`). Consenso sul Worker, poi accesso con Google su `static/mcp-login.html` (stesso Firebase Auth della bacheca), che torna al Worker con l'ID token nel frammento dell'URL. Il Worker verifica il token e accetta solo le mail di `ALLOWED_EMAIL` (da `allowed_emails`).
- `src/avvisi.ts`: le notifiche delle scadenze, ogni minuto (Cron Trigger in `wrangler.jsonc`). Prova locale: `npx wrangler dev --test-scheduled`, poi `curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"` (con `BACHECA_SA` e `VAPID_KEY` in `.dev.vars`, fra apici singoli).
- `src/dev.ts`: solo per le prove locali, senza OAuth (`npx wrangler dev src/dev.ts`, con `BACHECA_SA='…'` in `.dev.vars`).

```bash
cd mcp-worker
npx wrangler deploy                                   # pubblica (o scripts/deploy.sh worker)
npx wrangler secret put BACHECA_SA < ~/.config/jarvis/bacheca-sa.json   # se cambia la chiave
npx wrangler secret put VAPID_KEY < ~/.config/jarvis/vapid.json          # chiave delle notifiche
npx wrangler tail                                     # log in diretta
```

Se wrangler dice "auth token has expired … could not be reached", di solito è l'IPv6, che verso Cloudflare non risponde: si risolve forzando IPv4 con `NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000" npx wrangler deploy` (9 novembre).

Se cambia l'indirizzo del Worker va aggiornato `worker_url` nella config, poi `scripts/deploy.sh hosting`. Per togliere l'accesso a tutti i client collegati basta svuotare il KV `OAUTH_KV` dalla dashboard di Cloudflare.
