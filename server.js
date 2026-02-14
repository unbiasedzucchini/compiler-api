const express = require("express");
const { execFile } = require("child_process");
const { writeFile, readFile, mkdir, rm } = require("fs/promises");
const { randomUUID } = require("crypto");
const path = require("path");
const os = require("os");
const store = require("./db");
const { validate } = require("./validate");

const app = express();
const PORT = 8000;

app.use("/compile", express.text({ type: "*/*", limit: "1mb" }));
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

app.head("/blob/:ref", (req, res) => {
  const resolved = store.resolveRef(req.params.ref);
  if (!resolved) return res.status(404).end();
  const size = store.blobSize(resolved.hash);
  if (size === null) return res.status(404).end();
  res.set("Content-Type", "application/octet-stream");
  res.set("Content-Length", String(size));
  res.set("Cache-Control", "public, immutable, max-age=31536000");
  if (resolved.alias) res.set("X-Resolved-Hash", resolved.hash);
  res.status(200).end();
});

app.get("/blob/:ref", (req, res) => {
  const resolved = store.resolveRef(req.params.ref);
  if (!resolved) return res.status(404).json({ error: "Not found" });
  const data = store.getBlob(resolved.hash);
  if (!data) return res.status(404).json({ error: "Not found" });
  res.set("Content-Type", "application/octet-stream");
  res.set("Cache-Control", "public, immutable, max-age=31536000");
  if (resolved.alias) res.set("X-Resolved-Hash", resolved.hash);
  res.send(data);
});

app.get("/events", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  res.json(store.recentEvents(limit));
});

app.post("/validate", express.raw({ type: "*/*", limit: "4mb" }), (req, res) => {
  if (!Buffer.isBuffer(req.body)) req.body = Buffer.from(req.body);
  const result = validate(req.body);
  res.json(result);
});

// --- aliases ---

app.get("/aliases", (_req, res) => {
  res.json(store.listAliases());
});

app.get("/alias/:name", (req, res) => {
  const alias = store.getAlias(req.params.name);
  if (!alias) return res.status(404).json({ error: "Alias not found" });
  res.json(alias);
});

app.put("/alias/:name", express.json(), (req, res) => {
  const { hash } = req.body || {};
  if (!hash) return res.status(400).json({ error: "Missing hash in body" });
  const result = store.setAlias(req.params.name, hash);
  if (!result) return res.status(400).json({ error: "Blob not found for hash" });
  store.recordEvent({ type: "alias", alias: req.params.name, outputHash: hash, success: true });
  res.json(result);
});

app.delete("/alias/:name", (req, res) => {
  const alias = store.getAlias(req.params.name);
  const deleted = store.deleteAlias(req.params.name);
  if (!deleted) return res.status(404).json({ error: "Alias not found" });
  store.recordEvent({ type: "alias", alias: req.params.name, outputHash: alias.hash, success: true });
  res.json({ deleted: req.params.name });
});

// --- execution ---

const INPUT_PTR = 0;
const OUTPUT_PTR = 65536;
const MAX_OUTPUT = 65536;

async function executeModule(wasmBytes, inputBytes) {
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module);
  const { memory, run, _initialize } = instance.exports;

  if (!run) throw new Error("Module does not export 'run'");
  if (!memory) throw new Error("Module does not export 'memory'");

  if (_initialize) _initialize();

  const needed = Math.ceil((OUTPUT_PTR + MAX_OUTPUT) / 65536);
  const current = memory.buffer.byteLength / 65536;
  if (current < needed) memory.grow(needed - current);

  const mem = new Uint8Array(memory.buffer);
  mem.set(inputBytes, INPUT_PTR);

  const outputLen = run(INPUT_PTR, inputBytes.length, OUTPUT_PTR);

  const outMem = new Uint8Array(memory.buffer);
  return Buffer.from(outMem.slice(OUTPUT_PTR, OUTPUT_PTR + outputLen));
}

app.post("/run/:ref", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  // Resolve module
  const moduleResolved = store.resolveRef(req.params.ref);
  if (!moduleResolved) return res.status(404).json({ error: `Module not found: ${req.params.ref}` });

  if (moduleResolved.alias) {
    store.recordEvent({ type: "resolve", alias: moduleResolved.alias, outputHash: moduleResolved.hash, success: true });
  }

  const moduleHash = moduleResolved.hash;
  const wasmBytes = store.getBlob(moduleHash);
  if (!wasmBytes) return res.status(404).json({ error: "Module blob not found" });

  // Resolve input: query param or body
  let inputBytes;
  let inputHash;
  const inputRef = req.query.input;
  if (inputRef) {
    const inputResolved = store.resolveRef(inputRef);
    if (!inputResolved) return res.status(404).json({ error: `Input not found: ${inputRef}` });
    if (inputResolved.alias) {
      store.recordEvent({ type: "resolve", alias: inputResolved.alias, outputHash: inputResolved.hash, success: true });
    }
    inputBytes = store.getBlob(inputResolved.hash);
    inputHash = inputResolved.hash;
    if (!inputBytes) return res.status(404).json({ error: "Input blob not found" });
  } else {
    inputBytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    inputHash = store.putBlob(inputBytes);
  }

  const t0 = Date.now();
  try {
    const output = await executeModule(wasmBytes, inputBytes);
    const durationMs = Date.now() - t0;
    const outputHash = store.putBlob(output);

    store.recordEvent({
      type: "execute",
      moduleHash,
      inputHash,
      outputHash,
      outputSize: output.length,
      durationMs,
      success: true,
    });

    console.log(`[run] ${moduleHash.slice(0, 12)} input=${inputHash.slice(0, 12)} output=${outputHash.slice(0, 12)} ${output.length}B ${durationMs}ms`);
    res.set("Content-Type", "application/octet-stream");
    res.set("X-Module-Hash", moduleHash);
    res.set("X-Input-Hash", inputHash);
    res.set("X-Output-Hash", outputHash);
    res.send(output);
  } catch (err) {
    const durationMs = Date.now() - t0;
    store.recordEvent({
      type: "execute",
      moduleHash,
      inputHash,
      durationMs,
      success: false,
      error: err.message,
    });
    console.error(`[run] error: ${err.message}`);
    res.status(400).json({ error: "Execution failed", message: err.message });
  }
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
    const validation = validate(wasm);

    store.recordEvent({
      type: "compile",
      language: lang,
      inputHash,
      outputHash,
      outputSize: wasm.length,
      durationMs: compileTimeMs,
      success: true,
    });

    console.log(`[${lang}] success — ${wasm.length} bytes (${compileTimeMs}ms) contract=${validation.valid ? 'ok' : 'FAIL'}`);
    res.set("Content-Type", "application/wasm");
    res.set("X-Input-Hash", inputHash);
    res.set("X-Output-Hash", outputHash);
    res.set("X-Contract-Valid", validation.valid ? "true" : "false");
    if (!validation.valid) {
      res.set("X-Contract-Errors", JSON.stringify(validation.errors));
    }
    if (validation.warnings.length) {
      res.set("X-Contract-Warnings", JSON.stringify(validation.warnings));
    }
    res.send(wasm);
  } catch (err) {
    const compileTimeMs = Date.now() - t0;
    const errorMsg = err.stderr || err.message;

    store.recordEvent({
      type: "compile",
      language: lang,
      inputHash,
      durationMs: compileTimeMs,
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
