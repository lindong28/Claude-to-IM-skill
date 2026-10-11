import { lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pure comparison of a decoded launchd plist against the selected instance.
// Keys are defined by launchd.plist(5); allowed argv forms come from generate_plist.
// This does not collect manager state or authorize any lifecycle operation.
export function matchesPlistIdentity(plist, expected) {
  if (!plist || typeof plist !== 'object' || Array.isArray(plist)) return false;
  if (!expected || typeof expected !== 'object') return false;
  const { label, source, home, instance, node } = expected;
  if (![label, source, home, instance, node].every(value => typeof value === 'string' && value.length > 0)) return false;
  if (![source, home, node].every(value => value.startsWith('/'))) return false;

  const env = plist.EnvironmentVariables;
  const argv = plist.ProgramArguments;
  if (!env || typeof env !== 'object' || Array.isArray(env) || !Array.isArray(argv)) return false;
  if (plist.Label !== label || plist.WorkingDirectory !== source ||
      env.CTI_HOME !== home || env.CTI_INSTANCE !== instance) return false;

  // Program, when present, overrides argv[0] for execution.
  if (Object.hasOwn(plist, 'Program') && plist.Program !== node) return false;
  return argv[0] === node && (
    (argv.length === 2 && argv[1] === `${source}/dist/daemon.mjs`) ||
    (argv.length === 3 && argv[1] === '--use-env-proxy' && argv[2] === `${source}/dist/daemon.mjs`)
  );
}


// launchctl(1), legacy list: PID, last exit status, label. Any incomplete or
// unfamiliar listing is unknown, never an absence proof. No print parsing.
export function registrationState(manager, managerUid, listing, uid, label) {
  const succeeded = result => result && result.status === 0 && !result.error && !result.signal && typeof result.stdout === 'string';
  if (![manager, managerUid, listing].every(succeeded)) return 'unknown';
  if (manager.stdout.trim() !== 'Aqua' || managerUid.stdout.trim() !== String(uid)) return 'unknown';
  const lines = listing.stdout.split('\n');
  if (lines.pop() !== '' || lines.shift() !== 'PID\tStatus\tLabel') return 'unknown';
  const labels = new Set();
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length !== 3 || !/^(?:-|[0-9]+)$/.test(fields[0]) ||
        !/^-?[0-9]+$/.test(fields[1]) || !fields[2] || labels.has(fields[2])) return 'unknown';
    labels.add(fields[2]);
  }
  return labels.has(label) ? 'registered' : 'absent';
}

function runReadOnly(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
}

// Dependencies permit in-memory failure samples without touching launchd or disk.
// Returns only a decision token; subprocess output can contain private env values.
export function inspectUninstall(expected, plistPath, {
  run = runReadOnly, stat = lstatSync, canonicalize = realpathSync, uid = process.getuid(),
} = {}) {
  const manager = run('/bin/launchctl', ['managername']);
  const managerUid = run('/bin/launchctl', ['manageruid']);
  const listing = run('/bin/launchctl', ['list']);
  const registration = registrationState(manager, managerUid, listing, uid, expected.label);
  if (registration !== 'absent') return registration;

  let info;
  try { info = stat(plistPath); }
  catch (error) { return error.code === 'ENOENT' ? 'absent' : 'unknown'; }
  if (!info.isFile() || info.isSymbolicLink()) return 'unknown';
  const decoded = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]);
  if (decoded.status !== 0 || decoded.error || decoded.signal) return 'unknown';
  try {
    const identity = { ...expected, source: canonicalize(expected.source), home: canonicalize(expected.home) };
    return matchesPlistIdentity(JSON.parse(decoded.stdout), identity) ? 'owned' : 'foreign';
  } catch { return 'unknown'; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [label, source, home, instance, plist, node] = process.argv.slice(2);
  let result = 'unknown';
  if ([label, source, home, instance, plist, node].every(value => typeof value === 'string' && value.length > 0)) {
    try { result = inspectUninstall({ label, source, home, instance, node }, plist); }
    catch { /* Collection errors must not expose subprocess output or allow deletion. */ }
  }
  if (result === 'owned' || result === 'absent') {
    console.log(result);
  } else {
    const reason = result === 'registered'
      ? 'the selected LaunchAgent is registered (including stopped jobs)'
      : result === 'foreign' ? 'the plist identity differs from the selected instance'
        : 'the launchd context, job absence, or plist identity could not be verified';
    console.error(`Uninstall refused: ${reason}. No plist, PID file, or instance data was removed. Review the selected instance and LaunchAgent ownership before any manual action.`);
    process.exitCode = 1;
  }
}
