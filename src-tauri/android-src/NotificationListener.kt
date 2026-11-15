package com.selfmanager.app

import android.app.Notification
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Captures notifications from the apps the user picked (Settings > 알림 가계부)
 * into a small on-disk queue. The Rust side drains it when the app is opened or
 * resumed and does all parsing there, so parsing rules stay testable on desktop.
 */
class NotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName ?: return
        NotificationStore.remember(this, pkg)
        if (!NotificationStore.watched(this).contains(pkg)) return
        val n = sbn.notification ?: return
        // Group summaries duplicate their children.
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val extras = n.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: ""
        if (title.isBlank() && text.isBlank()) return
        NotificationStore.enqueue(this, JSONObject().put("package", pkg).put("title", title).put("text", text).put("posted_at", sbn.postTime))
    }
}

object NotificationStore {
    private const val PREFS = "sm_notif"
    private const val MAX_QUEUE = 500
    private val lock = Any()

    private fun queueFile(ctx: Context) = File(ctx.filesDir, "notif_queue.jsonl")

    fun setWatched(ctx: Context, pkgs: Set<String>) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet("watched", pkgs).apply()
    }

    fun watched(ctx: Context): Set<String> =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet("watched", emptySet()) ?: emptySet()

    /** Package names only (no content) of recent notifiers, for the app picker. */
    fun remember(ctx: Context, pkg: String) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val list = (p.getString("recent", "") ?: "").split(",").filter { it.isNotBlank() && it != pkg }.toMutableList()
        list.add(0, pkg)
        p.edit().putString("recent", list.take(40).joinToString(",")).apply()
    }

    fun recent(ctx: Context): List<String> =
        (ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("recent", "") ?: "").split(",").filter { it.isNotBlank() }

    fun enqueue(ctx: Context, item: JSONObject) = synchronized(lock) {
        val f = queueFile(ctx)
        f.appendText(item.toString() + "\n")
        // Bound the queue if the app is not opened for a long time.
        val lines = f.readLines()
        if (lines.size > MAX_QUEUE) f.writeText(lines.takeLast(MAX_QUEUE).joinToString("\n", postfix = "\n"))
    }

    fun drain(ctx: Context): List<JSONObject> = synchronized(lock) {
        val f = queueFile(ctx)
        if (!f.exists()) return emptyList()
        val out = f.readLines().mapNotNull { runCatching { JSONObject(it) }.getOrNull() }
        f.delete()
        out
    }

    fun toJsonArray(items: List<JSONObject>) = JSONArray(items)
}
