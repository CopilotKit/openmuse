/*
 * AgentWorkService.kt
 *
 * Foreground service that keeps the OpenMuse device-work process alive while
 * the agent loop claims and heartbeats tasks. Ported from meaty's
 * MeshResidencyService / DiarizationService — this service uses
 * FOREGROUND_SERVICE_TYPE_DATA_SYNC (not SPECIAL_USE), because OpenMuse's
 * problem is heartbeat connectivity, not ML compute.
 *
 * Written to `agent-work-service/` and copied into the generated android
 * project by `withAgentWorkService`'s dangerous mod during `expo prebuild`.
 */
package app.openmuse.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.NotificationCompat

class AgentWorkService : Service() {

  companion object {
    const NOTIFICATION_ID = 1001
    const CHANNEL_ID = "agent_work_channel"
    const EXTRA_TASK_ID = "taskId"
    const EXTRA_LEASE_ID = "leaseId"
    const EXTRA_LEASE_UNTIL = "leaseUntil"
    const EXTRA_TITLE = "title"
    const PREFS_NAME = "openmuse_agent_work"
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    saveState(intent)

    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Agent"
    val notification = buildNotification(title)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    // If the OS kills the service, do NOT blindly restart — the JS engine is
    // gone and there is nothing to keep alive. START_NOT_STICKY lets the
    // headless recovery task decide whether to resume. (Matches meaty.)
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    // Only clear active state — leave tombstones (taskId etc.) for the
    // headless recovery task to read. This mirrors the document: "clear
    // active state" here means clear the "service_started_at" marker,
    // not the task/lease fields.
    clearServiceMarker()
  }

  private fun saveState(intent: Intent?) {
    val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
    prefs.edit()
      .putString("active_task_id", intent?.getStringExtra(EXTRA_TASK_ID))
      .putString("active_lease_id", intent?.getStringExtra(EXTRA_LEASE_ID))
      .putString("active_lease_until", intent?.getStringExtra(EXTRA_LEASE_UNTIL))
      .putString("active_task_title", intent?.getStringExtra(EXTRA_TITLE))
      .putLong("service_started_at", SystemClock.elapsedRealtime())
      .apply()
  }

  private fun clearServiceMarker() {
    val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
    prefs.edit()
      .remove("service_started_at")
      .apply()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Agent work",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Keeps your agent working while the app is backgrounded."
        setShowBadge(false)
      }
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(channel)
    }
  }

  private fun buildNotification(title: String): Notification {
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Agent working")
      .setContentText(title)
      .setSmallIcon(R.drawable.ic_agent_work)
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
  }
}
