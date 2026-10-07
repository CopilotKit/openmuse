/*
 * AgentWorkPackage.kt
 *
 * Registers the AgentWorkModule with React Native's native module registry.
 * This must be added to MainApplication's `getPackages()` list.
 *
 * Written to `agent-work-service/` and copied into the generated android
 * project by `withAgentWorkService`'s dangerous mod during `expo prebuild`.
 */
package app.openmuse.mobile

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AgentWorkPackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(AgentWorkModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
