// READ2ME (Piper TTS) — read the active editor aloud with offline
// Piper synthesis, highlighting the current sentence and sweeping the current
// word as it is spoken, with status-bar transport controls (play / pause / stop
// / speed).
//
// Architecture: a persistent Python process (tts_server.py) loads the voice once
// and synthesizes one sentence at a time to a temp WAV, returning the WAV's exact
// duration. This extension splits the document into sentences (tracking their
// source ranges), plays each WAV with macOS `afplay`, highlights the sentence,
// and distributes the sentence's exact audio duration across its words to sweep a
// word highlight. (lessac-high exposes no true word alignments, so within-sentence
// word timing is estimated proportionally; sentence boundaries are exact.)

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// macOS / Linux only: spawn a one-shot player process.
function spawnAudioPlayer(wavPath) {
  if (process.platform === "darwin") return cp.spawn("afplay", [wavPath]);
  return cp.spawn("aplay", [wavPath]);
}

// Kill any stray audio processes (macOS/Linux safety net — Windows handled via PersistentAudioPlayer).
function killStrayPlayers() {
  try {
    if (process.platform === "darwin") cp.spawn("pkill", ["-x", "afplay"]);
    else if (process.platform !== "win32") cp.spawn("pkill", ["-x", "aplay"]);
  } catch (_) {}
}

// Windows: persistent PowerShell audio player.
// Keeps one PS process alive across sentences to avoid the ~500ms per-sentence startup cost.
// Signals "playing\n" on stdout right before PlaySync() starts so callers can begin
// word-sweep timers at the exact moment audio begins.
class PersistentAudioPlayer {
  constructor() {
    this._proc = null;
    this._buf = "";
    this._onPlaying = null;
    this._onDone = null;
  }

  start() {
    const script =
      "$ErrorActionPreference='SilentlyContinue';" +
      "while($true){" +
        "$p=[Console]::ReadLine();" +
        "if($null -eq $p){break};" +
        "$p=$p.Trim();" +
        "if($p -eq ''){continue};" +
        "try{$sp=New-Object System.Media.SoundPlayer([string]$p);" +
          "$sp.Load();" +
          "[Console]::WriteLine('playing');[Console]::Out.Flush();" +
          "$sp.PlaySync()}catch{};" +
        "[Console]::WriteLine('done');[Console]::Out.Flush()" +
      "}";
    return new Promise((resolve, reject) => {
      this._proc = cp.spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      this._proc.stdout.setEncoding("utf8");
      this._proc.stdout.on("data", (d) => {
        this._buf += d;
        let idx;
        while ((idx = this._buf.indexOf("\n")) >= 0) {
          const line = this._buf.slice(0, idx).trim();
          this._buf = this._buf.slice(idx + 1);
          if (line === "playing") { const fn = this._onPlaying; this._onPlaying = null; if (fn) fn(); }
          else if (line === "done") { const fn = this._onDone; this._onDone = null; if (fn) fn(); }
        }
      });
      this._proc.on("exit", () => {
        this._proc = null;
        const pd = this._onDone; this._onDone = null; if (pd) pd();
        const pp = this._onPlaying; this._onPlaying = null; if (pp) pp();
      });
      this._proc.on("spawn", resolve);
      this._proc.on("error", (e) => { this._proc = null; reject(e); });
    });
  }

  // Sends wavPath to the persistent process. Calls onStarted() when audio begins,
  // onDone() when it ends. Returns false if process isn't running (caller falls back).
  play(wavPath, onStarted, onDone) {
    if (!this._proc || this._proc.killed) return false;
    this._onPlaying = onStarted;
    this._onDone = onDone;
    this._proc.stdin.write(wavPath + "\n");
    return true;
  }

  get proc() { return this._proc; }

  dispose() {
    const p = this._proc;
    this._proc = null;
    const pd = this._onDone; this._onDone = null; if (pd) pd();
    const pp = this._onPlaying; this._onPlaying = null; if (pp) pp();
    if (p) { try { p.stdin.end(); } catch (_) {} try { p.kill("SIGTERM"); } catch (_) {} }
  }
}

