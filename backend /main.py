import os
import uuid
import shutil
import subprocess
import wave
from pathlib import Path
from fastapi import FastAPI, File, UploadFile, HTTPException
from google import genai
import json
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware

# initialize GenAI client (expects credentials configured in environment)
client = genai.Client(api_key='GEMINI-API-Key')  # replace with your actual API key



DEFAULT_LOCAL_UPLOADS = Path(__file__).resolve().parent / "uploads"
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR") or DEFAULT_LOCAL_UPLOADS)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# FastAPI app
app = FastAPI(title="Audio Receiver & Converter")

# CORS (dev) - change for production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

current_file_name = ""
# simple incrementing counter for predictable filenames (1,2,3...)
_file_counter = 0
_counter_lock = None


def _load_counter(counter_path: Path) -> int:
    try:
        if counter_path.exists():
            return int(counter_path.read_text().strip() or 0)
    except Exception:
        pass
    return 0


def _save_counter(counter_path: Path, value: int) -> None:
    try:
        counter_path.write_text(str(value))
    except Exception:
        pass


def _init_counter():
    """Initialize module-level counter and lock using UPLOAD_DIR/.counter."""
    global _file_counter, _counter_lock
    from threading import Lock

    _counter_lock = Lock()
    counter_file = UPLOAD_DIR / ".counter"
    _file_counter = _load_counter(counter_file)


def _safe_filename(orig_name: str) -> str:
    """Generate a sequential filename preserving extension and persist counter.

    Note: safe for single-process and threads due to the lock. Not safe across
    multiple processes; for that use a DB or atomic file-based increment.
    """
    global _file_counter, _counter_lock
    if _counter_lock is None:
        _init_counter()

    counter_file = UPLOAD_DIR / ".counter"
    ext = Path(orig_name).suffix or ".bin"
    with _counter_lock:
        _file_counter += 1
        _save_counter(counter_file, _file_counter)
        return f"{_file_counter}{ext}"


