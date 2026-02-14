const express = require("express");
const { execFile } = require("child_process");
const { writeFile, readFile, mkdir, rm } = require("fs/promises");
const { randomUUID } = require("crypto");
const path = require("path");
const os = require("os");

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

  async grain(source, dir) {
    const input = path.join(dir, "input.gr");
    const output = path.join(dir, "input.wasm");
    await writeFile(input, source);
    await exec("grain", [
      "compile",
      "--no-gc",
      "--elide-type-info",
      "--release",
      input,
    ]);
    return readFile(output);
  },
};

// --- routes ---

app.get("/languages", (_req, res) => {
  res.json(Object.keys(compilers));
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

  let dir;
  try {
    dir = await tmpDir();
    console.log(`[${lang}] compiling in ${dir}`);
    const wasm = await compiler(source, dir);
    console.log(`[${lang}] success — ${wasm.length} bytes`);
    res.set("Content-Type", "application/wasm");
    res.send(wasm);
  } catch (err) {
    console.error(`[${lang}] error:`, err.message);
    res.status(400).json({
      error: "Compilation failed",
      stderr: err.stderr || err.message,
      stdout: err.stdout || "",
    });
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`Compiler API listening on http://localhost:${PORT}`);
});
