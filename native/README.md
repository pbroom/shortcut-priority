# Compiled native shortcut bridge

This narrow local adapter leaves the installed Zen executable and its signature
untouched. It has no JavaScript callback. JavaScript calls the C ABI to register
the native window only while Shortcut Priority owns Command+backtick. The caller
must pin the ctypes library for the entire process lifetime, including after
unregistering, because another native hook may retain our IMP in its chain.

The two hook sites were checked against Gecko 159's `ToolbarWindow` in
`widget/cocoa/nsCocoaWindow.mm` and `GeckoNSMenu` in `widget/cocoa/nsMenuBarX.mm`.
`ToolbarWindow` inherits from `BaseWindow`, but owns the method being hooked;
`BaseWindow` itself has no own implementation. The former forwards into NSWindow,
which can consume the macOS window-cycle key;
the latter performs the old native menu highlight pass before Gecko DOM handling.
Simply returning `NO` at both sites proved insufficient in an installed-browser
test: native hook counters advanced but no Gecko command ran. The hooks instead
find the mod's visible, enabled forward item in the current native menu and invoke
its ordinary `performActionForItemAtIndex:` action, then return `YES` to consume
the event exactly once. Gecko's `NativeMenuItemTarget::menuItemHit:` routes that
action to `nsMenuX::ActivateItemAfterClosing` and `nsMenuItemX::DoCommand`, using
Gecko's normal native-menu entry into the command handler. Other input and missing
or mismatched menu rows call the original implementation.

The matcher requires `GeckoNSMenuItem`, the exact title `Tab Switcher (forward)`,
backtick plus Command as the native equivalent, and `NativeMenuItemTarget` with
the `menuItemHit:` action. Gecko does not assign the XUL id to regular items;
AppKit may generate an identifier such as `menuItemHit:`, so that identifier
cannot prove which command the row owns. No private C++ object is dereferenced.

Only a Command-only key-down whose `charactersIgnoringModifiers` is backtick is
intercepted. Caps Lock is ignored; Shift, Control, Option, Function and numeric-pad
flags do not match. Sheets, modal sessions, background and unregistered windows
fall through. An event identifying a different native window also falls through.
Command+1 already reaches Gecko and needs no native interception.

Run `./test.sh` to build and ad-hoc sign the universal macOS 12+ library and run
the standalone native fixture harness. The harness creates two invisible fixture
windows without launching or modifying Zen. The fixtures verify hook behavior
and lifecycle; they do not prove AppKit-to-Gecko routing in the installed browser.
Both architectures compile; the harness runs only the host architecture.

The exported ABI is in `shortcut_priority.h`. `sp_abi_version()` returns 1.
All other functions must be called on the main thread. Enable requests compare
the numeric native handle with `NSApp.windows` before using the object. The weak
registration table does not retain windows. Disable is safe after a window closes.
`sp_intercept_count()` reports native menu actions dispatched for owned keys, so a
runtime test can distinguish native interception from DOM-only behavior. The count
persists across unregistering.
Removing the last registration restores each implementation only if it is still
ours. Hook blocks remain allocated permanently to preserve later native hook chains.

This is a local adapter, not an upstream Gecko patch. Real keyboard delivery was
verified on stock Zen 1.24b / Gecko 159 on arm64; x86_64 was compiled, not run.
Do not close/unload the dynamic library after use. A browser restart is required
to load a rebuilt library reliably.