def convert_to_wav(input_path: Path, output_path: Path) -> None:
    """
    Run ffmpeg to convert any input audio to WAV (mono, 16k).
    Raises subprocess.CalledProcessError on failure.
    """
    cmd = [
        "ffmpeg",
        "-y",                # overwrite
        "-i",
        str(input_path),
        "-ac",
        "1",                 # mono
        "-ar",
        "16000",             # 16 kHz
        "-vn",               # drop video if present
        str(output_path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def get_wav_duration_seconds(wav_path: Path) -> float:
    """Return duration in seconds using wave module (works for PCM WAV)."""
    with wave.open(str(wav_path), "rb") as wf:
        frames = wf.getnframes()
        rate = wf.getframerate()
        if rate == 0:
            return 0.0
        return frames / float(rate)


@app.post("/api/upload-audio")
async def upload_audio(file: UploadFile = File(...)):
    """
    Accepts multipart form upload with key 'file'.
    Converts to WAV (mono, 16k) and returns basic metadata.
    """
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="No file uploaded")

    # Save incoming file to UPLOAD_DIR
    in_filename = _safe_filename(file.filename)
    in_path = UPLOAD_DIR / in_filename
    try:
        contents = await file.read()
        with open(in_path, "wb") as f:
            f.write(contents)
    except Exception as e:
        # cleanup if write failed
        try:
            if in_path.exists():
                in_path.unlink()
        except: pass
        raise HTTPException(status_code=500, detail=f"Failed to save uploaded file: {e}")

    # Convert to WAV
    out_filename = f"{in_path.stem}.wav"
    # expose the current file name for other handlers if needed
    current_file_name = out_filename
    out_path = UPLOAD_DIR / out_filename
    try:
        convert_to_wav(in_path, out_path)
    except subprocess.CalledProcessError as e:
        # cleanup input file
        try:
            in_path.unlink()
        except: pass
        raise HTTPException(status_code=500, detail="ffmpeg conversion failed")
    except Exception as e:
        try:
            in_path.unlink()
        except: pass
        raise HTTPException(status_code=500, detail=f"Conversion error: {e}")

    # Get duration (seconds)
    try:
        duration = get_wav_duration_seconds(out_path)
    except Exception:
        duration = None

    # (Optional) Keep both files for later processing. If you want to remove input:
    try:
        in_path.unlink()  # remove original uploaded file to save space
    except Exception:
        pass

    # Return relative filename and metadata — backend will use the file for further processing
    return {
        "status": "ok",
        "wav_filename": out_filename,
        "wav_path": str(out_path),   # you can remove this if you don't want to expose paths
        "duration_seconds": None if duration is None else round(duration, 3),
        "message": "File converted to WAV (mono, 16k). Proceed with transcription/analysis."
    }


@app.post("/api/analyze_with_genai")
async def analyze_with_genai(payload: Request):
    """
    Expects JSON body: {"wav_filename": "<name.wav>", "keywords": ["k1","k2"]} (keywords optional)
    Uploads WAV to Google GenAI, asks for a strict JSON response containing transcript + scores,
    validates/parses the model output, and returns the parsed JSON to the client.
    """
    body = await payload.json()
    wav_filename = body.get("wav_filename")
    keywords = body.get("keywords") or []
    # If wav_filename not supplied, pick the most recently modified .wav in UPLOAD_DIR
    if not wav_filename:
        wavs = sorted(UPLOAD_DIR.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not wavs:
            raise HTTPException(status_code=404, detail="no wav files available")
        wav_path = wavs[0]
        wav_filename = wav_path.name
    else:
        wav_path = UPLOAD_DIR / wav_filename
        if not wav_path.exists():
            raise HTTPException(status_code=404, detail="wav file not found")

    # Upload file to GenAI
    try:
        uploaded = client.files.upload(file=str(wav_path))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"GenAI file upload failed: {e}")

    # Build the prompt with optional keywords
    base_prompt = (
        "You are an assistant that transcribes an audio clip and rates the speaker with objective numeric scores.\n"
        "Output MUST be valid JSON and nothing else. Follow this JSON schema exactly:\n"
        "{\n"
        "  \"transcript\": \"<string>\",\n"
        "  \"scores\": {\n"
        "    \"overall\": \"<0-100>\",\n"
        "    \"fluency\": \"<0-100>\",\n"
        "    \"confidence\": \"<0-100> (INTEGER, required)\",\n"
        "    \"filler\": \"<0-100>\",\n"
        "    \"filler_rate_per_min\": \"<float> (required, decimals allowed)\",\n"
        "    \"tone\": \"<neutral|positive|negative|anxious|angry|happy>\",\n"
        "    \"keyword_coverage_pct\": \"<0-100|null>\"\n"
        "  },\n"
        "  \"counts\": {\n"
        "    \"total_words\": \"<int>\",\n"
        "    \"total_fillers\": \"<int>\",\n"
        "    \"long_pauses\": \"<int>\"\n"
        "  },\n"
        "  \"suggestions\": [\"<short suggestion strings>\"]\n"
        "}\n"
        "REQUIREMENTS:\n"
        "- \"confidence\" MUST be an integer between 0 and 100. Do not return null.\n"
        "- \"filler_rate_per_min\" MUST be a numeric value (decimals allowed) representing estimated filler words per minute. Do not return null.\n"
        "- Count filler words as occurrences of: \"um\", \"uh\", \"like\" (when used as a filler), \"you know\", \"I mean\". Do NOT count words used with clear semantic meaning.\n"
        "- \"total_fillers\" should be the integer count of detected filler occurrences in the transcript.\n"
        "- If you cannot determine a metric, estimate conservatively rather than returning null for confidence/filler_rate_per_min.\n"
        "Provide integers for 0-100 scores; use one decimal place for filler_rate_per_min when appropriate.\n"
    )

    if keywords:
        base_prompt += "Keywords to check for coverage: " + ", ".join(keywords) + "\n"

    # Call the model
    try:
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[base_prompt, uploaded],
            
        )
        raw_text = getattr(resp, "text", None) or (resp.get("text") if isinstance(resp, dict) else str(resp))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"GenAI generation failed: {e}")

    # helper to parse JSON out of model output
    def try_parse(s: str):
        if not s:
            return None
        s = s.strip()
        # strip triple-backticks if present
        if s.startswith("```") and s.endswith("```"):
            s = "\n".join(s.splitlines()[1:-1])
        try:
            return json.loads(s)
        except Exception:
            start = s.find('{')
            end = s.rfind('}')
            if start != -1 and end != -1 and end > start:
                try:
                    return json.loads(s[start:end+1])
                except Exception:
                    return None
            return None

    parsed = try_parse(raw_text)

    # retry once with a stricter instruction if parsing failed
    if parsed is None:
        retry_prompt = "ONLY OUTPUT A SINGLE JSON OBJECT following the schema. Do not add ANY explanatory text."
        try:
            resp2 = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=[retry_prompt, base_prompt, uploaded],
            )
            raw_text2 = getattr(resp2, "text", None) or (resp2.get("text") if isinstance(resp2, dict) else str(resp2))
            parsed = try_parse(raw_text2)
            if parsed is not None:
                raw_text = raw_text2
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"GenAI retry failed: {e}")

    if parsed is None:
        # return raw model output for debugging
        return {"status": "error", "message": "Model did not return valid JSON", "raw": raw_text}

    # basic normalization: cast numeric score fields if possible
    try:
        scores = parsed.get("scores", {})
        for key in ["fluency", "confidence", "keyword_coverage_pct"]:
            val = scores.get(key)
            if val is not None:
                scores[key] = int(float(val))
        parsed["scores"] = scores
    except Exception:
        pass

    return {"status": "ok", "result": parsed, "raw_text": raw_text}


@app.get("/api/list")
def list_files():
    """Optional helper to list converted WAVs (for dev)."""
    files = sorted([p.name for p in UPLOAD_DIR.glob("*.wav")])
    return {"count": len(files), "files": files}