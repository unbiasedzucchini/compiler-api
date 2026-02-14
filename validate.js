// Validate a WebAssembly module against the compiler-api contract:
//   export memory: Memory
//   export run: (i32, i32, i32) -> i32
//
// Parses the wasm binary directly — no dependencies.

const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_FUNCTION = 3;
const SECTION_EXPORT = 7;

const TYPE_I32 = 0x7f;
const FUNC_TYPE_TAG = 0x60;

const EXPORT_FUNC = 0;
const EXPORT_MEMORY = 2;

class Reader {
  constructor(buf) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.pos = 0;
  }
  byte()  { return this.buf[this.pos++]; }
  u32()   { return this.leb128(); }
  leb128() {
    let result = 0, shift = 0, b;
    do { b = this.byte(); result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return result >>> 0;
  }
  bytes(n) { const s = this.buf.slice(this.pos, this.pos + n); this.pos += n; return s; }
  name()  { const len = this.u32(); return this.bytes(len).toString("utf-8"); }
  skip(n) { this.pos += n; }
}

function parseSections(buf) {
  const r = new Reader(buf);

  // magic + version
  const magic = r.bytes(4);
  if (magic.toString("hex") !== "0061736d") throw new Error("Not a wasm module");
  r.skip(4); // version

  const sections = {};
  while (r.pos < r.buf.length) {
    const id = r.byte();
    const size = r.u32();
    const payload = r.bytes(size);
    sections[id] = payload;
  }
  return sections;
}

function parseTypes(buf) {
  const r = new Reader(buf);
  const count = r.u32();
  const types = [];
  for (let i = 0; i < count; i++) {
    const tag = r.byte();
    if (tag !== FUNC_TYPE_TAG) throw new Error(`Unexpected type tag: 0x${tag.toString(16)}`);
    const paramCount = r.u32();
    const params = [];
    for (let j = 0; j < paramCount; j++) params.push(r.byte());
    const resultCount = r.u32();
    const results = [];
    for (let j = 0; j < resultCount; j++) results.push(r.byte());
    types.push({ params, results });
  }
  return types;
}

function parseImports(buf) {
  const r = new Reader(buf);
  const count = r.u32();
  let funcImports = 0;
  for (let i = 0; i < count; i++) {
    r.name(); // module
    r.name(); // name
    const kind = r.byte();
    if (kind === 0) { r.u32(); funcImports++; }       // func: typeidx
    else if (kind === 1) { r.byte(); r.u32(); }       // table
    else if (kind === 2) { r.byte(); r.u32(); if (r.buf[r.pos-1] === 1) r.u32(); } // memory (simplified)
    else if (kind === 3) { r.byte(); r.byte(); }      // global (simplified)
  }
  return { funcImports };
}

function parseFunctions(buf) {
  const r = new Reader(buf);
  const count = r.u32();
  const typeIndices = [];
  for (let i = 0; i < count; i++) typeIndices.push(r.u32());
  return typeIndices;
}

function parseExports(buf) {
  const r = new Reader(buf);
  const count = r.u32();
  const exports = [];
  for (let i = 0; i < count; i++) {
    const name = r.name();
    const kind = r.byte();
    const index = r.u32();
    exports.push({ name, kind, index });
  }
  return exports;
}

function typeName(t) {
  if (t === TYPE_I32) return "i32";
  if (t === 0x7e) return "i64";
  if (t === 0x7d) return "f32";
  if (t === 0x7c) return "f64";
  return `0x${t.toString(16)}`;
}

function formatSig(type) {
  const params = type.params.map(typeName).join(", ");
  const results = type.results.map(typeName).join(", ");
  return `(${params}) -> (${results})`;
}

const EXPECTED_PARAMS = [TYPE_I32, TYPE_I32, TYPE_I32];
const EXPECTED_RESULTS = [TYPE_I32];

function validate(wasmBytes) {
  const errors = [];
  const warnings = [];
  const info = { exports: {} };

  let sections;
  try {
    sections = parseSections(wasmBytes);
  } catch (e) {
    return { valid: false, errors: [`Invalid wasm binary: ${e.message}`], warnings, info };
  }

  const types = sections[SECTION_TYPE] ? parseTypes(sections[SECTION_TYPE]) : [];
  const imports = sections[SECTION_IMPORT] ? parseImports(sections[SECTION_IMPORT]) : { funcImports: 0 };
  const funcTypeIndices = sections[SECTION_FUNCTION] ? parseFunctions(sections[SECTION_FUNCTION]) : [];
  const exports = sections[SECTION_EXPORT] ? parseExports(sections[SECTION_EXPORT]) : [];

  for (const exp of exports) {
    info.exports[exp.name] = { kind: exp.kind, index: exp.index };
  }

  // Check memory export
  const memExport = exports.find(e => e.name === "memory" && e.kind === EXPORT_MEMORY);
  if (!memExport) {
    errors.push('Missing export: memory (kind: memory)');
  }

  // Check run export
  const runExport = exports.find(e => e.name === "run" && e.kind === EXPORT_FUNC);
  if (!runExport) {
    errors.push('Missing export: run (kind: function)');
  } else {
    // Resolve function type: exported index includes imported functions
    const localIndex = runExport.index - imports.funcImports;
    if (localIndex < 0 || localIndex >= funcTypeIndices.length) {
      errors.push(`Cannot resolve type for run (func index ${runExport.index})`);
    } else {
      const typeIdx = funcTypeIndices[localIndex];
      const type = types[typeIdx];
      if (!type) {
        errors.push(`Cannot resolve type index ${typeIdx} for run`);
      } else {
        info.runSignature = formatSig(type);

        const paramsOk = type.params.length === EXPECTED_PARAMS.length &&
          type.params.every((p, i) => p === EXPECTED_PARAMS[i]);
        const resultsOk = type.results.length === EXPECTED_RESULTS.length &&
          type.results.every((r, i) => r === EXPECTED_RESULTS[i]);

        if (!paramsOk || !resultsOk) {
          errors.push(
            `Wrong signature for run: got ${formatSig(type)}, ` +
            `expected (i32, i32, i32) -> (i32)`
          );
        }
      }
    }
  }

  // Warn about unexpected exports
  const knownExports = new Set(["memory", "run", "_initialize"]);
  for (const exp of exports) {
    if (!knownExports.has(exp.name)) {
      warnings.push(`Extra export: ${exp.name}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings, info };
}

module.exports = { validate };
