fn main() {
    // Bake the Google OAuth client from the project-root .env into the binary
    // as defaults (the settings screen can still override them per device).
    // Desktop-app client secrets are not confidential per Google's docs.
    println!("cargo:rerun-if-changed=../.env");
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
