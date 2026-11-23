// Applies this app's Android-specific pieces to the Tauri-generated project
// (src-tauri/gen/android). Run once after `npm run tauri android init`; safe to re-run.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const gen = path.join(root, "src-tauri", "gen", "android", "app");
if (!fs.existsSync(gen)) {
  console.error("src-tauri/gen/android 가 없습니다. 먼저 `npm run tauri android init` 을 실행하세요.");
  process.exit(1);
}

// 1. Kotlin sources next to MainActivity.kt
const javaDir = path.join(gen, "src", "main", "java", "com", "selfmanager", "app");
fs.mkdirSync(javaDir, { recursive: true });
for (const f of fs.readdirSync(path.join(root, "src-tauri", "android-src"))) {
  if (f.endsWith(".kt")) fs.copyFileSync(path.join(root, "src-tauri", "android-src", f), path.join(javaDir, f));
}

// 2. Manifest: permissions, launcher-app visibility, notification listener service
const manifestPath = path.join(gen, "src", "main", "AndroidManifest.xml");
let m = fs.readFileSync(manifestPath, "utf8");
const MARK = "<!-- self-manager -->";
if (!m.includes(MARK)) {
  const perms = `${MARK}
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <queries>
        <intent>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent>
    </queries>
`;
  m = m.replace(/(<application\b)/, `${perms}    $1`);
  const service = `
        <service
            android:name=".NotificationListener"
            android:exported="false"
            android:label="Self Manager 가계부"
            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
            <intent-filter>
                <action android:name="android.service.notification.NotificationListenerService" />
            </intent-filter>
        </service>
`;
  m = m.replace(/(\s*<\/application>)/, `${service}$1`);
  fs.writeFileSync(manifestPath, m);
}

// 3. Google Identity (AuthorizationClient) dependency
const gradlePath = path.join(gen, "build.gradle.kts");
let g = fs.readFileSync(gradlePath, "utf8");
if (!g.includes("play-services-auth")) {
  g = g.replace(/dependencies\s*\{/, `dependencies {\n    implementation("com.google.android.gms:play-services-auth:21.3.0")`);
  fs.writeFileSync(gradlePath, g);
}

// 4. whisper.cpp links libc++_shared; the APK must ship it or the app crashes on start.
const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
const ndkRoot = process.env.NDK_HOME || (fs.existsSync(path.join(sdk, "ndk")) ? path.join(sdk, "ndk", fs.readdirSync(path.join(sdk, "ndk")).sort().pop()) : "");
const host = process.platform === "win32" ? "windows-x86_64" : process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64";
const libRoot = path.join(ndkRoot, "toolchains", "llvm", "prebuilt", host, "sysroot", "usr", "lib");
const abis = { "aarch64-linux-android": "arm64-v8a", "arm-linux-androideabi": "armeabi-v7a", "x86_64-linux-android": "x86_64", "i686-linux-android": "x86" };
for (const [triple, abi] of Object.entries(abis)) {
  const src = path.join(libRoot, triple, "libc++_shared.so");
  if (!fs.existsSync(src)) continue;
  const dst = path.join(gen, "src", "main", "jniLibs", abi);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(src, path.join(dst, "libc++_shared.so"));
}

// 5. No Android system backup: the app has its own Drive backup, and the data
// folder holds sign-in tokens that must not be restored onto another phone.
// allowBackup=false stops cloud backup; from Android 12 device-to-device
// transfer needs the extraction rules as well.
const xmlDir = path.join(gen, "src", "main", "res", "xml");
fs.mkdirSync(xmlDir, { recursive: true });
const domains = ["root", "file", "database", "sharedpref", "external"].map((d) => `        <exclude domain="${d}" path="." />`).join("\n");
fs.writeFileSync(
  path.join(xmlDir, "data_extraction_rules.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- self-manager: nothing is backed up or moved by Android itself (see android-setup.mjs). -->
<data-extraction-rules>
    <cloud-backup>
${domains}
    </cloud-backup>
    <device-transfer>
${domains}
    </device-transfer>
</data-extraction-rules>
`,
);
let m2 = fs.readFileSync(manifestPath, "utf8");
if (!m2.includes("android:allowBackup")) {
  m2 = m2.replace(/<application\b/, `<application\n        android:allowBackup="false"\n        android:dataExtractionRules="@xml/data_extraction_rules"`);
  fs.writeFileSync(manifestPath, m2);
}

// 6. Release APKs are signed with this PC's debug key: the Android OAuth client
// in Google Cloud is registered with that key's SHA-1, so Google login keeps
// working and a release installs over the debug build. Switching to a real
// release key means registering its SHA-1 first.
let g2 = fs.readFileSync(gradlePath, "utf8");
const SIGN_MARK = "// self-manager: release signing";
if (!g2.includes(SIGN_MARK)) {
  g2 = g2.replace(/getByName\("release"\)\s*\{/, (s) => `${s}\n            ${SIGN_MARK} (see scripts/android-setup.mjs)\n            signingConfig = signingConfigs.getByName("debug")`);
  fs.writeFileSync(gradlePath, g2);
}

console.log("Android 설정을 적용했습니다:", path.relative(root, javaDir));
