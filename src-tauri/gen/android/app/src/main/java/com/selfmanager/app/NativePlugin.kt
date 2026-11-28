package com.selfmanager.app

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.ContentValues
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
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
    /** Show the phone's account chooser first (login: each profile holds its own account). */
    var pickAccount: Boolean = false
}

@InvokeArg
class SaveArgs {
    var path: String = ""
    var name: String = ""
    var mime: String = "application/octet-stream"
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
        if (args.pickAccount) {
            // Without an account Google silently reuses the last one, so another
            // account could never be added. The system chooser needs no permission.
            val intent = AccountManager.newChooseAccountIntent(null, null, arrayOf("com.google"), null, null, null, null)
            startActivityForResult(invoke, intent, "onAccountPicked")
            return
        }
        authorize(invoke, args, args.account)
    }

    @ActivityCallback
    fun onAccountPicked(invoke: Invoke, result: ActivityResult) {
        val name = result.data?.getStringExtra(AccountManager.KEY_ACCOUNT_NAME)
        if (result.resultCode != Activity.RESULT_OK || name.isNullOrBlank()) {
            invoke.reject("구글 로그인이 취소됐습니다")
            return
        }
        authorize(invoke, invoke.parseArgs(AuthArgs::class.java), name)
    }

    private fun authorize(invoke: Invoke, args: AuthArgs, account: String?) {
        val scopes = args.scopes.filter { it.startsWith("https://") }.map { Scope(it) }
        val builder = AuthorizationRequest.builder().setRequestedScopes(scopes)
        account?.takeIf { it.isNotBlank() }?.let { builder.setAccount(Account(it, "com.google")) }
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

    /**
     * Launcher apps (visible without QUERY_ALL_PACKAGES via the <queries> entry
     * in the manifest), each with a small icon so the list can be scanned by eye.
     */
    @Command
    fun listApps(invoke: Invoke) {
        val pm = activity.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(intent, PackageManager.MATCH_ALL)
            .distinctBy { it.activityInfo.packageName }
            .filter { it.activityInfo.packageName != activity.packageName }
            .map { Triple(it.activityInfo.packageName, it.loadLabel(pm).toString(), it) }
            .sortedBy { it.second }
        val arr = JSArray()
        for ((pkg, label, info) in apps) {
            val o = JSObject().put("package", pkg).put("label", label)
            iconOf(info.loadIcon(pm))?.let { o.put("icon", it) }
            arr.put(o)
        }
        invoke.resolve(JSObject().put("apps", arr))
    }

    /** A 48px PNG data URL of an app icon, or null if it can't be drawn. */
    private fun iconOf(d: android.graphics.drawable.Drawable): String? = try {
        val size = 48
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, size, size)
        d.draw(Canvas(bmp))
        val out = java.io.ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    } catch (e: Exception) {
        null
    }

    // ---------- Files ----------

    /**
     * Saves a copy of an app file where the user finds it: Android 10+ puts it
     * straight into Download; older ones (where that needs a storage permission)
     * ask where to save it with the system's save screen, which needs none.
     */
    @Command
    fun saveToDownloads(invoke: Invoke) {
        val args = invoke.parseArgs(SaveArgs::class.java)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(args.mime)
                .putExtra(Intent.EXTRA_TITLE, args.name)
            startActivityForResult(invoke, intent, "onSaveDocument")
            return
        }
        try {
            val src = java.io.File(args.path)
            run {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, args.name)
                    put(MediaStore.Downloads.MIME_TYPE, args.mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = activity.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw Exception("다운로드 폴더에 파일을 만들 수 없습니다")
                resolver.openOutputStream(uri).use { out -> src.inputStream().use { it.copyTo(out!!) } }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            }
            invoke.resolve(JSObject().put("place", "다운로드/" + args.name))
        } catch (e: Exception) {
            invoke.reject(e.message ?: "파일을 저장하지 못했습니다")
        }
    }

    @ActivityCallback
    fun onSaveDocument(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.reject("저장을 취소했습니다")
            return
        }
        val args = invoke.parseArgs(SaveArgs::class.java)
        try {
            activity.contentResolver.openOutputStream(uri).use { out -> java.io.File(args.path).inputStream().use { it.copyTo(out!!) } }
            invoke.resolve(JSObject().put("place", args.name))
        } catch (e: Exception) {
            invoke.reject(e.message ?: "파일을 저장하지 못했습니다")
        }
    }
}