let wordDeco = null;
let sentDeco = null;
// Status-bar transport buttons.
let playItem = null;
let pauseItem = null;
let stopItem = null;
let speedDownItem = null;
let speedLabelItem = null;
let speedUpItem = null;
let voiceItem = null;
// Currently selected voice {label, model, config} (persisted), or null = default.
let activeVoice = null;
let extContext = null;
// Last focused text editor — used to find the source doc when invoked from the
// Markdown PREVIEW (a webview, where activeTextEditor is null).
let lastTextEditor = null;
// Speed multiplier (persisted), stepped by the −/+ buttons.
const SPEED_MIN = 0.5;
const SPEED_MAX = 3.0;
const SPEED_STEP = 0.25;
let speedMul = 1.0;
// Active playback state (null when stopped).
//   { server, editor, doc, segments, index, status, baseRate,
//     afplay, timers, prefetch, restart }
let pb = null;

// --------------------------------------------------------------------------- //
// Config / path resolution                                                    //
// --------------------------------------------------------------------------- //

function resolvePaths() {
  const cfg = vscode.workspace.getConfiguration("read2me");
  const folders = vscode.workspace.workspaceFolders;
  const root = folders && folders.length ? folders[0].uri.fsPath : process.cwd();
  const abs = (val, def) => {
    let p = val && String(val).trim() ? String(val) : def;
    return path.isAbsolute(p) ? p : path.join(root, p);
  };
  return {
    python: abs(cfg.get("pythonPath"), ".tts-venv/bin/python"),
    server: abs(cfg.get("serverScript"), "tts_server.py"),
    model: abs(cfg.get("model"), "tts-voices/en_US-lessac-high.onnx"),
    config: abs(cfg.get("config"), "tts-voices/en_US-lessac-high.onnx.json"),
    rate: Number(cfg.get("rate")) || 1.0,
    wordColor: cfg.get("wordHighlightColor") || "rgba(255,56,92,0.35)",
    sentColor: cfg.get("sentenceHighlightColor") || "rgba(255,56,92,0.12)",
  };
}

// --------------------------------------------------------------------------- //
// Text segmentation (sentences + word tokens, with source offsets)            //
// --------------------------------------------------------------------------- //

// Char ranges [start,end) of fenced code blocks, so we never read code aloud.
function fenceRanges(text) {
  const ranges = [];
  const lines = text.split("\n");
  let offset = 0;
  let inFence = false;
  let fenceStart = 0;
  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceStart = lineStart;
      } else {
        inFence = false;
        ranges.push([fenceStart, lineEnd + 1]);
      }
    }
    offset = lineEnd + 1; // + newline
  }
  if (inFence) ranges.push([fenceStart, text.length]);
  return ranges;
}

