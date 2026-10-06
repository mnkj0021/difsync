import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const OUTPUT_LIMIT = Math.max(20000, Number(process.env.DIFSYNC_AGENT_OUTPUT_LIMIT || 250000));
const sessions = new Map();

function defaultRoots() {
  if (process.platform === "win32") {
    const roots = [];
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = letter + ":\\";
      try { if (fs.existsSync(root)) roots.push(path.resolve(root)); } catch {}
    }
    return roots.length ? roots : [path.resolve(os.homedir())];
  }
  return [path.resolve(os.homedir())];
}

const ROOTS = String(process.env.DIFSYNC_AGENT_ROOTS || "")
  .split(path.delimiter)
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => path.resolve(x));
if (!ROOTS.length) ROOTS.push(...defaultRoots());

function within(target) {
  const p = path.resolve(String(target || ""));
  const allowed = ROOTS.some((root) => p === root || p.startsWith(root + path.sep));
  if (!allowed) throw new Error("Path is outside configured agent roots");
  return p;
}

function readFile(input, offset = 0, length = 65536) {
  const target = within(input);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error("Not a file");
  const start = Math.max(0, Number(offset) || 0);
  const wanted = Math.max(1, Math.min(Number(length) || 65536, OUTPUT_LIMIT));
  const bytes = Math.max(0, Math.min(wanted, stat.size - start));
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(target, "r");
  try {
    const count = fs.readSync(fd, buffer, 0, bytes, start);
    return { path: target, size: stat.size, offset: start, bytes: count, content: buffer.subarray(0, count).toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

function listDirectory(input, depth = 1) {
  const root = within(input);
  const maxDepth = Math.max(0, Math.min(5, Number(depth) || 1));
  const entries = [];
  function walk(dir, level) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      let size = null;
      try { size = fs.statSync(full).size; } catch {}
      entries.push({ path: full, name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other", size });
      if (entries.length >= 1500) return;
      if (entry.isDirectory() && level < maxDepth) {
        try { walk(full, level + 1); } catch {}
      }
      if (entries.length >= 1500) return;
    }
  }
  walk(root, 0);
  return entries;
}

function searchFiles(input, query, maxResults = 100) {
  const root = within(input);
  const needle = String(query || "").toLowerCase();
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxResults) return;
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase().includes(needle) || full.toLowerCase().includes(needle)) {
        out.push({ path: full, name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
      }
      if (entry.isDirectory()) {
        try { walk(full); } catch {}
      }
    }
  }
  walk(root);
  return out;
}

function shellCommand(command) {
  if (process.platform === "win32") {
    return { exe: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", String(command)] };
  }
  return { exe: "/bin/bash", args: ["-lc", String(command)] };
}

function spawnManaged(command, cwd) {
  const spec = shellCommand(command);
  const child = spawn(spec.exe, spec.args, {
    cwd: within(cwd || ROOTS[0]),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const id = "proc_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const session = { id, child, command: String(command), cwd: cwd || ROOTS[0], output: "", started_at: new Date().toISOString(), exited: false, exit_code: null };
  const append = (buf) => {
    session.output += String(buf);
    if (session.output.length > OUTPUT_LIMIT) session.output = session.output.slice(-OUTPUT_LIMIT);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (code) => { session.exited = true; session.exit_code = code; });
  sessions.set(id, session);
  return session;
}

async function runCommand(command, cwd, timeoutMs = 15000) {
  const session = spawnManaged(command, cwd);
  const timeout = Math.max(500, Math.min(Number(timeoutMs) || 15000, 120000));
  const start = Date.now();
  while (!session.exited && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 60));
  }
  if (!session.exited) {
    try { session.child.kill(); } catch {}
    throw new Error("Command timed out after " + timeout + " ms");
  }
  const result = { exit_code: session.exit_code, output: session.output, command: session.command, cwd: session.cwd };
  sessions.delete(session.id);
  return result;
}

export function inventory() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    node: process.version,
    capabilities: [
      "device.presence",
      "inventory.safe",
      "filesystem.read",
      "filesystem.write",
      "filesystem.search",
      "process.run",
      "process.session"
    ],
    roots: ROOTS,
    memory_bytes: os.totalmem(),
    cpus: os.cpus().length,
    updated_at: new Date().toISOString()
  };
}

export async function execute(payload = {}) {
  const op = String(payload.op || "");
  if (op === "read_file") return readFile(payload.path, payload.offset, payload.length);
  if (op === "list_directory") return { entries: listDirectory(payload.path, payload.depth) };
  if (op === "search_files") return { matches: searchFiles(payload.root, payload.query, Math.max(1, Math.min(200, Number(payload.max_results) || 100))) };
  if (op === "write_file") {
    const target = within(payload.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (payload.mode === "append") fs.appendFileSync(target, String(payload.content ?? ""), "utf8");
    else fs.writeFileSync(target, String(payload.content ?? ""), "utf8");
    return { path: target, bytes: Buffer.byteLength(String(payload.content ?? ""), "utf8") };
  }
  if (op === "create_directory") {
    const target = within(payload.path);
    fs.mkdirSync(target, { recursive: true });
    return { path: target };
  }
  if (op === "move_path") {
    const source = within(payload.source);
    const destination = within(payload.destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    return { source, destination };
  }
  if (op === "delete_path") {
    const target = within(payload.path);
    fs.rmSync(target, { recursive: true, force: Boolean(payload.force) });
    return { path: target, deleted: true };
  }
  if (op === "run_command") return await runCommand(payload.command, payload.cwd, payload.timeout_ms);
  if (op === "start_process") {
    const s = spawnManaged(payload.command, payload.cwd);
    return { process_id: s.id, command: s.command, cwd: s.cwd, started_at: s.started_at };
  }
  if (op === "read_process_output") {
    const s = sessions.get(String(payload.process_id || ""));
    if (!s) throw new Error("Unknown process session");
    return { process_id: s.id, output: s.output, exited: s.exited, exit_code: s.exit_code };
  }
  if (op === "interact_process") {
    const s = sessions.get(String(payload.process_id || ""));
    if (!s) throw new Error("Unknown process session");
    s.child.stdin.write(String(payload.input ?? ""));
    if (payload.newline !== false) s.child.stdin.write(os.EOL);
    return { process_id: s.id, ok: true };
  }
  if (op === "terminate_process") {
    const s = sessions.get(String(payload.process_id || ""));
    if (!s) throw new Error("Unknown process session");
    s.child.kill();
    return { process_id: s.id, terminated: true };
  }
  if (op === "list_sessions") {
    return {
      sessions: [...sessions.values()].map((s) => ({
        process_id: s.id, command: s.command, cwd: s.cwd, started_at: s.started_at, exited: s.exited, exit_code: s.exit_code
      }))
    };
  }
  throw new Error("Unsupported operation: " + op);
}
