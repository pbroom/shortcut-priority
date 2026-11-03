#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include "shortcut_priority.h"

typedef BOOL (*KeyEquivalentIMP)(id, SEL, NSEvent *);

static NSHashTable<NSWindow *> *sWindows;
static NSMutableArray *sPinnedBlocks;
static Method sWindowMethod;
static Method sMenuMethod;
static IMP sWindowHook;
static IMP sMenuHook;
static IMP sWindowOriginal;
static IMP sMenuOriginal;
static int32_t sInterceptCount;

static BOOL IsSubclass(Class cls, Class parent) {
  for (; cls; cls = class_getSuperclass(cls)) {
    if (cls == parent) return YES;
  }
  return NO;
}

// Never accept an inherited method: modifying it would affect AppKit itself.
static Method OwnKeyMethod(Class cls) {
  unsigned count = 0;
  Method result = NULL;
  Method *methods = class_copyMethodList(cls, &count);
  for (unsigned i = 0; i < count; ++i) {
    if (method_getName(methods[i]) == @selector(performKeyEquivalent:)) {
      result = methods[i];
      break;
    }
  }
  free(methods);
  if (!result || method_getNumberOfArguments(result) != 3) return NULL;
  char *returnType = method_copyReturnType(result);
  char *eventType = method_copyArgumentType(result, 2);
  BOOL valid = returnType && (returnType[0] == 'c' || returnType[0] == 'B') &&
               eventType && eventType[0] == '@';
  free(returnType);
  free(eventType);
  return valid ? result : NULL;
}

static BOOL OwnsEvent(NSWindow *window, NSEvent *event) {
  if (![NSThread isMainThread] || !window || !event ||
      ![sWindows containsObject:window] || NSApp.keyWindow != window ||
      NSApp.modalWindow || window.attachedSheet || window.sheetParent ||
      (event.window && event.window != window) ||
      event.type != NSEventTypeKeyDown) return NO;

  NSEventModifierFlags modifiers = event.modifierFlags &
      (NSEventModifierFlagDeviceIndependentFlagsMask & ~NSEventModifierFlagCapsLock);
  return modifiers == NSEventModifierFlagCommand &&
         [event.charactersIgnoringModifiers isEqualToString:@"`"];
}

static NSMenuItem *FindForwardItem(NSMenu *menu) {
  Class itemClass = NSClassFromString(@"GeckoNSMenuItem");
  Class targetClass = NSClassFromString(@"NativeMenuItemTarget");
  if (!itemClass || !targetClass) return nil;
  for (NSMenuItem *item in menu.itemArray) {
    if (item.hidden || !item.enabled) continue;
    if (item.submenu) {
      NSMenuItem *match = FindForwardItem(item.submenu);
      if (match) return match;
      continue;
    }
    // Regular Gecko 159 items do not expose their XUL id as an identifier.
    // Require every available native field of our specific View-menu item.
    if (![item isKindOfClass:itemClass] ||
        ![item.title isEqualToString:@"Tab Switcher (forward)"] ||
        ![item.keyEquivalent isEqualToString:@"`"] ||
        item.keyEquivalentModifierMask != NSEventModifierFlagCommand ||
        item.action != @selector(menuItemHit:) ||
        ![item.target isKindOfClass:targetClass]) continue;
    return item;
  }
  return nil;
}

static BOOL HandleOwnedEvent(NSWindow *window, NSEvent *event) {
  if (!OwnsEvent(window, event)) return NO;
  NSMenuItem *item = FindForwardItem(NSApp.mainMenu);
  NSMenu *menu = item.menu;
  NSInteger index = menu ? [menu indexOfItem:item] : -1;
  if (!item || index < 0) return NO;
  // This is Gecko's ordinary native-menu action entry, not an FFI callback.
  // It must run before GeckoNSMenu's original highlight-only pass temporarily
  // hides the real target/action behind gMenuItemsExecuteCommands = NO.
  [menu performActionForItemAtIndex:index];
  if (sInterceptCount < INT32_MAX) ++sInterceptCount;
  return YES;
}

