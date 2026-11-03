#ifndef SHORTCUT_PRIORITY_NATIVE_H
#define SHORTCUT_PRIORITY_NATIVE_H
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ABI version is thread-independent. Other APIs are main-thread only.
int32_t sp_abi_version(void);
// Returns 0 on success; negative values are errors below.
// Enabling accepts only a live ToolbarWindow (or subclass) from NSApp.windows.
// Disabling also
// accepts a closed window's former address, without dereferencing it.
int32_t sp_set_window(uint64_t window_handle, int32_t enabled);
// Bits: 1 = our ToolbarWindow IMP is current, 2 = our GeckoNSMenu IMP is current.
// A third-party hook installed above ours may leave a bit unset while still
// chaining through us. Negative return values are errors.
int32_t sp_status(void);
int32_t sp_window_count(void);
// Total native menu actions dispatched for an owned key; saturates at INT32_MAX.
// Does not reset on unregister.
int32_t sp_intercept_count(void);

enum {
  SP_WRONG_THREAD = -1,
  SP_NO_APPLICATION = -2,
  SP_INVALID_WINDOW = -3,
  SP_UNSUPPORTED_CLASSES = -4,
  SP_NATIVE_EXCEPTION = -5
};

#ifdef __cplusplus
}
#endif
#endif
