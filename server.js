const express = require("express");
const { execFile } = require("child_process");
const { writeFile, readFile, mkdir, rm } = require("fs/promises");
const { randomUUID } = require("crypto");
const path = require("path");
const os = require("os");
const store = require("./db");

const app = express();
const PORT = 8000;

app.use(express.text({ type: "*/*", limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- helpers ---

function tmpDir() {
  const dir = path.join(os.tmpdir(), `compile-${randomUUID()}`);
  return mkdir(dir, { recursive: true }).then(() => dir);
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(stderr || stdout || err.message);
        e.stdout = stdout;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

// --- compilers ---

const compilers = {
  async assemblyscript(source, dir) {
    const input = path.join(dir, "input.ts");
    const output = path.join(dir, "output.wasm");
    await writeFile(input, source);
    const ascBin = path.join(__dirname, "node_modules", ".bin", "asc");
    await exec(ascBin, [
      input, "-o", output,
      "--optimize",
      "--runtime", "stub",
    ]);
    return readFile(output);
  },

  async tinygo(source, dir) {
    const input = path.join(dir, "main.go");
    const output = path.join(dir, "output.wasm");
    await writeFile(input, source);
    await exec("tinygo", [
      "build",
      "-o", output,
      "-target=wasm-unknown",
      "-no-debug",
      "-gc=leaking",
      "-scheduler=none",
      input,
    ]);
    return readFile(output);
  },

  async zig(source, dir) {
    const input = path.join(dir, "input.zig");
    const output = path.join(dir, "input.wasm");
    await writeFile(input, source);
    await exec("zig", [
      "build-exe",
      "-target", "wasm32-freestanding",
      "-fno-entry",
      "-O", "ReleaseSmall",
      "-rdynamic",
      "--cache-dir", path.join(dir, "cache"),
      "--global-cache-dir", path.join(dir, "gcache"),
      input,
    ], { cwd: dir });
    return readFile(output);
  },

};

// --- routes ---

app.get("/languages", (_req, res) => {
  res.json(Object.keys(compilers));
});

app.head("/blob/:hash", (req, res) => {
  const size = store.blobSize(req.params.hash);
  if (size === null) return res.status(404).end();
  res.set("Content-Type", "application/octet-stream");
  res.set("Content-Length", String(size));
  res.set("Cache-Control", "public, immutable, max-age=31536000");
  res.status(200).end();
});

app.get("/blob/:hash", (req, res) => {
  const data = store.getBlob(req.params.hash);
  if (!data) return res.status(404).json({ error: "Not found" });
  res.set("Content-Type", "application/octet-stream");
  res.set("Cache-Control", "public, immutable, max-age=31536000");
  res.send(data);
});

app.get("/events", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  res.json(store.recentEvents(limit));
});

app.get("/stats", (_req, res) => {
  res.json(store.stats());
});

app.post("/compile/:language", async (req, res) => {
  const lang = req.params.language;
  const compiler = compilers[lang];
  if (!compiler) {
    return res.status(400).json({ error: `Unknown language: ${lang}. Supported: ${Object.keys(compilers).join(", ")}` });
  }

  const source = req.body;
  if (!source || typeof source !== "string") {
    return res.status(400).json({ error: "Request body must contain source code" });
  }

  const inputHash = store.putBlob(source);
  const t0 = Date.now();
  let dir;
  try {
    dir = await tmpDir();
    console.log(`[${lang}] compiling ${inputHash.slice(0, 12)} in ${dir}`);
    const wasm = await compiler(source, dir);
    const compileTimeMs = Date.now() - t0;
    const outputHash = store.putBlob(wasm);

    store.recordEvent({
      language: lang,
      inputHash,
      outputHash,
      outputSize: wasm.length,
      compileTimeMs,
      success: true,
    });

    console.log(`[${lang}] success — ${wasm.length} bytes (${compileTimeMs}ms)`);
    res.set("Content-Type", "application/wasm");
    res.set("X-Input-Hash", inputHash);
    res.set("X-Output-Hash", outputHash);
    res.send(wasm);
  } catch (err) {
    const compileTimeMs = Date.now() - t0;
    const errorMsg = err.stderr || err.message;

    store.recordEvent({
      language: lang,
      inputHash,
      compileTimeMs,
      success: false,
      error: errorMsg,
    });

    console.error(`[${lang}] error (${compileTimeMs}ms):`, err.message);
    res.status(400).json({
      error: "Compilation failed",
      stderr: errorMsg,
      stdout: err.stdout || "",
    });
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`Compiler API listening on http://localhost:${PORT}`);
});
