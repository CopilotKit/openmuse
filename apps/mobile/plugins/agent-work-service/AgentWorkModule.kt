/*
 * AgentWorkModule.kt
 *
 * Native module that bridges JS calls to the foreground service and
 * SharedPreferences. Registered as "AgentWorkService" so
 * `NativeModules.AgentWorkService` resolves in the JS layer.
 *
 * Written to `agent-work-service/` and copied into the generated android
 * project by `withAgentWorkService`'s dangerous mod during `expo prebuild`.
 */
package app.openmuse.mobile

import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

class AgentWorkModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  private val appContext: Context = context.applicationContext

  override fun getName(): String = "AgentWorkService"

  private fun prefs(): android.content.SharedPreferences =
    appContext.getSharedPreferences(AgentWorkService.PREFS_NAME, Context.MODE_PRIVATE)

  @ReactMethod
  fun startAgentService(taskId: String, leaseId: String, leaseUntil: String, title: String) {
    val intent = Intent(appContext, AgentWorkService::class.java).apply {
      putExtra(AgentWorkService.EXTRA_TASK_ID, taskId)
      putExtra(AgentWorkService.EXTRA_LEASE_ID, leaseId)
      putExtra(AgentWorkService.EXTRA_LEASE_UNTIL, leaseUntil)
      putExtra(AgentWorkService.EXTRA_TITLE, title)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      appContext.startForegroundService(intent)
    } else {
      appContext.startService(intent)
    }
  }

  @ReactMethod
  fun stopAgentService() {
    val intent = Intent(appContext, AgentWorkService::class.java)
    appContext.stopService(intent)
  }

  @ReactMethod
  fun updateLeaseUntil(leaseUntil: String) {
    prefs().edit()
      .putString("active_lease_until", leaseUntil)
      .apply()
  }

  @ReactMethod
  fun getSavedAgentState(promise: Promise<WritableMap>) {
    val prefs = prefs()
    val taskId = prefs.getString("active_task_id", null)
    val leaseId = prefs.getString("active_lease_id", null)
    val leaseUntil = prefs.getString("active_lease_until", null)
    val title = prefs.getString("active_task_title", null)

    if (taskId == null || leaseId == null || leaseUntil == null || title == null) {
      promise.resolve(null)
      return
    }

    val map: WritableMap = Arguments.createMap().apply {
      putString("taskId", taskId)
      putString("leaseId", leaseId)
      putString("leaseUntil", leaseUntil)
      putString("title", title)
    }
    promise.resolve(map)
  }

  @ReactMethod
  fun clearSavedAgentState() {
    prefs().edit()
      .remove("active_task_id")
      .remove("active_lease_id")
      .remove("active_lease_until")
      .remove("active_task_title")
      .remove("service_started_at")
      .apply()
  }
}
