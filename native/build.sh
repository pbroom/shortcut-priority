#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p build
xcrun clang -dynamiclib -fobjc-arc -Wall -Wextra -Werror \
  -mmacosx-version-min=12.0 -arch arm64 -arch x86_64 -framework Cocoa \
  -Wl,-install_name,@rpath/libshortcut-priority.dylib \
  shortcut_priority.m -o build/libshortcut-priority.dylib
codesign --force --sign - build/libshortcut-priority.dylib
file build/libshortcut-priority.dylib
codesign --verify --strict build/libshortcut-priority.dylib
