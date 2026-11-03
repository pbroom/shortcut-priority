import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../macos-shortcuts.sys.mjs', import.meta.url), 'utf8');

function harness({ abi = 1, result = 0, platformVersion = '159.0' } = {}) {
  const calls = [];
  let opens = 0, closes = 0;
  const functions = {
    sp_abi_version: () => abi,
    sp_set_window: (handle, enabled) => { calls.push([handle, enabled]); return result; },
    sp_status: () => 3,
    sp_window_count: () => 1,
    sp_intercept_count: () => 7,
  };
  const ctypes = {
    int32_t: 'int32_t', default_abi: 'default',
    uint64_t: value => value,
    UInt64: value => ({ exactAddress: value }),
    open(path) {
      opens++;
      assert.equal(path, '/mod/libshortcut-priority.dylib');
      return {
        declare(name, ...signature) {
          assert.deepEqual(signature, name === 'sp_set_window'
            ? ['default', 'int32_t', ctypes.uint64_t, 'int32_t']
            : ['default', 'int32_t']);
          assert.ok(functions[name]);
          return functions[name];
        },
        close() { closes++; },
      };
    },
  };
  const context = {
    Services: { appinfo: { OS: 'Darwin', platformVersion }, io: { newURI: value => value } },
    ChromeUtils: { importESModule(uri) {
      assert.equal(uri, 'resource://gre/modules/ctypes.sys.mjs');
      return { ctypes };
    } },
    Cc: { '@mozilla.org/chrome/chrome-registry;1': { getService: () => ({
      convertChromeURL(uri) {
        assert.equal(uri, 'chrome://sine/content/shortcut-priority/libshortcut-priority.dylib');
        return { QueryInterface: () => ({ file: { path: '/mod/libshortcut-priority.dylib' } }) };
      },
    }) } },
    Ci: {},
  };
  vm.runInNewContext(source.replaceAll('export function ', 'function ') +
    '\nthis.api = { setWindow, status };', context);
  const window = handle => ({ docShell: { treeOwner: {
    QueryInterface: () => ({ getInterface: () => ({ nativeHandle: handle }) }),
  } } });
  return { api: context.api, calls, window, get opens() { return opens; }, get closes() { return closes; } };
}

test('outbound native calls preserve 64-bit handles, unregister, and pin a single process library', () => {
  const h = harness();
  const first = h.window('0x20000000000001');
  const second = h.window('0x1234');
  h.api.setWindow(first, false);
  assert.equal(h.opens, 0);
  h.api.setWindow(first, true);
  h.api.setWindow(second, true);
  first.docShell = null; // Saved handle makes teardown independent of docshell lifetime.
  h.api.setWindow(first, false);
  assert.deepEqual(h.calls.map(([handle, enabled]) => [handle.exactAddress, enabled]), [
    ['0x20000000000001', 1], ['0x1234', 1], ['0x20000000000001', 0],
  ]);
  assert.equal(h.api.status(first).registered, false);
  assert.equal(h.api.status(second).registered, true);
  assert.equal(h.api.status(second).interceptCount, 7);
  assert.equal(h.opens, 1);
  assert.equal(h.closes, 0);
});

test('native ABI, version, invalid handle, and registration errors leave no false registration', () => {
  const wrongABI = harness({ abi: 2 });
  const window = wrongABI.window('0x1234');
  assert.throws(() => wrongABI.api.setWindow(window, true), /bridge ABI/);
  assert.equal(wrongABI.closes, 1, 'close only before hooks can be installed');
  const wrongVersion = harness({ platformVersion: '160.0' });
  assert.throws(() => wrongVersion.api.setWindow(window, true), /Gecko 159/);
  assert.equal(wrongVersion.opens, 0);
  const invalidHandle = harness();
  assert.throws(() => invalidHandle.api.setWindow(invalidHandle.window('0x0'), true), /Invalid native/);
  const failed = harness({ result: -3 });
  assert.throws(() => failed.api.setWindow(window, true), /failed: -3/);
  assert.equal(failed.api.status(window).registered, false);
  assert.equal(failed.closes, 0, 'never close after calling into the bridge');
});
