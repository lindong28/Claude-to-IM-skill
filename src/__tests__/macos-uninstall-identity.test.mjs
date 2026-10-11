import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesPlistIdentity, registrationState, inspectUninstall } from '../../scripts/macos-uninstall-identity.mjs';
import { readFileSync } from 'node:fs';

// In-memory decoded plist samples; no filesystem fixtures or lifecycle calls.
function fixture(instance = 'quant-lab', proxy = false) {
  const expected = {
    label: `com.claude-to-im.bridge${instance === 'default' ? '' : `.${instance}`}`,
    source: '/checkout/bridge',
    home: `/users/example/.claude-to-im${instance === 'default' ? '' : `-${instance}`}`,
    instance,
    node: '/opt/homebrew/bin/node',
  };
  const plist = {
    Label: expected.label,
    WorkingDirectory: expected.source,
    ProgramArguments: [expected.node, ...(proxy ? ['--use-env-proxy'] : []), `${expected.source}/dist/daemon.mjs`],
    EnvironmentVariables: { CTI_HOME: expected.home, CTI_INSTANCE: instance },
  };
  return { expected, plist };
}

for (const instance of ['default', 'quant-lab']) {
  for (const proxy of [false, true]) {
    test(`accepts exact ${instance} identity, proxy=${proxy}`, () => {
      const { plist, expected } = fixture(instance, proxy);
      assert.equal(matchesPlistIdentity(plist, expected), true);
      plist.Program = expected.node;
      assert.equal(matchesPlistIdentity(plist, expected), true);
    });
  }
}

const mutations = {
  'foreign label': p => { p.Label += '.other'; },
  'foreign source': p => { p.WorkingDirectory = '/other/bridge'; },
  'foreign home': p => { p.EnvironmentVariables.CTI_HOME += '-other'; },
  'foreign instance': p => { p.EnvironmentVariables.CTI_INSTANCE = 'other'; },
  'missing home': p => { delete p.EnvironmentVariables.CTI_HOME; },
  'missing instance': p => { delete p.EnvironmentVariables.CTI_INSTANCE; },
  'missing environment': p => { delete p.EnvironmentVariables; },
  'foreign executable': p => { p.ProgramArguments[0] = '/other/node'; },
  'foreign bundle': p => { p.ProgramArguments[1] = '/other/bridge/dist/daemon.mjs'; },
  'overridden program': p => { p.Program = '/other/node'; },
  'additional argument': p => { p.ProgramArguments.push('--other'); },
  'unrecognized node flag': p => { p.ProgramArguments.splice(1, 0, '--eval'); },
  'misplaced proxy flag': p => { p.ProgramArguments.push('--use-env-proxy'); },
  'non-array arguments': p => { p.ProgramArguments = 'node daemon.mjs'; },
};

