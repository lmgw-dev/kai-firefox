// Processes by PID with their start time: a PID is signalled only while /proc says it is still the
// process that was started (or found) then, never one the kernel reused for another.
import { readFileSync, readdirSync } from "node:fs";

// The start time of `pid` (field 22 of /proc/<pid>/stat, in clock ticks since boot), or null when
// it is gone or a zombie.
export function startTime(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
    if (rest[0] === "Z") return null;
    return rest[19];
  } catch {
    return null;
  }
}

// Signals `pid` only while its start time is still `start`; whether it did.
export function killChecked(pid, start, signal = "SIGTERM") {
  if (start == null || startTime(pid) !== start) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// The processes whose command line names `part` (a run's profile folder), as [{ pid, start, args }].
export function processesNaming(part) {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const args = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").join(" ");
      if (args.includes(part)) out.push({ pid: Number(d), start: startTime(Number(d)), args });
    } catch {
      /* gone */
    }
  }
  return out;
}

// A Firefox run's processes: those naming its profile folder, and its content and helper
// processes, which name their parent (`-parentPid <pid>`, crashhelper's first argument) instead.
export function firefoxProcesses(profile, pid) {
  const byParent = (args) => args.includes(`-parentPid ${pid} `) || args.startsWith(`/usr/lib64/firefox/crashhelper ${pid} `);
  return [...processesNaming(profile), ...processesNaming(`${pid}`).filter((p) => byParent(p.args + " "))];
}