// Split into sentence-ish segments with absolute document offsets.
function splitSentences(text, base) {
  const segs = [];
  const boundary = /([.!?…]+["')\]]?\s+|\n+)/g;
  let last = 0;
  let m;
  while ((m = boundary.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (text.slice(last, end).trim()) segs.push({ start: base + last, end: base + end });
    last = end;
  }
  if (last < text.length && text.slice(last).trim()) {
    segs.push({ start: base + last, end: base + text.length });
  }
  return segs;
}

// Strip Markdown noise so we don't speak "star star" / pound signs / URLs.
function cleanForSpeech(raw) {
  let s = raw;
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // images -> alt
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links  -> text
  s = s.replace(/`{1,3}/g, " "); // inline code ticks
  s = s.replace(/^#{1,6}\s*/gm, ""); // headings
  s = s.replace(/^\s{0,3}>\s?/gm, ""); // blockquotes
  s = s.replace(/^\s*[-*+]\s+/gm, ""); // bullets
  s = s.replace(/^\s*\d+\.\s+/gm, ""); // numbered lists
  s = s.replace(/[*_~]+/g, ""); // emphasis marks
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Word tokens within a segment, each with a document Range + a duration weight.
function wordTokens(doc, startOffset, endOffset) {
  const raw = doc.getText(new vscode.Range(doc.positionAt(startOffset), doc.positionAt(endOffset)));
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const s = startOffset + m.index;
    const e = s + m[0].length;
    const letters = m[0].replace(/[^\p{L}\p{N}]/gu, "").length;
    tokens.push({
      range: new vscode.Range(doc.positionAt(s), doc.positionAt(e)),
      weight: Math.max(1, letters || m[0].length),
    });
  }
  return tokens;
}

function buildSegments(doc, selection) {
  const sel = selection && !selection.isEmpty ? selection : null;
  const base = sel ? doc.offsetAt(sel.start) : 0;
  const analyzed = sel ? doc.getText(sel) : doc.getText();

  const fences = fenceRanges(analyzed).map(([s, e]) => [s + base, e + base]);
  const inFence = (off) => fences.some(([s, e]) => off >= s && off < e);

  const out = [];
  for (const seg of splitSentences(analyzed, base)) {
    if (inFence(seg.start)) continue;
    const rawText = doc.getText(new vscode.Range(doc.positionAt(seg.start), doc.positionAt(seg.end)));
    const spoken = cleanForSpeech(rawText);
    if (!spoken) continue;
    out.push({
      range: new vscode.Range(doc.positionAt(seg.start), doc.positionAt(seg.end)),
      startOffset: seg.start,
      endOffset: seg.end,
      spoken,
      tokens: wordTokens(doc, seg.start, seg.end),
    });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Persistent synth server client                                             //
// --------------------------------------------------------------------------- //

class SynthServer {
  constructor(paths) {
    this.paths = paths;
    this.proc = null;
    this.buf = "";
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      const p = cp.spawn(this.paths.python, [this.paths.server, this.paths.model, this.paths.config], {
        cwd: path.dirname(this.paths.server),
      });
      this.proc = p;
      let settled = false;
      let stderr = "";
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (d) => {
        this.buf += d;
        let idx;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (_) {
            continue;
          }
          if (msg.ready !== undefined) {
            if (msg.ready && !settled) {
              settled = true;
              resolve();
            } else if (!msg.ready && !settled) {
              settled = true;
              reject(new Error(msg.error || "voice failed to load"));
            }
            continue;
          }
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { res, rej, out } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.ok) res({ duration: msg.duration, out });
            else rej(new Error(msg.error || "synthesis failed"));
          }
        }
      });
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
      p.on("exit", (code) => {
        for (const { rej } of this.pending.values()) rej(new Error("synth server exited"));
        this.pending.clear();
        if (!settled) {
          settled = true;
          reject(new Error(`synth server exited (code ${code}): ${stderr.slice(0, 300)}`));
        }
      });
    });
  }

  synth(text, rate) {
    return new Promise((res, rej) => {
      if (!this.proc || this.proc.killed) return rej(new Error("synth server not running"));
      const id = this.nextId++;
      const out = path.join(os.tmpdir(), `read2me_tts_${process.pid}_${id}.wav`);
      this.pending.set(id, { res, rej, out });
      this.proc.stdin.write(JSON.stringify({ id, text, out, rate }) + "\n");
    });
  }

  dispose() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch (_) {}
      try {
        this.proc.kill("SIGTERM");
      } catch (_) {}
      this.proc = null;
    }
  }
}

// --------------------------------------------------------------------------- //
// Small helpers                                                               //
// --------------------------------------------------------------------------- //

function tryUnlink(p) {
  try {
    if (p) fs.unlinkSync(p);
  } catch (_) {}
}

function clearTimers(state) {
  if (!state) return;
  for (const t of state.timers) clearTimeout(t);
  state.timers = [];
}

function clearDecorations(editor) {
  if (!editor) return;
  try {
    editor.setDecorations(wordDeco, []);
    editor.setDecorations(sentDeco, []);
  } catch (_) {}
}

function effRate() {
  const base = pb ? pb.baseRate : resolvePaths().rate;
  return base * speedMul;
}

// --------------------------------------------------------------------------- //
// Voice discovery / selection                                                 //
// --------------------------------------------------------------------------- //

function voicesDir() {
  const cfg = vscode.workspace.getConfiguration("read2me");
  const folders = vscode.workspace.workspaceFolders;
  const root = folders && folders.length ? folders[0].uri.fsPath : process.cwd();
  const v = cfg.get("voicesDir") || "tts-voices";
  return path.isAbsolute(v) ? v : path.join(root, v);
}

// Every *.onnx in the voices dir that has a matching *.onnx.json sidecar.
function listVoices() {
  const dir = voicesDir();
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".onnx")) {
        const model = path.join(dir, f);
        const config = model + ".json";
        if (fs.existsSync(config)) out.push({ label: f.replace(/\.onnx$/, ""), model, config });
      }
    }
  } catch (_) {}
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function getActiveVoice() {
  if (activeVoice && fs.existsSync(activeVoice.model) && fs.existsSync(activeVoice.config)) {
    return activeVoice;
  }
  const paths = resolvePaths();
  return { label: path.basename(paths.model).replace(/\.onnx$/, ""), model: paths.model, config: paths.config };
}

function updateVoiceButton() {
  if (!voiceItem) return;
  const v = getActiveVoice();
  const speaker = v.label.split("-")[1] || v.label; // e.g. en_US-amy-medium -> "amy"
  voiceItem.text = `$(account) ${speaker}`;
  voiceItem.tooltip = `Voice: ${v.label} — click to change`;
  voiceItem.show();
}

async function selectVoice() {
  const voices = listVoices();
  if (!voices.length) {
    vscode.window.showWarningMessage(`READ2ME: no voices found in ${voicesDir()}.`);
    return;
  }
  const cur = getActiveVoice();
  const picks = voices.map((v) => ({
    label: v.label,
    description: v.label === cur.label ? "● current" : "",
    voice: v,
  }));
  const choice = await vscode.window.showQuickPick(picks, {
    placeHolder: "Select a Piper voice",
    matchOnDescription: true,
  });
  if (!choice) return;
  activeVoice = choice.voice;
  if (extContext) extContext.globalState.update("read2me.voice", activeVoice);
  updateVoiceButton();

  // Apply immediately: if reading, restart from the current sentence with the new voice.
  if (pb) {
    const idx = pb.index;
    const wasActive = pb.status === "playing" || pb.status === "paused";
    doStop();
    if (wasActive) startFresh({ index: idx });
  }
}

// --------------------------------------------------------------------------- //
// Status-bar buttons                                                          //
// --------------------------------------------------------------------------- //

function updateButtons() {
  const status = pb ? pb.status : "stopped";
  if (status === "playing") {
    playItem.hide();
    pauseItem.show();
    stopItem.show();
  } else if (status === "paused") {
    playItem.text = "$(play) Resume";
    playItem.show();
    pauseItem.hide();
    stopItem.show();
  } else {
    playItem.text = "$(play) Read";
    playItem.show();
    pauseItem.hide();
    stopItem.hide();
  }
}

function fmtSpeed(m) {
  return (Number.isInteger(m) ? m.toFixed(0) : String(m)) + "x";
}

function updateSpeedButtons() {
  if (!speedLabelItem) return;
  speedDownItem.text = "$(remove)";
  speedDownItem.tooltip = `Slower (−${SPEED_STEP})`;
  speedLabelItem.text = fmtSpeed(speedMul);
  speedLabelItem.tooltip = `Reading speed ${fmtSpeed(speedMul)} — click to reset to 1x`;
  speedUpItem.text = "$(add)";
  speedUpItem.tooltip = `Faster (+${SPEED_STEP})`;
  speedDownItem.show();
  speedLabelItem.show();
  speedUpItem.show();
}

function setSpeed(mul) {
  mul = Math.round(mul / SPEED_STEP) * SPEED_STEP;
  mul = Math.max(SPEED_MIN, Math.min(SPEED_MAX, mul));
  if (mul === speedMul) return;
  speedMul = mul;
  if (extContext) extContext.globalState.update("read2me.speed", speedMul);
  updateSpeedButtons();
  // Apply immediately: if reading, restart the current sentence at the new rate.
  if (pb && pb.status === "playing") {
    discardPrefetch();
    pb.restart = true;
    clearTimers(pb);
    if (pb.afplay) {
      try {
        pb.afplay.kill("SIGTERM");
      } catch (_) {}
      pb.afplay = null;
    }
  }
}

function doSpeedUp() {
  setSpeed(speedMul + SPEED_STEP);
}
function doSpeedDown() {
  setSpeed(speedMul - SPEED_STEP);
}
function doSpeedReset() {
  setSpeed(1.0);
}

// --------------------------------------------------------------------------- //
// Playback engine                                                             //
// --------------------------------------------------------------------------- //

function indexForCursor(segments, doc, editor) {
  if (!editor) return 0;
  const off = doc.offsetAt(editor.selection.active);
  for (let i = 0; i < segments.length; i++) {
    if (off < segments[i].endOffset) return i;
  }
  return 0;
}

function discardPrefetch() {
  if (pb && pb.prefetch) {
    const p = pb.prefetch.promise;
    pb.prefetch = null;
    p.then((r) => tryUnlink(r.out)).catch(() => {});
  }
}

function synthFor(i) {
  const seg = pb.segments[i];
  if (pb.prefetch && pb.prefetch.index === i) {
    const p = pb.prefetch.promise;
    pb.prefetch = null;
    return p;
  }
  return pb.server.synth(seg.spoken, effRate());
}

function prefetch(i) {
  if (!pb || i >= pb.segments.length) return;
  pb.prefetch = { index: i, promise: pb.server.synth(pb.segments[i].spoken, effRate()) };
}

// Play one sentence; resolves when its audio finishes (or is interrupted).
function playOne(seg, synthRes) {
  return new Promise((resolve) => {
    const cur = pb;
    if (!pb || pb.status !== "playing") return resolve();

    // Sentence highlight + scroll immediately for visual feedback before audio starts.
    if (pb.editor) {
      pb.editor.setDecorations(sentDeco, [seg.range]);
      pb.editor.revealRange(seg.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      if (pb === cur) { pb.afplay = null; clearTimers(cur); }
      resolve();
    };

    // Word-sweep timers start only when audio has actually begun playing.
    // This prevents the sweep from running ahead of audio on platforms with
    // high player-process startup latency (e.g. PowerShell on Windows).
    const startWordTimers = () => {
      if (!pb || pb !== cur || pb.status !== "playing" || !pb.editor) return;
      const total = seg.tokens.reduce((a, t) => a + t.weight, 0) || 1;
      let acc = 0;
      for (const tok of seg.tokens) {
        const atMs = Math.max(0, (acc / total) * synthRes.duration * 1000);
        const timer = setTimeout(() => {
          if (pb === cur && pb.status === "playing") pb.editor.setDecorations(wordDeco, [tok.range]);
        }, atMs);
        pb.timers.push(timer);
        acc += tok.weight;
      }
    };

    // Windows: use the persistent player — onStarted fires right before PlaySync().
    if (process.platform === "win32" && pb.audioPlayer) {
      const ok = pb.audioPlayer.play(synthRes.out, startWordTimers, done);
      if (ok) {
        pb.afplay = pb.audioPlayer.proc;
        return;
      }
    }

    // macOS / Linux (and Windows fallback if persistent player died).
    const af = spawnAudioPlayer(synthRes.out);
    pb.afplay = af;
    af.on("spawn", startWordTimers); // 'spawn' fires when process is running — near-instant on macOS
    af.on("exit", done);
    af.on("error", done);
  });
}

async function runLoop() {
  const cur = pb;
  while (pb === cur && pb.status === "playing" && pb.index < pb.segments.length) {
    const i = pb.index;
    const seg = pb.segments[i];

    let res;
    try {
      res = await synthFor(i);
    } catch (_) {
      pb.index = i + 1; // skip a sentence that failed to synthesize
      continue;
    }
    if (pb !== cur || pb.status !== "playing") {
      tryUnlink(res.out); // paused/stopped during synthesis
      return;
    }

    prefetch(i + 1); // synthesize the next sentence while this one plays
    await playOne(seg, res);
    tryUnlink(res.out);

    if (pb !== cur) return; // stopped
    if (pb.status !== "playing") return; // paused
    if (pb.restart) {
      pb.restart = false; // speed changed: replay this sentence, don't advance
      continue;
    }
    pb.index = i + 1;
  }

  if (pb === cur && pb.status === "playing") {
    doStop(); // finished the document
  }
}

function resolveTarget() {
  const active = vscode.window.activeTextEditor;
  if (active) {
    return { doc: active.document, editor: active, selection: active.selection };
  }
  if (lastTextEditor && !lastTextEditor.document.isClosed) {
    const doc = lastTextEditor.document;
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc) || null;
    if (!editor) {
      vscode.window.setStatusBarMessage(
        "READ2ME: reading the preview's source (audio only — open the source beside the preview for highlighting).",
        6000
      );
    }
    return { doc, editor, selection: undefined };
  }
  return null;
}

async function startFresh(opts) {
  opts = opts || {};
  const target = resolveTarget();
  if (!target) {
    vscode.window.showWarningMessage(
      "READ2ME: no source document found. Open the Markdown file in an editor first."
    );
    return;
  }

  const paths = resolvePaths();
  const voice = getActiveVoice();
  const required = { python: paths.python, server: paths.server, model: voice.model, config: voice.config };
  for (const [key, p] of Object.entries(required)) {
    if (!fs.existsSync(p)) {
      vscode.window.showErrorMessage(`READ2ME: ${key} not found at "${p}". Check Settings.`);
      return;
    }
  }

  const hasSel = target.editor && target.selection && !target.selection.isEmpty;
  const segments = buildSegments(target.doc, hasSel ? target.selection : undefined);
  if (!segments.length) {
    vscode.window.showInformationMessage("READ2ME: nothing speakable to read.");
    return;
  }
  let startIndex = hasSel ? 0 : indexForCursor(segments, target.doc, target.editor);
  if (opts.index != null) startIndex = Math.max(0, Math.min(opts.index, segments.length - 1));

  const server = new SynthServer(Object.assign({}, paths, { model: voice.model, config: voice.config }));
  const audioPlayer = process.platform === "win32" ? new PersistentAudioPlayer() : null;
  pb = {
    server,
    audioPlayer,
    editor: target.editor,
    doc: target.doc,
    segments,
    index: startIndex,
    status: "loading",
    baseRate: paths.rate,
    afplay: null,
    timers: [],
    prefetch: null,
    restart: false,
  };
  const cur = pb;

  // Start synth server and audio player in parallel so both are warm before the first sentence.
  if (audioPlayer) audioPlayer.start().catch(() => { if (pb === cur) pb.audioPlayer = null; });

  try {
    await server.start();
  } catch (e) {
    vscode.window.showErrorMessage("READ2ME: " + (e && e.message ? e.message : String(e)));
    doStop();
    return;
  }
  if (pb !== cur) return; // stopped while loading
  pb.status = "playing";
  updateButtons();
  runLoop();
}

// ---- transport commands -------------------------------------------------- //

function doPlay() {
  if (pb && pb.status === "playing") return; // already playing
  if (pb && pb.status === "paused") {
    pb.status = "playing";
    // Restart the Windows audio player (disposed on pause).
    if (process.platform === "win32" && !pb.audioPlayer) {
      const audioPlayer = new PersistentAudioPlayer();
      pb.audioPlayer = audioPlayer;
      audioPlayer.start().catch(() => { pb.audioPlayer = null; });
    }
    updateButtons();
    runLoop();
    return;
  }
  startFresh();
}

function doPause() {
  if (!pb || pb.status !== "playing") return;
  pb.status = "paused"; // runLoop will return without advancing the index
  clearTimers(pb);
  if (pb.audioPlayer) {
    pb.audioPlayer.dispose(); // kills PS process; restarted on resume
    pb.audioPlayer = null;
    pb.afplay = null;
  } else if (pb.afplay) {
    try { pb.afplay.kill("SIGTERM"); } catch (_) {}
    pb.afplay = null;
  }
  if (pb.editor) {
    try {
      pb.editor.setDecorations(wordDeco, []); // keep the sentence tint to mark position
    } catch (_) {}
  }
  updateButtons();
}

function doStop() {
  const s = pb;
  pb = null;
  if (s) {
    s.status = "stopped";
    clearTimers(s);
    if (s.audioPlayer) {
      s.audioPlayer.dispose();
    } else if (s.afplay) {
      try { s.afplay.kill("SIGTERM"); } catch (_) {}
    }
    if (s.prefetch) s.prefetch.promise.then((r) => tryUnlink(r.out)).catch(() => {});
    if (s.server) s.server.dispose();
    clearDecorations(s.editor);
  }
  killStrayPlayers();
  updateButtons();
}

// --------------------------------------------------------------------------- //
// Activation                                                                  //
// --------------------------------------------------------------------------- //

function activate(context) {
  const paths = resolvePaths();
  wordDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: paths.wordColor,
    borderRadius: "2px",
  });
  sentDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: paths.sentColor,
  });

  // Status-bar order (left→right): ▶/⏸  ⏹  −  1x  +  👤
  playItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 106);
  playItem.command = "read2me.play";
  playItem.tooltip = "Read aloud from the cursor (or resume)";
  pauseItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 106);
  pauseItem.text = "$(debug-pause) Pause";
  pauseItem.command = "read2me.pause";
  pauseItem.tooltip = "Pause (keeps position)";
  stopItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 105);
  stopItem.text = "$(debug-stop) Stop";
  stopItem.command = "read2me.stop";
  stopItem.tooltip = "Stop and reset to the start";
  speedDownItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104);
  speedDownItem.command = "read2me.speedDown";
  speedLabelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
  speedLabelItem.command = "read2me.speedReset";
  speedUpItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  speedUpItem.command = "read2me.speedUp";
  voiceItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  voiceItem.command = "read2me.selectVoice";

  extContext = context;
  const savedVoice = context.globalState.get("read2me.voice");
  if (savedVoice && savedVoice.model && fs.existsSync(savedVoice.model) && fs.existsSync(savedVoice.config)) {
    activeVoice = savedVoice;
  }
  const savedSpeed = Number(context.globalState.get("read2me.speed"));
  if (savedSpeed && savedSpeed >= SPEED_MIN && savedSpeed <= SPEED_MAX) speedMul = savedSpeed;

  lastTextEditor = vscode.window.activeTextEditor || null;
  updateButtons();
  updateSpeedButtons();
  updateVoiceButton();

  context.subscriptions.push(
    wordDeco,
    sentDeco,
    playItem,
    pauseItem,
    stopItem,
    speedDownItem,
    speedLabelItem,
    speedUpItem,
    voiceItem,
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) lastTextEditor = e;
    }),
    vscode.commands.registerCommand("read2me.play", () => doPlay()),
    vscode.commands.registerCommand("read2me.pause", () => doPause()),
    vscode.commands.registerCommand("read2me.stop", () => doStop()),
    vscode.commands.registerCommand("read2me.speedUp", () => doSpeedUp()),
    vscode.commands.registerCommand("read2me.speedDown", () => doSpeedDown()),
    vscode.commands.registerCommand("read2me.speedReset", () => doSpeedReset()),
    vscode.commands.registerCommand("read2me.selectVoice", () => selectVoice()),
    // Back-compat alias for the original command/keybinding.
    vscode.commands.registerCommand("read2me.readWithHighlight", () => doPlay())
  );
}

function deactivate() {
  doStop();
}

module.exports = { activate, deactivate };