for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name}`, () => {
    const { plist, expected } = fixture();
    assert.equal(matchesPlistIdentity(plist, expected), true);
    mutate(plist);
    assert.equal(matchesPlistIdentity(plist, expected), false);
  });
}

test('rejects malformed plist and unresolved expectations', () => {
  const { plist, expected } = fixture();
  for (const value of [null, undefined, [], 'text', 42, {}]) {
    assert.equal(matchesPlistIdentity(value, expected), false);
  }
  for (const value of [null, {}, { ...expected, home: 'relative' }, { ...expected, instance: '' }]) {
    assert.equal(matchesPlistIdentity(plist, value), false);
  }
});


const ok = stdout => ({ status: 0, stdout });
const header = 'PID\tStatus\tLabel\n';
const target = 'com.claude-to-im.bridge.quant-lab';
const manager = ok('Aqua\n');
const managerUid = ok('501\n');

for (const pid of ['-', '123']) {
  test(`registered target is rejected irrespective of PID ${pid}`, () => {
    assert.equal(registrationState(manager, managerUid, ok(`${header}${pid}\t0\t${target}\n`), 501, target), 'registered');
  });
}

test('valid complete listings prove only selected label absence', () => {
  for (const text of [header, `${header}-\t-15\tother.label\n123\t0\tsecond.label\n`]) {
    assert.equal(registrationState(manager, managerUid, ok(text), 501, target), 'absent');
  }
});

for (const [name, overrides] of [
  ['other context', { manager: ok('Background\n') }],
  ['other uid', { managerUid: ok('502\n') }],
  ['manager failure', { manager: { status: 1, stdout: 'Aqua\n' } }],
  ['uid failure', { managerUid: { status: 1, stdout: '501\n' } }],
  ['listing failure', { listing: { status: 1, stdout: header } }],
  ['listing signal', { listing: { status: 0, stdout: header, signal: 'SIGTERM' } }],
  ['listing error', { listing: { status: 0, stdout: header, error: new Error('unreadable') } }],
]) {
  test(`unknown on ${name}`, () => {
    const input = { manager, managerUid, listing: ok(header), ...overrides };
    assert.equal(registrationState(input.manager, input.managerUid, input.listing, 501, target), 'unknown');
  });
}

for (const [name, text] of [
  ['empty', ''], ['truncated', header.slice(0, -1)], ['wrong header', 'Unexpected\n'],
  ['missing field', `${header}-\t0\n`], ['extra field', `${header}-\t0\ta\tb\n`],
  ['bad PID', `${header}abc\t0\ta\n`], ['bad status', `${header}-\tabc\ta\n`],
  ['empty label', `${header}-\t0\t\n`], ['duplicate label', `${header}-\t0\ta\n-\t0\ta\n`],
  ['blank row', `${header}\n`], ['truncated row', `${header}-\t0\ta`],
  ['present then malformed', `${header}-\t0\t${target}\nmalformed\n`],
]) {
  test(`unknown on ${name} listing`, () => {
    assert.equal(registrationState(manager, managerUid, ok(text), 501, target), 'unknown');
  });
}

function collector(overrides = {}) {
  const { expected, plist } = fixture();
  const calls = [];
  const deps = {
    uid: 501,
    run(command, args) {
      calls.push([command, ...args]);
      if (command === '/usr/bin/plutil') return ok(JSON.stringify(plist));
      return { managername: manager, manageruid: managerUid, list: ok(header) }[args[0]];
    },
    stat() { return { isFile: () => true, isSymbolicLink: () => false }; },
    canonicalize: value => value,
    ...overrides,
  };
  return { expected, plist, deps, calls };
}

test('collector uses plist path only after confirmed absence', () => {
  const { expected, deps, calls } = collector();
  assert.equal(inspectUninstall(expected, '/selected.plist', deps), 'owned');
  assert.deepEqual(calls, [
    ['/bin/launchctl', 'managername'], ['/bin/launchctl', 'manageruid'], ['/bin/launchctl', 'list'],
    ['/usr/bin/plutil', '-convert', 'json', '-o', '-', '/selected.plist'],
  ]);
});

for (const state of ['registered', 'unknown']) {
  test(`collector ${state} never examines disk`, () => {
    const { expected, deps } = collector({
      stat() { assert.fail('disk must not be examined'); },
      run(command, args) {
        assert.equal(command, '/bin/launchctl');
        if (args[0] === 'managername') return manager;
        if (args[0] === 'manageruid') return managerUid;
        return state === 'registered' ? ok(`${header}-\t0\t${target}\n`) : { status: 1, stdout: '' };
      },
    });
    assert.equal(inspectUninstall(expected, '/selected.plist', deps), state);
  });
}

for (const [name, overrides, result] of [
  ['missing file', { stat() { throw Object.assign(new Error(), { code: 'ENOENT' }); } }, 'absent'],
  ['unreadable file', { stat() { throw Object.assign(new Error(), { code: 'EACCES' }); } }, 'unknown'],
  ['directory', { stat() { return { isFile: () => false, isSymbolicLink: () => false }; } }, 'unknown'],
  ['symlink', { stat() { return { isFile: () => true, isSymbolicLink: () => true }; } }, 'unknown'],
  ['unresolved home', { canonicalize() { throw new Error('unresolved'); } }, 'unknown'],
]) {
  test(`collector handles ${name}`, () => {
    const { expected, deps } = collector(overrides);
    assert.equal(inspectUninstall(expected, '/selected.plist', deps), result);
  });
}

for (const [name, decoded, result] of [
  ['plutil failure', { status: 1, stdout: '' }, 'unknown'],
  ['plutil timeout', { status: null, stdout: '', error: new Error('timeout') }, 'unknown'],
  ['invalid JSON', ok('invalid'), 'unknown'],
  ['foreign plist', ok('{}'), 'foreign'],
]) {
  test(`collector handles ${name}`, () => {
    const { expected, deps } = collector();
    const original = deps.run;
    deps.run = (command, args) => command === '/usr/bin/plutil' ? decoded : original(command, args);
    assert.equal(inspectUninstall(expected, '/selected.plist', deps), result);
  });
}

test('uninstall call chain requires guard and does not stop or clear runtime state', () => {
  const source = readFileSync(new URL('../../scripts/supervisor-macos.sh', import.meta.url), 'utf8');
  const body = source.split('supervisor_uninstall() {\n')[1].split('\n}\n')[0];
  assert.ok(body.includes('macos-uninstall-identity.mjs'));
  assert.ok(body.includes('|| return 1'));
  assert.ok(body.indexOf('macos-uninstall-identity.mjs') < body.indexOf('case "$ownership" in'));
  assert.ok(body.includes('owned)'));
  for (const forbidden of ['supervisor_stop', 'supervisor_assert_selected_stopped', 'bootout', 'PID_FILE', 'kill']) {
    assert.equal(body.includes(forbidden), false, forbidden);
  }
});
