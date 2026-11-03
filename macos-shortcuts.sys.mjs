// Outbound calls only. Cocoa callbacks stay in the compiled library; they never
// enter JavaScript through js-ctypes.
const windows = new WeakMap();
let native;

function openNative() {
  if (native) return native;
  if (Services.appinfo.OS !== "Darwin" ||
      Services.appinfo.platformVersion.split(".")[0] !== "159") {
    throw new Error("Native shortcut bridge supports macOS Gecko 159 only");
  }
  const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
  const uri = Services.io.newURI(
    "chrome://sine/content/shortcut-priority/libshortcut-priority.dylib"
  );
  const file = Cc["@mozilla.org/chrome/chrome-registry;1"]
    .getService(Ci.nsIChromeRegistry).convertChromeURL(uri)
    .QueryInterface(Ci.nsIFileURL).file;
  const library = ctypes.open(file.path);
  try {
    const declare = (name, ...args) =>
      library.declare(name, ctypes.default_abi, ctypes.int32_t, ...args);
    const version = declare("sp_abi_version");
    if (version() !== 1) throw new Error("Unsupported native shortcut bridge ABI");
    native = {
      ctypes, library,
      setWindow: declare("sp_set_window", ctypes.uint64_t, ctypes.int32_t),
      status: declare("sp_status"),
      windowCount: declare("sp_window_count"),
      interceptCount: declare("sp_intercept_count"),
    };
    // The system-module global pins the library for the process lifetime, even
    // after its last browser window closes. Never dlclose installed IMPs.
    return native;
  } catch (error) {
    library.close();
    throw error;
  }
}

export function setWindow(window, enabled) {
  const oldHandle = windows.get(window);
  if (!enabled && !oldHandle) return;
  const n = openNative();
  const handle = oldHandle || window.docShell.treeOwner
    .QueryInterface(Ci.nsIInterfaceRequestor)
    .getInterface(Ci.nsIBaseWindow).nativeHandle;
  if (!/^0x[0-9a-f]+$/i.test(handle) || /^0x0+$/i.test(handle)) {
    throw new Error("Invalid native browser window handle");
  }
  // Keep the hexadecimal pointer as a UInt64; a JS Number can lose address bits.
  const result = n.setWindow(n.ctypes.uint64_t(n.ctypes.UInt64(handle)), enabled ? 1 : 0);
  if (result !== 0) throw new Error("Native shortcut registration failed: " + result);
  if (enabled) windows.set(window, handle);
  else windows.delete(window);
}

export function status(window) {
  return {
    loaded: !!native,
    registered: windows.has(window),
    hooks: native?.status() ?? 0,
    windowCount: native?.windowCount() ?? 0,
    interceptCount: native?.interceptCount() ?? 0,
  };
}
