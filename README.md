# AI Interview Analyzer

## Overview

A small full-stack prototype that records short audio answers in the browser, uploads them to a FastAPI backend which converts to WAV and forwards the file to Google GenAI (Gemini) for a structured transcription and objective scoring (fluency, confidence, filler rate, tone, keyword coverage). The backend stores audio files locally in `backend/uploads/` by default and keeps a persistent counter so filenames are sequential across restarts.

This repository is a developer-focused prototype for building an interview-answer analysis tool. It's not production-ready but demonstrates the end-to-end flow: record → upload → convert → analyze → return structured results.

## Architecture

- **Frontend**: Vite + React (`src/App.jsx`) — records audio via MediaRecorder, uploads to the backend, and displays analysis results.
- **Backend**: FastAPI (`backend/main.py`) — accepts uploads, converts to WAV using `ffmpeg`, stores files in `backend/uploads/`, uploads to Google GenAI, and parses the model output into structured JSON.
- **Model integration**: Uses the `google.genai` client to upload files and invoke a model (`gemini-2.5-flash`) with a structured prompt that requests JSON output.

## Quickstart (local development)

### Prerequisites
- Python 3.9+
- Node.js (for the frontend dev server)
- ffmpeg (installed and available on PATH)

### Backend

1. Create a virtual environment and install dependencies:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Optional environment variables:

- `UPLOAD_DIR` — override upload storage location (defaults to `backend/uploads/`).
- `GENAI_API_KEY` — set your GenAI API key in the environment. Do not hard-code keys in source.

3. Start the backend:

```bash
uvicorn main:app --reload
```

### Frontend

1. From the project root, install dependencies and start the dev server:

```bash
npm install
npm run dev
```

2. Open the Vite URL (typically http://localhost:5173). Record and use **Stop & Send** — the UI uploads the recording and then displays the model analysis.

## API Endpoints

- **POST /api/upload-audio**
  - Accepts multipart form-data key `file` (webm/ogg/m4a/any audio).
  - Saves the incoming file to `UPLOAD_DIR`, converts it to WAV (mono, 16kHz), and returns JSON with `wav_filename`, `wav_path`, and `duration_seconds`.

- **POST /api/analyze_with_genai**
  - Accepts JSON: `{ "wav_filename": "<name.wav>", "keywords": ["..."] }`.
  - If `wav_filename` is omitted, the backend selects the most-recent `.wav` file in `UPLOAD_DIR`.
  - Uploads the WAV to GenAI and requests a structured JSON response (transcript, scores, counts, suggestions). The endpoint parses and normalizes the model output and returns it.

- **GET /api/list**
  - Returns a list of converted `.wav` files in `UPLOAD_DIR` (development helper).

## Data shapes

Example analysis response (successful):

```json
{
  "status": "ok",
  "result": {
    "transcript": "...",
    "scores": {
      "fluency": 88,
      "confidence": 92,
      "filler_rate_per_min": 0.0,
      "tone": "neutral",
      "keyword_coverage_pct": null
    },
    "counts": { "total_words": 63, "total_fillers": 0, "long_pauses": 1 },
    "suggestions": ["...", "..."]
  },
  "raw_text": "<original model output for debugging>"
}
```

## Development notes & limitations

- **API keys**: Never commit API keys. Move `api_key` usage in `backend/main.py` to read from `GENAI_API_KEY` env var.
- **Filename sequencing**: The backend persists a simple `.counter` file to keep sequential numbered filenames. This is fine for single-process development but not safe for multi-worker production. Use a DB or Redis INCR in production for atomic sequences.
- **Model output**: The backend instructs the model to return strict JSON and retries once if parsing fails, but models may still produce unexpected text. Consider adding schema validation (Pydantic) and fallback heuristics.

## Troubleshooting

- `ffmpeg: command not found` — install ffmpeg (macOS: `brew install ffmpeg`; Ubuntu: `sudo apt install ffmpeg`).
- `GenAI upload/generation failed` — check the API key, network connectivity, and client configuration.
- Permission errors writing to `uploads/` — ensure the backend process can write to the directory.

## Next steps / improvements

- Add Pydantic models to validate requests and model responses automatically.
- Replace `.counter` with an atomic DB-backed sequence for multi-worker safety.
- Enhance frontend UX: show selected filename, render scores visually, and display timestamped history.
- Add unit/integration tests for parsing model outputs and the upload/convert/analyze pipeline.

## License

This project is provided as a developer prototype. Add a license if you plan to share it publicly.
