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

```powershell
cd apps/worker/whisper-server
./python-embed/python.exe server.py
```

Al primo avvio scarica il modello `large-v3` (~3GB, una tantum, cache in
`~/.cache/huggingface`). Quando vedi `[whisper-server] Modello pronto.` è in ascolto su
`http://127.0.0.1:8765`.

Poi, nell'altro terminale dove gira il worker, imposta in `apps/worker/.env`:

```
TRANSCRIPTION_PROVIDER=local
```

e riavvia `pnpm dev:worker`. Se vuoi tornare a Whisper API, basta rimettere
`TRANSCRIPTION_PROVIDER=openai` (o rimuovere la riga) e riavviare — nessun altro cambio.

## Variabili d'ambiente opzionali (server Python)

- `WHISPER_MODEL_SIZE` (default `large-v3`) — modelli più piccoli (`medium`, `small`,
  `base`) sono più veloci e usano meno VRAM ma sono meno precisi.
- `WHISPER_DEVICE` (default `cuda`) — `cpu` se non hai una GPU NVIDIA (molto più lento).
- `WHISPER_COMPUTE_TYPE` (default `float16`) — `int8_float16` se hai poca VRAM.
- `WHISPER_SERVER_PORT` (default `8765`).
