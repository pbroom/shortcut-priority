#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "shortcut_priority.h"

static unsigned sWindowCalls, sMenuCalls, sChainCalls, sAssertions, sActionCalls;
static NSArray<NSWindow *> *sFixtureWindows;
static NSWindow *sFixtureKeyWindow, *sFixtureModalWindow;
static BOOL sAttachedSheet;
static IMP sChainedOriginal;

@interface FixtureApplication : NSApplication @end
@implementation FixtureApplication
- (NSArray<NSWindow *> *)windows { return sFixtureWindows ?: @[]; }
- (NSWindow *)keyWindow { return sFixtureKeyWindow; }
- (NSWindow *)modalWindow { return sFixtureModalWindow; }
@end

@interface BaseWindow : NSWindow @end
@implementation BaseWindow @end

@interface ToolbarWindow : BaseWindow @end
@implementation ToolbarWindow
- (BOOL)performKeyEquivalent:(NSEvent *)event {
  (void)event;
  ++sWindowCalls;
  return YES;
}
- (NSWindow *)attachedSheet { return sAttachedSheet ? self : nil; }
@end

// Models native/runtime subclasses without changing any object's isa.
@interface FixtureToolbarSubclass : ToolbarWindow @end
@implementation FixtureToolbarSubclass @end

@interface GeckoNSMenu : NSMenu @end
@implementation GeckoNSMenu
- (BOOL)performKeyEquivalent:(NSEvent *)event {
  (void)event;
  ++sMenuCalls;
  return YES;
}
@end

@interface GeckoNSMenuItem : NSMenuItem @end
@implementation GeckoNSMenuItem @end

@interface NativeMenuItemTarget : NSObject
- (void)menuItemHit:(id)sender;
@end
@implementation NativeMenuItemTarget
- (void)menuItemHit:(id)sender { (void)sender; ++sActionCalls; }
@end

static BOOL ChainedWindow(id receiver, SEL selector, NSEvent *event) {
  ++sChainCalls;
  return ((BOOL (*)(id, SEL, NSEvent *))sChainedOriginal)(receiver, selector, event);
}

static void Check(BOOL condition, const char *message) {
  ++sAssertions;
  if (!condition) {
    fprintf(stderr, "FAIL: %s\n", message);
    exit(1);
  }
}

static NSEvent *Key(NSString *characters, NSEventModifierFlags modifiers,
                    NSEventType type) {
  return [NSEvent keyEventWithType:type location:NSZeroPoint modifierFlags:modifiers
      timestamp:0 windowNumber:0 context:nil characters:characters
      charactersIgnoringModifiers:characters isARepeat:NO keyCode:50];
}

