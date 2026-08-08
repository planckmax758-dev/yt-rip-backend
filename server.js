const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const archiver = require("archiver");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;
const TEMP_DIR = path.join(os.tmpdir(), "yt-rip-files");
const TTL_MS = 30 * 60 * 1000;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Explicit CORS (required for browser clients on other domains) ─────────────
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // handle preflight for ALL routes
app.use(express.json());

// ── Job store ─────────────────────────────────────────────────────────────────
const jobs = new Map();

function scheduleCleanup(jobId) {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job?.filePath && fs.existsSync(job.filePath)) {
      try { fs.unlinkSync(job.filePath); } catch (_) {}
    }
    jobs.delete(jobId);
    console.log(`[cleanup] ${jobId} removed`);
  }, TTL_MS);
}

function convertAudio(jobId, url, bitrate) {
  const job = jobs.get(jobId);
  if (!job) return;
  const isLossless = bitrate === "1411";
  const ext = isLossless ? "flac" : "mp3";
  const outTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);
  const args = [
    url, "-x",
    "--audio-format", ext,
    "--audio-quality", "0",
    "--no-playlist", "--no-warnings", "--progress", "--newline",
    "-o", outTemplate,
  ];
  if (!isLossless) args.push("--postprocessor-args", "ffmpeg:-b:a 320k");
  job.status = "converting";
  console.log(`[convert] ${jobId} -> ${ext}`);
  const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => {
    const m = chunk.toString().match(/\[download\]\s+(\d+\.?\d*)%/);
    if (m) job.progress = Math.min(90, Math.round(parseFloat(m[1]) * 0.9));
  });
  proc.stderr.on("data", (c) => console.error("[yt-dlp]", c.toString().trim()));
  proc.on("close", (code) => {
    if (code !== 0) {
      job.status = "error";
      job.error = "Conversion failed — video may be private, age-restricted, or geo-blocked.";
      return;
    }
    const finalPath = path.join(TEMP_DIR, `${jobId}.${ext}`);
    if (fs.existsSync(finalPath)) {
      job.filePath = finalPath; job.ext = ext; job.status = "ready"; job.progress = 100;
      console.log(`[done] ${jobId}`);
    } else {
      job.status = "error"; job.error = "Output file missing after conversion.";
    }
  });
  proc.on("error", (err) => {
    job.status = "error";
    job.error = `yt-dlp failed: ${err.message}`;
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ ok: true, jobs: jobs.size }));

app.post("/api/convert", (req, res) => {
  const { url, bitrate = "320", jobId } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  if (!jobId) return res.status(400).json({ error: "jobId required" });
  if (jobs.has(jobId)) return res.status(409).json({ error: "Job exists" });
  jobs.set(jobId, { status: "queued", progress: 0, filePath: null, ext: null, error: null, createdAt: Date.now() });
  scheduleCleanup(jobId);
  res.json({ jobId, status: "queued" });
  setImmediate(() => convertAudio(jobId, url, bitrate));
});

app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json({ status: job.status, progress: job.progress, error: job.error || null });
});

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "ready") return res.status(404).json({ error: "Not ready" });
  if (!fs.existsSync(job.filePath)) return res.status(404).json({ error: "File missing" });
  const ext = job.ext || "mp3";
  res.setHeader("Content-Type", ext === "flac" ? "audio/flac" : "audio/mpeg");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.${ext}"`);
  fs.createReadStream(job.filePath).pipe(res);
});

app.post("/api/download-zip", (req, res) => {
  const { jobIds } = req.body;
  if (!Array.isArray(jobIds) || !jobIds.length) return res.status(400).json({ error: "jobIds required" });
  const available = jobIds.map(id => ({ id, job: jobs.get(id) }))
    .filter(({ job }) => job?.status === "ready" && job.filePath && fs.existsSync(job.filePath));
  if (!available.length) return res.status(400).json({ error: "No ready files" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="yt-audio.zip"');
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (e) => { console.error(e); res.end(); });
  archive.pipe(res);
  for (const { id, job } of available) archive.file(job.filePath, { name: `${id}.${job.ext || "mp3"}` });
  archive.finalize();
});

app.listen(PORT, () => {
  console.log(`\n🎵 YT Rip → http://localhost:${PORT}`);
  console.log(`📁 Temp  → ${TEMP_DIR}\n`);
});
