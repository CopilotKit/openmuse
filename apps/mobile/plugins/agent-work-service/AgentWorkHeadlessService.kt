/*
 * AgentWorkHeadlessService.kt
 *
 * Headless JS task service that runs when the OS restarts the process after
 * killing it. Ported from meaty's QuickNoteHeadlessService.kt.
 *
 * The JS-side recovery handler is registered as
 * `AppRegistry.registerHeadlessTask("AgentWorkRecovery", ...)`.
 * This native service starts that JS task with a 2-minute timeout (extendable
 * via HeadlessJsTaskConfig's `allowedInMemorySize`).
 *
 * Written to `agent-work-service/` and copied into the generated android
 * project by `withAgentWorkService`'s dangerous mod during `expo prebuild`.
 */
package app.openmuse.mobile

import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.jstasks.HeadlessJsTaskConfiguration
import com.facebook.react.jstasks.HeadlessJsTaskService
import com.facebook.react.jstasks.TaskConfig

class AgentWorkHeadlessService : HeadlessJsTaskService() {

  companion object {
    const TASK_KEY = "AgentWorkRecovery"
    const TIMEOUT_MS = 120_000
  }

  override fun getTaskConfig(intent: Intent): TaskConfig {
    return TaskConfig(
      TASK_KEY,
      null, // The task is registered in JS via AppRegistry.registerHeadlessTask
      TIMEOUT_MS,
      false, // Not a one-shot task
      true,  // Allow while in foreground
      true,  // Allow while in background
      true,  // Allow in pinned mode
    )
  }

  override fun onStart(intent: Intent?, startId: Int) {
    // HeadlessJsTaskService handles starting the JS task; we just configure it.
    super.onStart(intent, startId)
  }
}
