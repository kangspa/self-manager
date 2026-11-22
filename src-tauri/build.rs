fn main() {
    // Bake the Google OAuth client from the project-root .env into the binary
    // (users never enter one).
    // Desktop-app client secrets are not confidential per Google's docs.
    // Declaring any rerun-if-changed replaces cargo's default "any file in the
    // package", so the icons and config must be listed too, or a new icon
    // never reaches the exe's resources.
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities");
    if let Ok(env) = std::fs::read_to_string("../.env") {
        for line in env.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let v = v.trim().trim_matches('"').trim_matches('\'');
                match k.trim() {
                    "GOOGLE_CLIENT_ID" => println!("cargo:rustc-env=SM_GOOGLE_CLIENT_ID={v}"),
                    "GOOGLE_CLIENT_SECRET" => println!("cargo:rustc-env=SM_GOOGLE_CLIENT_SECRET={v}"),
                    _ => {}
                }
            }
        }
    }
    tauri_build::build()
}
