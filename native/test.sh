#!/bin/sh
set -eu
cd "$(dirname "$0")"
./build.sh
xcrun clang -fobjc-arc -Wall -Wextra -Werror -mmacosx-version-min=12.0 \
  -framework Cocoa test_native.m -Lbuild -lshortcut-priority \
  -Wl,-rpath,@executable_path -o build/test-native
./build/test-native
