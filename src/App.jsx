// src/main.jsx
import React, { useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "./index.css"; // optional - keep if you have global styles

const API_BASE = "http://localhost:8000"; // use relative path, e.g. "", or "http://localhost:8000" if not proxied

function App() {
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [status, setStatus] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [keywords, setKeywords] = useState("");

  // Start recording
  const startRecording = async () => {
    setStatus("");
    setError(null);
    setAnalysis(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start();
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (err) {
      console.error("mic error", err);
      setError("Unable to access microphone. Allow microphone permissions and try again.");
    }
  };

  // Stop, upload, and analyze
  const stopAndSend = async () => {
    setError(null);
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    // stop recording
    if (recorder.state === "recording") recorder.stop();

    // stop timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    recorder.onstop = async () => {
      setRecording(false);
      setSeconds(0);

      // stop tracks
      try {
        streamRef.current?.getTracks()?.forEach((t) => t.stop());
      } catch (_) { }

      // create blob
      const blob = new Blob(chunksRef.current, {
        type: chunksRef.current[0]?.type || "audio/webm",
      });

      // upload
      setStatus("Uploading audio...");
      try {
        const form = new FormData();
        form.append("file", blob, "answer.webm");

        const uploadResp = await fetch(`${API_BASE}/api/upload-audio`, {
          method: "POST",
          body: form,
        });

        if (!uploadResp.ok) {
          const text = await uploadResp.text();
          throw new Error(`Upload failed: ${uploadResp.status} ${text}`);
        }

        const uploadJson = await uploadResp.json();
        const wavFilename = uploadJson.wav_filename;
        if (!wavFilename) throw new Error("Server did not return wav_filename");

        // call analyze endpoint right away
        setStatus("Analyzing with Gemini (GenAI)...");
        const keywordsArray = keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);

        const analyzeResp = await fetch(`${API_BASE}/api/analyze_with_genai`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wav_filename: wavFilename, keywords: keywordsArray }),
        });

        if (!analyzeResp.ok) {
          const text = await analyzeResp.text();
          throw new Error(`Analyze failed: ${analyzeResp.status} ${text}`);
        }

        const analyzeJson = await analyzeResp.json();

        if (analyzeJson.status === "ok" && analyzeJson.result) {
          setAnalysis(analyzeJson.result);
          setStatus("Analysis complete");
        } else {
          // model could return error object or raw text
          setAnalysis({ error: analyzeJson });
          setStatus("Model returned non-OK response");
        }
      } catch (err) {
        console.error(err);
        setError(err.message || "Upload/analysis failed");
        setStatus("");
      } finally {
        // cleanup
        chunksRef.current = [];
        mediaRecorderRef.current = null;
      }
    };
  };

  // Cancel recording and discard
  const cancelRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      streamRef.current?.getTracks()?.forEach((t) => t.stop());
    } catch (_) { }
    chunksRef.current = [];
    setRecording(false);
    setSeconds(0);
    setStatus("");
  };

  // format seconds mm:ss
  const fmt = (s) => {
    const mm = Math.floor(s / 60)
      .toString()
      .padStart(2, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  };

  // small UI pieces
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>AI Interview Response Grader</h1>

        <p style={styles.subtitle}>
          Record a short introduction about you, we will analyze it and to provide a transcript and structured scores. 
        </p>

        <div style={styles.controls}>
          <button
            onClick={startRecording}
            disabled={recording}
            style={{ ...styles.button, background: recording ? "#9ACD32" : "#2d8cff" }}
          >
            🎙 Start
          </button>

          <button
            onClick={stopAndSend}
            disabled={!recording}
            style={{ ...styles.button, marginLeft: 10, background: "#e04b4b" }}
          >
            ⏹ Stop & Send
          </button>

          <button
            onClick={cancelRecording}
            disabled={!recording}
            style={{ ...styles.ghostButton, marginLeft: 10 }}
          >
            ✖ Cancel
          </button>

          <div style={{ marginLeft: "auto", color: "#444" }}>
            {recording ? <strong style={{ color: "#d44" }}>● Recording {fmt(seconds)}</strong> : <span>{status || "Ready"}</span>}
          </div>
        </div>

        <div style={styles.row}>
          <label style={styles.label}>Keywords (optional, comma separated)</label>
          <input
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="e.g. kubernetes, docker"
            style={styles.input}
            disabled={recording}
          />
        </div>

        {error && <div style={styles.errorBox}>{error}</div>}

        {/* Output area */}
        <div style={styles.output}>
          {!analysis && <div style={{ color: "#666" }}>No analysis yet — record and send.</div>}

          {analysis && (
            <div>
              {/* Transcript */}
              {analysis.transcript && (
                <div style={styles.section}>
                  <h3 style={styles.sectionTitle}>Transcript</h3>
                  <div style={styles.transcript}>{analysis.transcript}</div>
                </div>
              )}

              {/* Scores */}
              {analysis.scores && (
                <div style={styles.section}>
                  <h3 style={styles.sectionTitle}>Scores</h3>
                  <div style={styles.grid}>
                    <div style={styles.scoreCard}>
                      <div style={styles.scoreLabel}>Overall</div>
                      <div style={styles.scoreValue}>{analysis.scores.overall_score ?? analysis.scores.overall ?? "—"}</div>
                    </div>
                    <div style={styles.scoreCard}>
                      <div style={styles.scoreLabel}>Fluency</div>
                      <div style={styles.scoreValue}>{analysis.scores.fluency ?? analysis.scores.fluency_component ?? "—"}</div>
                    </div>
                    <div style={styles.scoreCard}>
                      <div style={styles.scoreLabel}>Confidence</div>
                      <div style={styles.scoreValue}>{analysis.scores.confidence ?? analysis.scores.confidence_component ?? "—"}</div>
                    </div>
                    <div style={styles.scoreCard}>
                      <div style={styles.scoreLabel}>Filler</div>
                      <div style={styles.scoreValue}>{analysis.scores.filler ?? analysis.scores.filler_component ?? "—"}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Counts */}
              {analysis.counts && (
                <div style={styles.section}>
                  <h3 style={styles.sectionTitle}>Counts</h3>
                  <div style={styles.smallGrid}>
                    <div><strong>Total words:</strong> {analysis.counts.total_words ?? "—"}</div>
                    <div><strong>Total fillers:</strong> {analysis.counts.total_fillers ?? "—"}</div>
                    <div><strong>Long pauses:</strong> {analysis.counts.long_pauses ?? "—"}</div>
                  </div>
                </div>
              )}

              {/* Suggestions */}
              {analysis.suggestions && analysis.suggestions.length > 0 && (
                <div style={styles.section}>
                  <h3 style={styles.sectionTitle}>Suggestions</h3>
                  <ul>
                    {analysis.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}

              {/* Raw text / fallback */}
              {analysis.error && (
                <div style={styles.section}>
                  <h3 style={styles.sectionTitle}>Raw / Error</h3>
                  <pre style={styles.rawBox}>{JSON.stringify(analysis.error, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={styles.footer}>
          Tip: use a quiet room or headset for best transcription accuracy.
        </div>
      </div>
    </div>
  );
}

// Inline styles (small and easy to tweak)
const styles = {
  page: {
  width : "100%",
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",   // center horizontally & vertically
  background: "#eef1f6",
  padding: "24px",
  boxSizing: "border-box",
},

card: {
  width: "calc(100% - 48px)",
  maxWidth: "1400px",
  margin: "0 auto",              // center the card horizontally
  background: "#ffffff",
  borderRadius: 14,
  padding: 22,
  boxShadow: "0 8px 32px rgba(0,0,0,0.08)",
  color: "#0f172a",
  boxSizing: "border-box",       // include padding in computed width
},

  title: {
    margin: 0,
    fontSize: "22px",
    textAlign: "center",
    color: "#0f172a",
  },

  subtitle: {
    marginTop: 8,
    color: "#334155",
    textAlign: "center",
    marginBottom: 16,
    fontSize: "14px",
  },

  controls: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap", // ← responsive
    gap: 10,
    marginBottom: 12,
  },

  button: {
    padding: "10px 14px",
    color: "#fff",
    background: "#2563eb", // high contrast blue
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "15px",
    flexShrink: 0,
  },

  ghostButton: {
    padding: "8px 12px",
    background: "#e5e7eb",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontWeight: 600,
    color: "#0f172a",
    flexShrink: 0,
  },

  row: {
    display: "flex",
    flexDirection: "column", // ← mobile-first
    gap: 6,
    marginBottom: 14,
  },

  label: {
    color: "#0f172a",
    fontSize: "14px",
  },

  input: {
    padding: 10,
    borderRadius: 8,
    border: "1px solid #cbd5e1",
    fontSize: "15px",
    color: "#0f172a",
    width: "100%", // full width on mobile
  },

  errorBox: {
    marginTop: 8,
    padding: 10,
    background: "#fee2e2",
    color: "#b91c1c",
    borderRadius: 8,
    border: "1px solid #fecaca",
  },

  output: {
    marginTop: 18,
    padding: 16,
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    background: "#f8fafc",
    color: "#0f172a",
  },

  section: { marginBottom: 14 },

  sectionTitle: {
    margin: "0 0 6px 0",
    color: "#0f172a",
    fontSize: "16px",
    fontWeight: 600,
  },

  transcript: {
    background: "#ffffff",
    padding: 12,
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    fontStyle: "italic",
    color: "#1e293b",
    lineHeight: 1.5,
  },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", // ← responsive magic
    gap: 12,
  },

  scoreCard: {
    padding: 12,
    borderRadius: 8,
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    textAlign: "center",
    color: "#0f172a",
  },

  scoreLabel: {
    color: "#64748b",
    fontSize: 13,
  },

  scoreValue: {
    fontSize: 20,
    fontWeight: 700,
    marginTop: 6,
    color: "#2563eb",
  },

  smallGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", // ← responsive
    gap: 10,
    color: "#0f172a",
  },

  rawBox: {
    background: "#0f172a",
    color: "#d1fae5",
    padding: 12,
    borderRadius: 8,
    overflow: "auto",
    fontSize: 12,
  },

  footer: {
    marginTop: 14,
    color: "#475569",
    fontSize: 13,
    textAlign: "center",
  },
};
ReactDOM.createRoot(document.getElementById("root")).render(<App />);

export default App;