static BOOL InstallHooks(void) {
  Class baseClass = NSClassFromString(@"BaseWindow");
  Class windowClass = NSClassFromString(@"ToolbarWindow");
  Class menuClass = NSClassFromString(@"GeckoNSMenu");
  if (!baseClass || !IsSubclass(baseClass, NSWindow.class) ||
      !IsSubclass(windowClass, baseClass) ||
      !IsSubclass(menuClass, NSMenu.class)) return NO;
  Method windowMethod = OwnKeyMethod(windowClass);
  Method menuMethod = OwnKeyMethod(menuClass);
  if (!windowMethod || !menuMethod) return NO;

  if (!sPinnedBlocks) sPinnedBlocks = [NSMutableArray array];
  SEL selector = @selector(performKeyEquivalent:);
  if (!sWindowHook) {
    // Each block captures its own original. Older hooks can remain in another
    // swizzler's chain after ours is removed/reinstalled.
    IMP original = method_getImplementation(windowMethod);
    id block = [^BOOL(id receiver, NSEvent *event) {
      if (HandleOwnedEvent(receiver, event)) return YES;
      return ((KeyEquivalentIMP)original)(receiver, selector, event);
    } copy];
    [sPinnedBlocks addObject:block];
    sWindowOriginal = original;
    sWindowMethod = windowMethod;
    sWindowHook = imp_implementationWithBlock(block);
    method_setImplementation(windowMethod, sWindowHook);
  }
  if (!sMenuHook) {
    IMP original = method_getImplementation(menuMethod);
    id block = [^BOOL(id receiver, NSEvent *event) {
      if (HandleOwnedEvent(NSApp.keyWindow, event)) return YES;
      return ((KeyEquivalentIMP)original)(receiver, selector, event);
    } copy];
    [sPinnedBlocks addObject:block];
    sMenuOriginal = original;
    sMenuMethod = menuMethod;
    sMenuHook = imp_implementationWithBlock(block);
    method_setImplementation(menuMethod, sMenuHook);
  }
  return YES;
}

static void RemoveHooksIfUnused(void) {
  if (sWindows.allObjects.count) return;
  if (sWindowHook && method_getImplementation(sWindowMethod) == sWindowHook)
    method_setImplementation(sWindowMethod, sWindowOriginal);
  if (sMenuHook && method_getImplementation(sMenuMethod) == sMenuHook)
    method_setImplementation(sMenuMethod, sMenuOriginal);
  // Do not remove IMP blocks: another interposer may retain either hook.
  sWindowHook = NULL;
  sMenuHook = NULL;
}

int32_t sp_abi_version(void) { return 1; }

int32_t sp_set_window(uint64_t handle, int32_t enabled) {
  if (![NSThread isMainThread]) return SP_WRONG_THREAD;
  if (!NSApp) return SP_NO_APPLICATION;
  @try {
    if (!sWindows) sWindows = [NSHashTable weakObjectsHashTable];
    if (!enabled) {
      for (NSWindow *window in sWindows.allObjects) {
        if ((uint64_t)(__bridge void *)window == handle)
          [sWindows removeObject:window];
      }
      RemoveHooksIfUnused();
      return 0;
    }
    // The address supplied by ctypes is only compared with trusted objects.
    NSWindow *found = nil;
    for (NSWindow *window in NSApp.windows) {
      if ((uint64_t)(__bridge void *)window == handle) {
        found = window;
        break;
      }
    }
    Class toolbarWindow = NSClassFromString(@"ToolbarWindow");
    if (!found || !toolbarWindow || ![found isKindOfClass:toolbarWindow])
      return SP_INVALID_WINDOW;
    if (!InstallHooks()) return SP_UNSUPPORTED_CLASSES;
    [sWindows addObject:found];
    return 0;
  } @catch (NSException *exception) {
    return SP_NATIVE_EXCEPTION;
  }
}

int32_t sp_status(void) {
  if (![NSThread isMainThread]) return SP_WRONG_THREAD;
  return (sWindowHook && method_getImplementation(sWindowMethod) == sWindowHook ? 1 : 0) |
         (sMenuHook && method_getImplementation(sMenuMethod) == sMenuHook ? 2 : 0);
}

int32_t sp_window_count(void) {
  if (![NSThread isMainThread]) return SP_WRONG_THREAD;
  return (int32_t)sWindows.allObjects.count;
}

int32_t sp_intercept_count(void) {
  if (![NSThread isMainThread]) return SP_WRONG_THREAD;
  return sInterceptCount;
}
