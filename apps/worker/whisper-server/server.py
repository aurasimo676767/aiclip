"""
Server locale di trascrizione per ClipForge: sostituisce l'API Whisper di OpenAI con
faster-whisper eseguito sulla GPU di questa macchina (gratis, stessa qualita' o migliore).

Uso: python python-embed/python.exe server.py
Espone POST /transcribe (multipart, campo "audio") -> JSON con segmenti + parole con
timestamp, nello stesso formato che il worker Node si aspetta da OpenAI Whisper.
"""

import io
import os
import sys
from pathlib import Path

# ctranslate2 (usato da faster-whisper) richiede cuBLAS/cuDNN a runtime ma non li include:
# installiamo le versioni ridistribuibili via pip (nvidia-cublas-cu12, nvidia-cudnn-cu12,
# vedi requirements.txt) invece dell'intero CUDA Toolkit (~3GB) e registriamo qui le loro
# cartelle nel percorso di ricerca DLL di Windows, PRIMA di importare faster_whisper.
if os.name == "nt":
    _site_packages = Path(__file__).parent / "python-embed" / "Lib" / "site-packages"
    _dll_dirs = [_site_packages / "nvidia" / "cublas" / "bin", _site_packages / "nvidia" / "cudnn" / "bin"]
    _dll_dirs = [d for d in _dll_dirs if d.is_dir()]
    # add_dll_directory da solo non basta per come ctranslate2 carica queste DLL: serve
    # anche in PATH (ricerca "classica", indipendente da SetDefaultDllDirectories).
    os.environ["PATH"] = os.pathsep.join(str(d) for d in _dll_dirs) + os.pathsep + os.environ.get("PATH", "")
    for _dll_dir in _dll_dirs:
        os.add_dll_directory(str(_dll_dir))

from faster_whisper import WhisperModel, BatchedInferencePipeline
from flask import Flask, jsonify, request

MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "large-v3")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8_float16")
PORT = int(os.environ.get("WHISPER_SERVER_PORT", "8765"))
# Solo per /transcribe-fast (pipeline long-form/VOD, vedi sotto): quanti segmenti VAD la GPU
# processa insieme. Testato su una 3060 Ti 8GB: 8 dà ~4.5x di velocità reale su audio denso
# (reazioni/urla) senza errori di memoria. Non alzarlo senza rifare il test di VRAM.
BATCH_SIZE = int(os.environ.get("WHISPER_BATCH_SIZE", "8"))

app = Flask(__name__)

print(f"[whisper-server] Caricamento modello {MODEL_SIZE} su {DEVICE} ({COMPUTE_TYPE})...", file=sys.stderr)
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
# Wrappa la STESSA istanza del modello (nessun peso ricaricato, nessuna VRAM aggiuntiva) per
# esporre anche la modalità batched, usata solo da /transcribe-fast.
batched_pipeline = BatchedInferencePipeline(model=model)
print("[whisper-server] Modello pronto.", file=sys.stderr)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE, "device": DEVICE})


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "campo 'audio' mancante"}), 400

    audio_file = request.files["audio"]
    audio_bytes = io.BytesIO(audio_file.read())

    segments_iter, info = model.transcribe(
        audio_bytes,
        word_timestamps=True,
        vad_filter=True,
    )

    segments = []
    words = []
    text_parts = []

    for i, seg in enumerate(segments_iter):
        text_parts.append(seg.text.strip())
        segments.append({"id": i, "start": seg.start, "end": seg.end, "text": seg.text.strip()})
        for w in seg.words or []:
            words.append({"word": w.word.strip(), "start": w.start, "end": w.end})

    return jsonify(
        {
            "text": " ".join(text_parts).strip(),
            "language": info.language,
            "duration": info.duration,
            "segments": segments,
            "words": words,
        }
    )


@app.route("/transcribe-fast", methods=["POST"])
def transcribe_fast():
    # SOLO per la pipeline long-form/VOD (vedi local-faster-whisper-provider.ts): quel percorso
    # non legge mai i timestamp per parola né mostra sottotitoli, gli serve solo il testo a
    # livello di frase per capire i blocchi di attività — quindi qui si può usare l'inferenza
    # batched (~4.5x più veloce, verificato su audio reale) e disattivare word_timestamps senza
    # perdere nulla che venga effettivamente usato. NON toccare mai gli Shorts con questo
    # endpoint: perdono precisione sull'inizio della frase-gancio e i sottotitoli parola-per-
    # parola, che invece usano SOLO /transcribe (sequenziale, sopra).
    if "audio" not in request.files:
        return jsonify({"error": "campo 'audio' mancante"}), 400

    audio_file = request.files["audio"]
    audio_bytes = io.BytesIO(audio_file.read())

    segments_iter, info = batched_pipeline.transcribe(
        audio_bytes,
        word_timestamps=False,
        vad_filter=True,
        batch_size=BATCH_SIZE,
    )

    segments = []
    text_parts = []

    for i, seg in enumerate(segments_iter):
        text_parts.append(seg.text.strip())
        segments.append({"id": i, "start": seg.start, "end": seg.end, "text": seg.text.strip()})

    return jsonify(
        {
            "text": " ".join(text_parts).strip(),
            "language": info.language,
            "duration": info.duration,
            "segments": segments,
            "words": [],
        }
    )


if __name__ == "__main__":
    # threaded=True: senza, il server accetta UNA connessione alla volta — durante una
    # trascrizione lunga (single-thread, GPU comunque seriale sulle inferenze) anche solo
    # /health o una richiesta in coda potevano trovare il socket occupato e fallire con
    # connessione rifiutata invece di aspettare in coda.
    app.run(host="127.0.0.1", port=PORT, threaded=True)