int main(void) {
  @autoreleasepool {
    // Neither fixture window is ordered on screen. No browser is launched.
    [FixtureApplication sharedApplication];
    ToolbarWindow *window = [[FixtureToolbarSubclass alloc] initWithContentRect:NSMakeRect(0, 0, 10, 10)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    ToolbarWindow *other = [[ToolbarWindow alloc] initWithContentRect:NSMakeRect(0, 0, 10, 10)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    sFixtureWindows = @[window, other];
    sFixtureKeyWindow = window;
    GeckoNSMenu *menu = [[GeckoNSMenu alloc] initWithTitle:@"Fixture"];
    GeckoNSMenu *view = [[GeckoNSMenu alloc] initWithTitle:@"View"];
    view.autoenablesItems = NO;
    NSMenuItem *viewItem = [[NSMenuItem alloc] initWithTitle:@"View" action:NULL keyEquivalent:@""];
    viewItem.submenu = view;
    [menu addItem:viewItem];
    NativeMenuItemTarget *target = [NativeMenuItemTarget new];
    GeckoNSMenuItem *forward = [[GeckoNSMenuItem alloc] initWithTitle:@"Tab Switcher (forward)"
        action:@selector(menuItemHit:) keyEquivalent:@"`"];
    forward.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    forward.target = target;
    [view addItem:forward];
    NSApp.mainMenu = menu;
    NSEvent *grave = Key(@"`", NSEventModifierFlagCommand, NSEventTypeKeyDown);
    Check(sp_abi_version() == 1, "expected ABI version");
    Check(sp_set_window(1, 1) == SP_INVALID_WINDOW, "invalid address rejected without dereference");
    Check(sp_status() == 0, "invalid registration leaves methods untouched");
    Check(sp_set_window((uint64_t)(__bridge void *)window, 1) == 0, "live window registered");
    Check(sp_status() == 3 && sp_window_count() == 1, "both hooks active");
    Check(sp_set_window((uint64_t)(__bridge void *)window, 1) == 0 &&
          sp_window_count() == 1, "registration is idempotent");
    Check([window performKeyEquivalent:grave] && sActionCalls == 1,
          "owned Cmd grave dispatches window native action exactly once");
    Check([menu performKeyEquivalent:grave] && sActionCalls == 2,
          "owned Cmd grave dispatches menu native action exactly once");
    Check(sWindowCalls == 0 && sMenuCalls == 0, "owned key never calls originals");
    Check(sp_intercept_count() == 2, "native hook diagnostic counts both sites");
    forward.enabled = NO;
    Check([window performKeyEquivalent:grave] && sActionCalls == 2,
          "disabled row does not dispatch");
    forward.enabled = YES;
    forward.hidden = YES;
    Check([menu performKeyEquivalent:grave] && sActionCalls == 2,
          "hidden row does not dispatch");
    forward.hidden = NO;
    viewItem.hidden = YES;
    Check([window performKeyEquivalent:grave] && sActionCalls == 2,
          "hidden ancestor does not dispatch");
    viewItem.hidden = NO;
    forward.title = @"Other command";
    Check([window performKeyEquivalent:grave] && sActionCalls == 2,
          "matching key on another title does not dispatch");
    forward.title = @"Tab Switcher (forward)";
    forward.keyEquivalent = @"1";
    Check([window performKeyEquivalent:grave] && sActionCalls == 2,
          "different native key does not dispatch");
    forward.keyEquivalent = @"`";
    forward.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    Check([window performKeyEquivalent:grave] && sActionCalls == 2,
          "different native modifiers do not dispatch");
    forward.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    forward.action = @selector(description);
    Check([window performKeyEquivalent:grave] && sActionCalls == 2,
          "unexpected action selector does not dispatch");
    forward.action = @selector(menuItemHit:);
    forward.target = nil;
    Check([window performKeyEquivalent:grave] && sActionCalls == 2,
          "missing native target does not dispatch");
    forward.target = target;

    NSEvent *stale = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
        modifierFlags:NSEventModifierFlagCommand timestamp:0 windowNumber:other.windowNumber
        context:nil characters:@"`" charactersIgnoringModifiers:@"`" isARepeat:NO keyCode:50];
    Check(stale.window == other, "fixture event identifies the other native window");
    Check([window performKeyEquivalent:stale] && [menu performKeyEquivalent:stale],
          "event from a different window passes through");
    Check(sp_intercept_count() == 2, "non-owned event does not increment diagnostic");

    NSArray *otherKeys = @[
      Key(@"1", NSEventModifierFlagCommand, NSEventTypeKeyDown),
      Key(@"`", 0, NSEventTypeKeyDown),
      Key(@"`", NSEventModifierFlagCommand | NSEventModifierFlagShift, NSEventTypeKeyDown),
      Key(@"`", NSEventModifierFlagCommand | NSEventModifierFlagControl, NSEventTypeKeyDown),
      Key(@"`", NSEventModifierFlagCommand | NSEventModifierFlagOption, NSEventTypeKeyDown),
      Key(@"`", NSEventModifierFlagCommand, NSEventTypeKeyUp)
    ];
    for (NSEvent *event in otherKeys) {
      Check([window performKeyEquivalent:event], "other key passes window original");
      Check([menu performKeyEquivalent:event], "other key passes menu original");
    }
    Check([window performKeyEquivalent:Key(@"`", NSEventModifierFlagCommand |
        NSEventModifierFlagCapsLock, NSEventTypeKeyDown)], "Caps Lock does not change shortcut");
    Check([other performKeyEquivalent:grave], "unregistered receiver passes through");
    sFixtureKeyWindow = other;
    Check([window performKeyEquivalent:grave], "background window passes through");
    Check([menu performKeyEquivalent:grave], "unregistered key window passes through");
    sFixtureKeyWindow = window;
    sAttachedSheet = YES;
    Check([window performKeyEquivalent:grave] && [menu performKeyEquivalent:grave],
          "attached sheet passes through");
    sAttachedSheet = NO;
    sFixtureModalWindow = other;
    Check([window performKeyEquivalent:grave] && [menu performKeyEquivalent:grave],
          "modal session passes through");
    sFixtureModalWindow = nil;

    __block int32_t threadResult = 0;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      threadResult = sp_set_window((uint64_t)(__bridge void *)window, 0);
      dispatch_semaphore_signal(done);
    });
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    Check(threadResult == SP_WRONG_THREAD && sp_window_count() == 1,
          "worker thread cannot mutate registration");

    Method method = class_getInstanceMethod(ToolbarWindow.class, @selector(performKeyEquivalent:));
    sChainedOriginal = method_setImplementation(method, (IMP)ChainedWindow);
    Check(sp_set_window((uint64_t)(__bridge void *)window, 0) == 0, "unregister with later hook");
    Check(method_getImplementation(method) == (IMP)ChainedWindow, "later hook preserved");
    Check(sp_status() == 0 && sp_window_count() == 0, "registration removed");
    Check([window performKeyEquivalent:grave], "old hook in chain falls through when disabled");
    Check(sp_set_window((uint64_t)(__bridge void *)window, 1) == 0, "reinstall above chain");
    Check([window performKeyEquivalent:grave], "reinstalled hook owns shortcut");
    unsigned calls = sWindowCalls;
    unsigned chainCalls = sChainCalls;
    Check([window performKeyEquivalent:otherKeys[0]], "other key traverses reinstalled chain");
    Check(sWindowCalls == calls + 1 && sChainCalls == chainCalls + 1,
          "immutable originals avoid recursion and duplicate dispatch");
    Check(sp_set_window((uint64_t)(__bridge void *)window, 0) == 0, "final unregister");
    Check(method_getImplementation(method) == (IMP)ChainedWindow, "restores prior chain");
    Check([window performKeyEquivalent:grave], "disabled Cmd grave passes through again");
    Check(sp_set_window((uint64_t)(__bridge void *)window, 1) == 0 &&
          sp_set_window((uint64_t)(__bridge void *)other, 1) == 0 &&
          sp_window_count() == 2, "multiple windows register independently");
    Check(sp_set_window((uint64_t)(__bridge void *)other, 0) == 0 &&
          sp_window_count() == 1 && sp_status() == 3, "removing one window keeps hooks");
    Check([window performKeyEquivalent:grave], "remaining window still owns shortcut");
    Check(sp_set_window((uint64_t)(__bridge void *)window, 0) == 0 &&
          sp_window_count() == 0 && sp_status() == 0, "last window removes current hooks");
    printf("PASS: %u native fixture assertions\n", sAssertions);
  }
  return 0;
}
