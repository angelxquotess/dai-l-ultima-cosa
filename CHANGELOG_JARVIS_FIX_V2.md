# JARVIS – Fix v2 (2026-01)

Patch chirurgica su WhatsApp bridge + CPU. Nessuna riscrittura, solo tocchi mirati.

## Fase 1+2 — Bridge WhatsApp + fuzzy matching

**File toccati**
- `wa-bridge/server.js`
- `actions/whatsapp_bridge.py`
- `actions/send_message.py`
- `actions/message_state.py`

**Cosa cambia**
1. `resolveChatByName` ora normalizza gli accenti (NFD) e fa fuzzy matching
   (`tokenSetRatio` implementato inline, nessuna nuova dipendenza npm).
2. Nuovo endpoint `GET /resolveContact?name=X&topN=3&threshold=65` sul bridge
   Node: ritorna `{exact, matches:[{name,id,score}]}`.
3. `POST /send` con chat non trovata ora ritorna anche `suggestions[]` con
   i top-3 candidati fuzzy: `send_message.py` li legge senza secondo round-trip.
4. `send_message`:
   - se top-score ≥ 92 → invio silenzioso al miglior candidato;
   - altrimenti chiede vocalmente *"Non ho trovato X, signore. Intendeva A, B o C?"*,
     memorizza la scelta in `message_state.set_pending_fuzzy(...)` e attende
     la conferma vocale (comando `confirm_fuzzy_send`).
5. Cache in-memory della chat list nel bridge (TTL 3 min, invalidata ad ogni
   messaggio entrante) per non re-interrogare Puppeteer ad ogni comando.
6. Log dettagliato: quando la risoluzione fallisce, viene stampata la lista
   delle prime 15 chat viste dal bridge → serve a diagnosticare i selettori
   quando WhatsApp Web li cambia lato loro.

**Nuovo comando esposto**
`confirm_fuzzy_send` → il router comandi di JARVIS deve mapparlo su intenti
del tipo *"il primo"*, *"Noemi Rossi"*, *"annulla"* subito dopo il prompt fuzzy.

## Fase 3 — Notifiche in arrivo (lettura ad alta voce)

**File toccati**
- `actions/check_messages.py`
- `actions/message_state.py`

**Cosa cambia**
1. Debounce **2 s** su `(platform|sender|body[:60])` prima di annunciare:
   niente più letture doppie quando WhatsApp consegna eventi ravvicinati.
2. Frase estesa: ora contiene il **testo del messaggio** (*"Signore, nuovo
   messaggio da Mamma: ci vediamo alle 8"*) invece del generico *"vuole sapere
   il contenuto?"*.
3. Toggle mute globale (`set_tts_mute(True)`) da chiamare quando l'utente sta
   parlando a JARVIS: gli annunci vengono accodati in `_tts_queue` e drenati
   con `drain_muted_speech()` non appena `set_tts_mute(False)`. Scelta fatta
   sulla domanda aperta: **accodare, non scartare** (come richiesto).
4. Polling Python `_poll_whatsapp` alzato da 10 s → 20 s (il bridge Node fa
   già dedupe + push, non serve polling stretto).

## Fase 4 — Fix CPU

**File toccati**
- `wa-bridge/server.js`
- `actions/messaging_panel.py`

**Cosa cambia**
1. **Singleton QWebEngineView** — era già presente in `_Manager._panels`,
   verificata e blindata.
2. **WebGL / canvas HW disabilitati** su `QWebEngineSettings`:
   ```
   WebGLEnabled = False
   Accelerated2dCanvasEnabled = False
   PluginsEnabled = False
   AutoLoadIconsForPage = False
   ```
   Risolve *"Too many active WebGL contexts"* e riduce ~40 % CPU sulla webview.
3. **Interceptor telemetria** (`QWebEngineUrlRequestInterceptor` +
   `page.setRequestInterception` lato puppeteer) che blocca:
   - `dit.whatsapp.net`
   - `deidentified_telemetry`
   - `/telemetry`
   → ferma il loop CORS che saturava la CPU.
4. **Lifecycle Frozen** su `hideEvent`: quando la tendina è nascosta, il
   rendering si congela (`page.setLifecycleState(Frozen)`) e il `QTimer`
   viene fermato. Riattivato su `showEvent`.
5. **Polling DOM** JS dentro la webview: da 4 s → 15 s. Il bridge Node fa
   comunque push su `/unread`, quindi la webview non è più il canale
   principale di notifica.
6. Args puppeteer con `--disable-webgl --disable-webgl2
   --disable-accelerated-2d-canvas --disable-features=WebGL,WebGL2,Accelerated2dCanvas`.

## Fase 5 — Preview Download

Servita direttamente da Emergent: URL pubblico, pagina nera full-screen,
un solo bottone bianco *"Download"* al centro. Click → scarica
`daiiiii-updated.zip` con tutte le patch applicate (escluse
`.git`, `__pycache__`, `node_modules`, `.venv`, `.wwebjs_auth`).

## Assunzioni / risposte alle domande aperte

- **Timeout conferma vocale fuzzy**: 5 s (default confermato).
- **Interazione JARVIS parlante + msg in arrivo**: accoda (via `_tts_queue`
  di `message_state`).
- **Soglia fuzzy**: 65 su `token_set_ratio` sia lato Node che lato Python.
  Auto-pick silenzioso solo se score ≥ 92.

## Come installare la patch

1. Scompatta `daiiiii-updated.zip` sopra il progetto esistente
   (sovrascrive solo i file toccati elencati sopra).
2. Nessuna nuova dipendenza npm richiesta.
3. `rapidfuzz` è **opzionale** lato Python: il fallback funziona senza.
   Se vuoi installarlo: `pip install rapidfuzz`.
4. Riavvia il bridge (`node wa-bridge/server.js`) e JARVIS.
