#!/usr/bin/env node
// =============================================================================
// status_server.cjs — API HTTP de SOLO LECTURA del sistema de trading, para VQL.
//
// Expone el estado del host que corre los detectores/bot/guardianes para que VQL
// (la interfaz) lo consuma por HTTP. NO ejecuta ni escribe NADA: solo lee
// systemd/launchd, /proc o vm_stat, los logs /tmp/vero_*.log y los .jsonl.
//
// Portable: Linux (systemd + /proc, el VPS) y macOS (launchd + vm_stat, test local).
//
// Endpoints (todos requieren  Authorization: Bearer $STATUS_API_TOKEN):
//   GET /api/status    → { system, services[] }   (contrato lib/monitoring)
//   GET /api/telegram  → estado del bot            (contrato lib/telegram)
//   GET /api/feed      → señal armada + últimas señales + reporte del día
//   GET /api/health    → { ok:true } (sin auth, para probes)
//
// Env: STATUS_API_TOKEN (obligatorio para exponer), HOST (default 127.0.0.1),
//      PORT (default 8787), TRADING_DATA_PATH (default ~/Trading),
//      VERO_UNIT_PREFIX (systemd, default "vero"), VERO_LAUNCHD_PREFIX (default "cl.vero").
// =============================================================================

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.STATUS_API_TOKEN || "";
const TRADING = process.env.TRADING_DATA_PATH || path.join(os.homedir(), "Trading");
const UNIT_PREFIX = process.env.VERO_UNIT_PREFIX || "vero";        // systemd: vero-<id>.service
const LAUNCHD_PREFIX = process.env.VERO_LAUNCHD_PREFIX || "cl.vero"; // launchd: cl.vero.<id>
const IS_LINUX = process.platform === "linux";

// Servicios conocidos (id = el que espera VQL). El resto (Linux) se auto-descubre.
const SERVICE_MANIFEST = [
  { id: "detectoreth", desc: "Detector A+ de ETH (1m)" },
  { id: "detectorbtc", desc: "Detector A+ de BTC (1m)" },
  { id: "detectoreth1h", desc: "Detector de tendencia ETH (1h)" },
  { id: "continuacion", desc: "Monitor de continuación (aguanta/toma ganancia)" },
  { id: "telegrambot", desc: "Bot de Telegram (confirmación de señales)" },
  { id: "binanceautoexec", desc: "Auto-ejecución A+ en Binance" },
  { id: "binanceguard", desc: "Protege posiciones spot (sl/tp)" },
  { id: "binancetrailing", desc: "Trailing stop en Binance" },
  { id: "scoresenales", desc: "Score de calidad de señales" },
  { id: "recalibracion", desc: "Recalibración semanal" },
];

