#![cfg_attr(not(target_os = "android"), allow(dead_code))]
//! Bridge to the Android-only Kotlin plugin (`NativePlugin.kt`): Google
//! authorization, notification-listener queue, installed app list.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri::Manager;

use crate::error::{Error, Result};

#[cfg(target_os = "android")]
pub struct Native<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("com.selfmanager.app", "NativePlugin")?;
                _app.manage(Native(handle));
            }
            Ok(())
        })
        .build()
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAuth {
    pub access_token: String,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthArgs {
    interactive: bool,
    scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<String>,
    /// Show the phone's account chooser first (login; profiles hold different accounts).
    pick_account: bool,
}

#[allow(unused_variables)]
fn run<T: serde::de::DeserializeOwned, A: Serialize>(app: &AppHandle, cmd: &str, args: A) -> Result<T> {
    #[cfg(target_os = "android")]
    {
        let n = app.state::<Native<tauri::Wry>>();
        return n.0.run_mobile_plugin(cmd, args).map_err(|e| Error::msg(e.to_string()));
    }
    #[allow(unreachable_code)]
    Err(Error::msg("Android에서만 사용할 수 있는 기능입니다"))
}

/// NativePlugin.kt rejects a silent authorization with exactly this text when
/// Google wants the user to consent again (e.g. the grant expired).
pub const NEEDS_CONSENT: &str = "구글 재로그인이 필요합니다";

/// `account`: ask for that account only (silent refresh of the signed-in one);
/// None lets the user pick (login).
pub fn google_authorize(app: &AppHandle, interactive: bool, account: Option<&str>, pick_account: bool) -> Result<GoogleAuth> {
    let scopes = crate::google::SCOPES.split(' ').map(String::from).collect();
    run(app, "googleAuthorize", AuthArgs { interactive, scopes, account: account.map(String::from), pick_account })
}

#[derive(Deserialize, Serialize, Default)]
pub struct Empty {}

/// Pulls queued notifications captured by the listener service (and clears the queue).
pub fn drain_notifications(app: &AppHandle) -> Result<Vec<crate::notif::RawNotification>> {
    #[derive(Deserialize)]
    struct R {
        items: Vec<crate::notif::RawNotification>,
    }
    let r: R = run(app, "drainNotifications", Empty {})?;
    Ok(r.items)
}

/// Tells the listener which packages to capture.
pub fn set_watched(app: &AppHandle, packages: Vec<String>) -> Result<()> {
    #[derive(Serialize)]
    struct A {
        packages: Vec<String>,
    }
    let _: Value = run(app, "setWatchedPackages", A { packages })?;
    Ok(())
}

/// Copies `path` into the phone's Download folder under `name` (Android 10+),
/// or where the user picks (older). Returns where it went, for the message.
pub fn save_to_downloads(app: &AppHandle, path: &std::path::Path, name: &str, mime: &str) -> Result<String> {
    #[derive(Serialize)]
    struct A<'a> {
        path: String,
        name: &'a str,
        mime: &'a str,
    }
    let r: Value = run(app, "saveToDownloads", A { path: path.to_string_lossy().into_owned(), name, mime })?;
    Ok(r["place"].as_str().unwrap_or(name).to_string())
}

pub fn passthrough(app: &AppHandle, cmd: &str) -> Result<Value> {
    match cmd {
        "listApps" | "notificationAccess" | "openNotificationSettings" | "recentPackages" => run(app, cmd, Empty {}),
        _ => Err(Error::msg("unknown native command")),
    }
}
