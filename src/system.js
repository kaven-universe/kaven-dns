'use strict';

const os = require('os');

function platformName(platform) {
  switch (platform) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    case 'freebsd': return 'FreeBSD';
    default: return platform;
  }
}

function summarizeCpus() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) total += cpu.times[key];
  }
  return { idle, total };
}

function clampPercent(n) {
  return +Math.max(0, Math.min(100, n)).toFixed(1);
}

/**
 * Lightweight system/resource monitor. Samples process and system CPU usage
 * every few seconds in the background; snapshot() returns the current values
 * plus static server info for the dashboard cards.
 */
function createSystemMonitor() {
  const cores = os.cpus().length;
  const state = {
    // Initial process CPU = average share of total capacity since process start
    processCpu: clampPercent(
      (() => {
        const u = process.cpuUsage();
        const secs = ((u.user + u.system) / 1e6) / Math.max(1, process.uptime());
        return cores ? (secs / cores) * 100 : 0;
      })(),
    ),
    systemCpu: 0,
  };

  let lastWall = Date.now();
  let lastProc = process.cpuUsage();
  let lastCpus = summarizeCpus();

  const timer = setInterval(() => {
    const now = Date.now();
    const wallSec = (now - lastWall) / 1000;
    if (wallSec > 0.2) {
      // Process CPU as a share of total capacity (all cores)
      const proc = process.cpuUsage();
      const procSec = ((proc.user - lastProc.user) + (proc.system - lastProc.system)) / 1e6;
      state.processCpu = clampPercent(cores ? (procSec / wallSec / cores) * 100 : 0);
      lastProc = proc;

      // System CPU from the idle-time delta across all cores
      const cpus = summarizeCpus();
      const idleDelta = cpus.idle - lastCpus.idle;
      const totalDelta = cpus.total - lastCpus.total;
      if (totalDelta > 0) state.systemCpu = clampPercent((1 - idleDelta / totalDelta) * 100);
      lastCpus = cpus;
      lastWall = now;
    }
  }, 5000);
  timer.unref();

  function snapshot() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
      hostname: os.hostname(),
      platform: platformName(os.platform()),
      release: os.release(),
      arch: os.arch(),
      nodeVersion: process.version,
      runtimeName: 'Node',
      runtimeVersion: process.version,
      cores,
      totalMemMB: Math.round(totalMem / 1048576),
      usedMemMB: Math.round((totalMem - freeMem) / 1048576),
      processRSSMB: Math.round(process.memoryUsage().rss / 1048576),
      processCpu: state.processCpu,
      systemCpu: state.systemCpu,
    };
  }

  return { snapshot };
}

module.exports = { createSystemMonitor };