function sh(cmd, timeout = 4000) {
  return execSync(cmd, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function trySh(cmd, timeout = 4000) {
  try { return sh(cmd, timeout); } catch { return ""; }
}
function humanDuration(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---------- system stats ----------
function systemStats() {
  try {
    return IS_LINUX ? systemStatsLinux() : systemStatsDarwin();
  } catch {
    return { cpu: 0, ram: { used: 0, total: 1 }, disk: { used: 0, total: 1 }, uptime: "—" };
  }
}

// CPU (Linux): sampler en segundo plano. Lee /proc/stat cada 3s y computa el %
// desde el delta entre muestras. Sin busy-wait (antes se auto-inflaba a ~100%) y
// sin bloquear la request: el handler solo lee el último valor calculado.
let cpuPct = 0;
let prevCpu = null;
function sampleCpuLinux() {
  try {
    const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = line[3] + (line[4] || 0);
    const total = line.reduce((a, b) => a + b, 0);
    if (prevCpu) {
      const dTotal = total - prevCpu.total, dIdle = idle - prevCpu.idle;
      if (dTotal > 0) cpuPct = Math.round(((dTotal - dIdle) / dTotal) * 100);
    }
    prevCpu = { idle, total };
  } catch { /* /proc no disponible: deja el último valor */ }
}
if (IS_LINUX) {
  sampleCpuLinux(); // muestra base
  setInterval(sampleCpuLinux, 3000).unref();
}

function systemStatsLinux() {
  const cpu = cpuPct; // valor del sampler en background

  const mem = {};
  for (const l of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = Number(m[2]); // kB
  }
  const totalGb = mem.MemTotal / 1024 / 1024;
  const availGb = (mem.MemAvailable ?? mem.MemFree ?? 0) / 1024 / 1024;
  const usedGb = totalGb - availGb;

  const upSec = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  return {
    cpu,
    ram: { used: +usedGb.toFixed(1), total: +totalGb.toFixed(1) },
    disk: diskRoot(),
    uptime: humanDuration(upSec * 1000),
  };
}
function systemStatsDarwin() {
  // CPU: top -l1 da "CPU usage: X% user, Y% sys, Z% idle".
  const top = trySh("top -l1 -n0");
  const cm = top.match(/CPU usage:\s+([\d.]+)% user,\s+([\d.]+)% sys,\s+([\d.]+)% idle/);
  const cpu = cm ? Math.round(100 - Number(cm[3])) : 0;

  const totalBytes = Number(trySh("sysctl -n hw.memsize")) || 0;
  const pageSize = Number(trySh("sysctl -n hw.pagesize")) || 4096;
  const vm = trySh("vm_stat");
  const pg = (re) => { const m = vm.match(re); return m ? Number(m[1]) : 0; };
  const usedPages = pg(/Pages active:\s+(\d+)/) + pg(/Pages wired down:\s+(\d+)/) + pg(/Pages occupied by compressor:\s+(\d+)/);
  const totalGb = totalBytes / 1024 ** 3;
  const usedGb = (usedPages * pageSize) / 1024 ** 3;

  // uptime desde kern.boottime.
  const boot = trySh("sysctl -n kern.boottime");
  const bm = boot.match(/sec = (\d+)/);
  const upMs = bm ? Date.now() - Number(bm[1]) * 1000 : 0;

  return {
    cpu,
    ram: { used: +usedGb.toFixed(1), total: +totalGb.toFixed(1) },
    disk: diskRoot(),
    uptime: humanDuration(upMs),
  };
}
function diskRoot() {
  // df -kP / → línea 2: Filesystem 1024-blocks Used Available Capacity Mounted
  const out = trySh("df -kP /");
  const l = out.split("\n")[1];
  if (!l) return { used: 0, total: 1 };
  const c = l.split(/\s+/);
  const totalGb = Number(c[1]) / 1024 / 1024;
  const usedGb = Number(c[2]) / 1024 / 1024;
  return { used: +usedGb.toFixed(0), total: +totalGb.toFixed(0) };
}

// ---------- services ----------
function services() {
  try {
    return IS_LINUX ? servicesLinux() : servicesDarwin();
  } catch {
    return [];
  }
}
function mapState(active, sub) {
  if (active === "active") return "running";
  if (active === "activating" || sub === "auto-restart" || active === "reloading") return "restarting";
  return "stopped";
}
function descOf(id) {
  return SERVICE_MANIFEST.find((s) => s.id === id)?.desc ?? "Servicio de trading";
}
function servicesLinux() {
  // IDs: manifiesto + auto-descubrimiento de units vero-*.
  const discovered = trySh(`systemctl list-units --type=service --all --no-legend '${UNIT_PREFIX}*.service' 2>/dev/null`)
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => u && u.endsWith(".service"))
    .map((u) => u.replace(/\.service$/, "").replace(new RegExp(`^${UNIT_PREFIX}-?`), ""));
  const ids = Array.from(new Set([...SERVICE_MANIFEST.map((s) => s.id), ...discovered]));

  return ids.map((id) => {
    const unit = `${UNIT_PREFIX}-${id}.service`;
    const show = trySh(`systemctl show ${unit} --property=ActiveState,SubState,ActiveEnterTimestamp 2>/dev/null`);
    const props = {};
    for (const l of show.split("\n")) { const i = l.indexOf("="); if (i > 0) props[l.slice(0, i)] = l.slice(i + 1); }
    const active = props.ActiveState || "inactive";
    const status = mapState(active, props.SubState);
    let uptime = "—", lastRestart = "—";
    if (props.ActiveEnterTimestamp) {
      const t = Date.parse(props.ActiveEnterTimestamp);
      if (!Number.isNaN(t)) { uptime = status === "running" ? humanDuration(Date.now() - t) : "—"; lastRestart = new Date(t).toISOString(); }
    }
    return { id, name: `${UNIT_PREFIX}-${id}`, status, uptime, lastRestart, description: descOf(id) };
  });
}
function servicesDarwin() {
  // launchctl list → "PID\tStatus\tLabel"; label = cl.vero.<id>.
  const out = trySh("launchctl list");
  const byLabel = new Map();
  for (const l of out.split("\n")) {
    const c = l.split("\t");
    if (c.length >= 3 && c[2].startsWith(`${LAUNCHD_PREFIX}.`)) byLabel.set(c[2], c[0]); // label → PID ("-" si no corre)
  }
  const ids = Array.from(new Set([
    ...SERVICE_MANIFEST.map((s) => s.id),
    ...Array.from(byLabel.keys()).map((lbl) => lbl.slice(LAUNCHD_PREFIX.length + 1)),
  ]));
  return ids.map((id) => {
    const label = `${LAUNCHD_PREFIX}.${id}`;
    const pid = byLabel.get(label);
    const running = pid !== undefined && pid !== "-";
    return {
      id, name: `${UNIT_PREFIX}-${id}`,
      status: running ? "running" : byLabel.has(label) ? "stopped" : "stopped",
      uptime: "—", lastRestart: "—", description: descOf(id),
    };
  });
}

// ---------- telegram ----------
function tailLines(file, n) {
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}
function logTimestamp(file, hhmmss) {
  // El log trae HH:MM:SS sin fecha; combinamos con la fecha de mtime del archivo.
  try {
    const base = fs.statSync(file).mtime;
    if (hhmmss) {
      const [h, m, s] = hhmmss.split(":").map(Number);
      const d = new Date(base); d.setHours(h, m, s, 0);
      return d.toISOString();
    }
    return base.toISOString();
  } catch { return new Date().toISOString(); }
}
function telegramSnapshot() {
  const log = "/tmp/vero_bot.log";
  const svc = services().find((s) => s.id === "telegrambot");
  const botStatus = svc ? (svc.status === "running" ? "running" : svc.status === "restarting" ? "error" : "stopped") : "stopped";
  const uptime = svc?.uptime && svc.uptime !== "—" ? svc.uptime : "—";

  const lines = tailLines(log, 200);
  const toEntry = (line) => {
    const m = line.match(/^(\d{2}:\d{2}:\d{2})\s+(.*)$/);
    return { timestamp: logTimestamp(log, m ? m[1] : null), text: (m ? m[2] : line).slice(0, 300) };
  };
  const isErr = (l) => /err|error|fail|falló|excep/i.test(l);
  const alerts = lines.filter((l) => !isErr(l)).slice(-8).reverse().map(toEntry);
  const errors = lines.filter(isErr).slice(-5).reverse().map(toEntry);
  const last = lines[lines.length - 1];

  return {
    botStatus,
    lastMessage: last ? toEntry(last).text : null,
    lastMessageAt: last ? toEntry(last).timestamp : null,
    alerts, errors, uptime,
  };
}

// ---------- feed ----------
function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => { const i = l.search(/[{[]/); try { return i === -1 ? null : JSON.parse(l.slice(i)); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function feed() {
  // Señales armadas en /tmp/vero_pending_*.json.
  let pending = [];
  try {
    pending = fs.readdirSync("/tmp").filter((f) => /^vero_pending_.+\.json$/.test(f))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join("/tmp", f), "utf8")); } catch { return null; } })
      .filter(Boolean);
  } catch { pending = []; }

  const signals = readJsonl(path.join(TRADING, "senales_aplus.jsonl"));
  const lastSignals = signals.slice(-8).reverse();
  const reportes = readJsonl(path.join(TRADING, "reporte_diario.jsonl"));
  const report = reportes.length ? reportes[reportes.length - 1] : null;

  return { pending, lastSignals, report, updatedAt: new Date().toISOString() };
}

// ---------- http ----------
function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}
function authorized(req) {
  if (!TOKEN) return true; // sin token configurado: modo abierto (solo tiene sentido en localhost)
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${TOKEN}`;
}

const server = http.createServer((req, res) => {
  const url = (req.url || "").split("?")[0];
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
  if (url === "/api/health") return send(res, 200, { ok: true, platform: process.platform });
  if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

  try {
    if (url === "/api/status") return send(res, 200, { system: systemStats(), services: services() });
    if (url === "/api/telegram") return send(res, 200, telegramSnapshot());
    if (url === "/api/feed") return send(res, 200, feed());
    return send(res, 404, { error: "not_found" });
  } catch (e) {
    return send(res, 500, { error: "internal", detail: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const mode = TOKEN ? "con token" : "SIN TOKEN (abierto — usar solo en localhost)";
  console.log(`status_server escuchando en http://${HOST}:${PORT} · ${process.platform} · ${mode}`);
  console.log(`endpoints: /api/status /api/telegram /api/feed /api/health`);
});
