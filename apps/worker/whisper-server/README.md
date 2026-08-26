# Whisper server locale (faster-whisper)

Sostituisce l'API Whisper di OpenAI (a pagamento, $0.006/min) con **faster-whisper**
eseguito localmente sulla tua GPU: gratis, stessa qualità (stesso tipo di modello Whisper
sotto, versione `large-v3`), stessi timestamp a livello di parola.

Richiede una GPU NVIDIA con almeno ~6GB di VRAM libera per il modello `large-v3` in
`float16` (con meno VRAM usa un modello più piccolo, vedi `WHISPER_MODEL_SIZE` sotto).

## Setup (una tantum)

Il worker Node **non gestisce** questo server: è un processo Python separato, da avviare
a mano in un secondo terminale quando vuoi trascrivere in locale (esattamente come
`pnpm dev:worker` per il worker).

Usiamo la distribuzione Python "embeddable" (uno zip, nessun installer) invece del
normale installer di python.org: su alcune macchine l'installer MSI fallisce per motivi
di permessi/policy di sistema — questo approccio li evita del tutto.

```powershell
cd apps/worker/whisper-server

# 1. Scarica ed estrai Python 3.12 embeddable
curl -o python-embed.zip https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip
Expand-Archive python-embed.zip -DestinationPath python-embed
Remove-Item python-embed.zip

# 2. Abilita site-packages (necessario per pip): in python-embed/python312._pth,
#    togli il commento dalla riga "import site"
(Get-Content python-embed/python312._pth) -replace '#import site', 'import site' | Set-Content python-embed/python312._pth

# 3. Installa pip
curl -o get-pip.py https://bootstrap.pypa.io/get-pip.py
./python-embed/python.exe get-pip.py --no-warn-script-location
Remove-Item get-pip.py

# 4. Installa le dipendenze (faster-whisper, flask, DLL cuBLAS/cuDNN ridistribuibili —
#    niente CUDA Toolkit completo da installare)
./python-embed/python.exe -m pip install --no-warn-script-location -r requirements.txt
```

## Avvio

Imposta prima in `apps/worker/.env`:

```
TRANSCRIPTION_PROVIDER=local
```

Poi, dalla radice del repository, un solo comando avvia sia il server whisper sia il
worker insieme (output con prefisso `[whisper]`/`[worker]` nello stesso terminale):

```bash
pnpm dev:worker:local
```

(Alternativa: due terminali separati con `pnpm dev:whisper` e `pnpm dev:worker`, se
preferisci log distinti o vuoi lasciare il server whisper acceso più a lungo del worker.)

Al primo avvio scarica il modello `large-v3` (~3GB, una tantum, cache in
`~/.cache/huggingface`). Quando vedi `[whisper-server] Modello pronto.` è in ascolto su
`http://127.0.0.1:8765` e il worker può usarlo.

Per tornare a Whisper API, rimetti `TRANSCRIPTION_PROVIDER=openai` (o rimuovi la riga) e
riavvia — nessun altro cambio.

## Variabili d'ambiente opzionali (server Python)

- `WHISPER_MODEL_SIZE` (default `large-v3`) — modelli più piccoli (`medium`, `small`,
  `base`) sono più veloci e usano meno VRAM ma sono meno precisi.
- `WHISPER_DEVICE` (default `cuda`) — `cpu` se non hai una GPU NVIDIA (molto più lento).
- `WHISPER_COMPUTE_TYPE` (default `int8_float16`, quantizzato — più veloce, quasi stessa
  qualità di `float16` su GPU con VRAM limitata come una 8GB) — `float16` per la precisione
  numerica piena se hai una GPU con più VRAM e vuoi il massimo della qualità.
- `WHISPER_SERVER_PORT` (default `8765`).
