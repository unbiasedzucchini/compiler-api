#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");

const BASE = process.env.COMPILER_API_URL || "http://localhost:8000";

// --- http helpers ---

function request(method, urlPath, { body, raw } = {}) {
  const url = new URL(urlPath, BASE);
  return new Promise((resolve, reject) => {
    const headers = body ? { "Content-Type": "text/plain" } : {};
    const req = http.request(url, { method, headers }, (res) => {
      if (raw) return resolve(res);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function json(resp) {
  return JSON.parse(resp.body.toString());
}

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function readInput(fileArg) {
  if (!fileArg || fileArg === "-") return fs.readFileSync(0, "utf-8");
  return fs.readFileSync(path.resolve(fileArg), "utf-8");
}

// --- commands ---

const commands = {
  async compile(args) {
    const lang = args[0];
    const fileArg = args[1];
    const outArg = args.indexOf("-o") !== -1 ? args[args.indexOf("-o") + 1] : null;

    if (!lang) die("Usage: compile <language> [file|-] [-o output.wasm]");

    const source = readInput(fileArg);
    const resp = await request("POST", `/compile/${lang}`, { body: source });

    if (resp.status !== 200) {
      const err = JSON.parse(resp.body.toString());
      die(err.stderr || err.error);
    }

    const inputHash = resp.headers["x-input-hash"];
    const outputHash = resp.headers["x-output-hash"];
    const contractOk = resp.headers["x-contract-valid"] === "true";
    const contractErrors = resp.headers["x-contract-errors"];
    const contractWarnings = resp.headers["x-contract-warnings"];
    process.stderr.write(`${lang}: ${resp.body.length} bytes  input=${inputHash.slice(0, 12)}  output=${outputHash.slice(0, 12)}  contract=${contractOk ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}\n`);
    if (contractErrors) {
      for (const e of JSON.parse(contractErrors)) process.stderr.write(`  \x1b[31merror: ${e}\x1b[0m\n`);
    }
    if (contractWarnings) {
      for (const w of JSON.parse(contractWarnings)) process.stderr.write(`  \x1b[33mwarn: ${w}\x1b[0m\n`);
    }

    if (outArg) {
      fs.writeFileSync(outArg, resp.body);
      process.stderr.write(`wrote ${outArg}\n`);
    } else {
      process.stdout.write(resp.body);
    }
  },

  async blob(args) {
    const hash = args[0];
    const outArg = args.indexOf("-o") !== -1 ? args[args.indexOf("-o") + 1] : null;
    if (!hash) die("Usage: blob <hash> [-o output]");

    const resp = await request("GET", `/blob/${hash}`);
    if (resp.status === 404) die(`blob not found: ${hash}`);
    if (resp.status !== 200) die(`error: HTTP ${resp.status}`);

    if (outArg) {
      fs.writeFileSync(outArg, resp.body);
      process.stderr.write(`wrote ${outArg} (${resp.body.length} bytes)\n`);
    } else {
      process.stdout.write(resp.body);
    }
  },

  async exists(args) {
    const hash = args[0];
    if (!hash) die("Usage: exists <hash>");

    const resp = await request("HEAD", `/blob/${hash}`);
    if (resp.status === 200) {
      const size = resp.headers["content-length"];
      console.log(`exists: ${hash.slice(0, 12)}  ${size} bytes`);
    } else {
      console.log(`not found: ${hash}`);
      process.exit(1);
    }
  },

  async events(args) {
    const limit = args[0] || 20;
    const resp = await request("GET", `/events?limit=${limit}`);
    const rows = json(resp);

    if (rows.length === 0) return console.log("No events.");

    const w = { id: 4, ts: 19, lang: 15, input: 12, output: 12, size: 7, ms: 6, ok: 3 };
    console.log(
      "ID".padEnd(w.id),
      "TIMESTAMP".padEnd(w.ts),
      "LANGUAGE".padEnd(w.lang),
      "INPUT".padEnd(w.input),
      "OUTPUT".padEnd(w.output),
      "SIZE".padStart(w.size),
      "MS".padStart(w.ms),
      "OK",
    );
    for (const e of rows) {
      console.log(
        String(e.id).padEnd(w.id),
        e.timestamp.slice(0, 19).padEnd(w.ts),
        e.language.padEnd(w.lang),
        (e.input_hash || "").slice(0, 12).padEnd(w.input),
        (e.output_hash || "—").slice(0, 12).padEnd(w.output),
        String(e.output_size || "—").padStart(w.size),
        String(e.compile_time_ms || "—").padStart(w.ms),
        e.success ? "✓" : "✗" + (e.error ? ` ${e.error.split("\n")[0].slice(0, 60)}` : ""),
      );
    }
  },

  async stats() {
    const resp = await request("GET", "/stats");
    const s = json(resp);
    console.log(`Compiles:       ${s.total_compiles} (${s.successes} ok, ${s.failures} failed)`);
    console.log(`Unique inputs:  ${s.unique_inputs}`);
    console.log(`Unique outputs: ${s.unique_outputs}`);
    console.log(`Blobs stored:   ${s.total_blobs}`);
    console.log(`Total storage:  ${(s.total_blob_bytes / 1024).toFixed(1)} KB`);
  },

  async validate(args) {
    const fileArg = args[0];
    if (!fileArg) die("Usage: validate <file.wasm>");
    const wasm = fs.readFileSync(path.resolve(fileArg));
    const resp = await request("POST", "/validate", { body: wasm });
    const result = JSON.parse(resp.body.toString());

    if (result.valid) {
      console.log(`\x1b[32m✓ Contract satisfied\x1b[0m`);
    } else {
      console.log(`\x1b[31m✗ Contract violated\x1b[0m`);
    }
    for (const e of result.errors) console.log(`  \x1b[31merror: ${e}\x1b[0m`);
    for (const w of result.warnings) console.log(`  \x1b[33mwarn: ${w}\x1b[0m`);
    if (result.info.runSignature) console.log(`  run: ${result.info.runSignature}`);
    if (!result.valid) process.exit(1);
  },

  async languages() {
    const resp = await request("GET", "/languages");
    json(resp).forEach((l) => console.log(l));
  },
};

// --- main ---

const usage = `Usage: compiler-api <command> [args]

Commands:
  compile <lang> [file|-] [-o out.wasm]   Compile source to WebAssembly
  validate <file.wasm>                    Validate module against contract
  blob <hash> [-o output]                 Fetch a stored blob
  exists <hash>                           Check if a blob exists (HEAD)
  events [limit]                          List recent compile events
  stats                                   Show aggregate statistics
  languages                               List supported languages

Environment:
  COMPILER_API_URL   Server URL (default: http://localhost:8000)`;

const cmd = process.argv[2];
const args = process.argv.slice(3);

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(usage);
  process.exit(0);
}

if (!commands[cmd]) die(`Unknown command: ${cmd}\n\n${usage}`);

commands[cmd](args).catch((err) => die(err.message));
