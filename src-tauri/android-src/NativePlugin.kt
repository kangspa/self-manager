package com.selfmanager.app

import android.accounts.Account
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import android.text.TextUtils
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope

@InvokeArg
class AuthArgs {
    var interactive: Boolean = true
    var scopes: Array<String> = arrayOf()
    /** The signed-in account's address: a silent request asks for exactly that account. */
    var account: String? = null
}

@InvokeArg
class WatchArgs {
    var packages: Array<String> = arrayOf()
}

/**
 * Android-only bridge used from Rust (src/mobile.rs):
 * Google authorization, the notification-listener queue, and the app list.
 */
@TauriPlugin
class NativePlugin(private val activity: Activity) : Plugin(activity) {

    // ---------- Google (Identity Services AuthorizationClient) ----------

    @Command
    fun googleAuthorize(invoke: Invoke) {
        val args = invoke.parseArgs(AuthArgs::class.java)
        val scopes = args.scopes.filter { it.startsWith("https://") }.map { Scope(it) }
        val builder = AuthorizationRequest.builder().setRequestedScopes(scopes)
        args.account?.takeIf { it.isNotBlank() }?.let { builder.setAccount(Account(it, "com.google")) }
        val request = builder.build()
        Identity.getAuthorizationClient(activity).authorize(request)
            .addOnSuccessListener { result ->
                if (result.hasResolution()) {
                    if (!args.interactive) {
                        invoke.reject("구글 재로그인이 필요합니다")
                        return@addOnSuccessListener
                    }
                    // Launch the consent screen; the result arrives in onAuthResult.
                    val req = IntentSenderRequest.Builder(result.pendingIntent!!.intentSender).build()
                    startIntentSenderForResult(invoke, req, "onAuthResult")
                } else {
                    resolve(invoke, result)
                }
            }
            .addOnFailureListener { e -> invoke.reject(e.message ?: "authorization failed") }
    }

    @ActivityCallback
    fun onAuthResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.reject("구글 로그인이 취소됐습니다")
            return
        }
        try {
            val auth = Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(result.data)
            resolve(invoke, auth)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "authorization failed")
        }
    }

    private fun resolve(invoke: Invoke, r: AuthorizationResult) {
        val token = r.accessToken
        if (token.isNullOrEmpty()) {
            invoke.reject("access token 없음")
            return
        }
        val ret = JSObject()
        ret.put("accessToken", token)
        invoke.resolve(ret)
    }

    // ---------- Notification listener ----------

    @Command
    fun setWatchedPackages(invoke: Invoke) {
        val args = invoke.parseArgs(WatchArgs::class.java)
        NotificationStore.setWatched(activity, args.packages.toSet())
        invoke.resolve(JSObject())
    }

    @Command
    fun drainNotifications(invoke: Invoke) {
        val items = JSArray()
        for (n in NotificationStore.drain(activity)) items.put(n)
        val ret = JSObject()
        ret.put("items", items)
        invoke.resolve(ret)
    }

    @Command
    fun notificationAccess(invoke: Invoke) {
        val flat = Settings.Secure.getString(activity.contentResolver, "enabled_notification_listeners") ?: ""
        val me = ComponentName(activity, NotificationListener::class.java).flattenToString()
        val granted = flat.split(":").any { TextUtils.equals(it, me) }
        val ret = JSObject()
        ret.put("granted", granted)
        invoke.resolve(ret)
    }

    @Command
    fun openNotificationSettings(invoke: Invoke) {
        activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        invoke.resolve(JSObject())
    }

    /** Apps that posted notifications recently (most useful candidates first). */
    @Command
    fun recentPackages(invoke: Invoke) {
        val arr = JSArray()
        val pm = activity.packageManager
        for (pkg in NotificationStore.recent(activity)) {
            val label = try { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() } catch (e: Exception) { pkg }
            arr.put(JSObject().put("package", pkg).put("label", label))
        }
        invoke.resolve(JSObject().put("apps", arr))
    }

    /** Launcher apps (visible without QUERY_ALL_PACKAGES via the <queries> entry in the manifest). */
    @Command
    fun listApps(invoke: Invoke) {
        val pm = activity.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(intent, PackageManager.MATCH_ALL)
            .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
            .distinctBy { it.first }
            .filter { it.first != activity.packageName }
            .sortedBy { it.second }
        val arr = JSArray()
        for ((pkg, label) in apps) arr.put(JSObject().put("package", pkg).put("label", label))
        invoke.resolve(JSObject().put("apps", arr))
    }
}
