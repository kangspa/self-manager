# Environment for `npm run tauri android build/dev` on Windows.
# Usage (PowerShell):
#   . .\scripts\android-env.ps1
#   npm run tauri android build -- --apk --target aarch64
#
# llama-cpp-sys-2 locates the NDK from ANDROID_NDK and builds llama.cpp/ggml
# with the NDK toolchain itself; whisper-lite is compiled by the cc crate with
# the NDK clang that the Tauri CLI exports.

$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$ndk = (Get-ChildItem "$sdk\ndk" | Sort-Object Name -Descending | Select-Object -First 1).FullName
$cmake = (Get-ChildItem "$sdk\cmake" | Sort-Object Name -Descending | Select-Object -First 1).FullName
$jdk = (Get-ChildItem "C:\Program Files\Microsoft" -Filter "jdk-17*" | Select-Object -First 1).FullName

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:NDK_HOME = $ndk
$env:ANDROID_NDK = $ndk
$env:ANDROID_PLATFORM = "android-24"
# Ninja from the SDK's CMake package (the Visual Studio generator cannot target Android).
$env:PATH = "$cmake\bin;$jdk\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:CMAKE_GENERATOR = "Ninja"

Write-Host "Android build env ready (NDK $ndk)"
