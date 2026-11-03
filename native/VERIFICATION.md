# Local verification — 2026-11-02

Tested the installed, vendor-signed Zen 1.24b (Gecko 159, build
20261029123729), on an arm64 Mac. Sine 2.3.4.1c loaded the script, system
module, and locally built universal library through its existing bootstrap.
The Zen app bundle was not modified or re-signed.

## Observed behavior

- An isolated profile loaded the mod through actual Sine startup, with the
  saved Command+backtick forward and Command+1 backward bindings. Native
  diagnostics reported both hooks installed, one registered window, no error.
- Real desktop Command+backtick changed test tab C to B. The command counter
  and native interception counter each increased by exactly one; the preview
  was closed after Command release.
- Real desktop Command+1 selected A from the backward end of the recent list,
  with one backward command and the preview closed after release.
- Prefer Websites removed both hooks and the window registration. Real
  Command+backtick then left the tab and command counters unchanged. Prefer
  Zen restored registration and the shortcut worked again.
- Use Both, disabling the priority pref, and remapping the forward key each
  withdrew registration. Restoring the configured binding/state restored it.
- Actual Sine unload removed the keys and native registrations (hooks=0,
  windows=0). Sine reload restored them, and another real key press worked.
- Native test events held the switcher open for repeated forward traversal;
  a modifier-release event closed it without another command. This is native
  event injection, separate from the real desktop checks above.
- After normal test-process exits, a fresh process loaded the final bridge
  through Sine. The same files were then installed in the regular profile and
  Zen was started normally. Real Command+backtick and Command+1 both switched
  tabs there. Only the two owned local test tabs were closed afterward.

## Automated checks

- `npm test`: 20 tests passed.
- `./native/test.sh`: 55 native fixture assertions passed; universal arm64 and
  x86_64 compilation and library signature verification passed.
- Sol reviewed the adapter/lifecycle and then the changed native dispatch:
  two rounds, approved, no actionable findings.

The native fixture alone does not prove AppKit routing. An earlier version
that returned `NO` passed filtering tests but failed the real desktop check:
the hooks saw the key, yet no Gecko command ran. The final version invokes the
normal Gecko menu action and consumes the key. Earlier JavaScript FFI callback
experiments are not part of this implementation.

Scope: Gecko 159 only; x86_64 execution, future browser releases, and recording
a previously empty Command+backtick binding were not verified. Missing native
files or an unsupported Gecko version leave ordinary shortcut priority usable.
