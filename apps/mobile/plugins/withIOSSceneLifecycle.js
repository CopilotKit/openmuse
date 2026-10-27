const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withInfoPlist, withXcodeProject } = require("expo/config-plugins");

const sceneDelegate = `import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let appWindow = (UIApplication.shared.delegate as? AppDelegate)?.window else { return }
    appWindow.windowScene = windowScene
    window = appWindow
    appWindow.makeKeyAndVisible()
  }
}
`;

function withIOSSceneLifecycle(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return mod;
  });

  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const filePath = path.join(
        mod.modRequest.platformProjectRoot,
        mod.modRequest.projectName,
        "SceneDelegate.swift",
      );
      fs.writeFileSync(filePath, sceneDelegate);
      return mod;
    },
  ]);

  return withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const target = project.getFirstTarget();
    if (!project.hasFile("OpenMuse/SceneDelegate.swift"))
      project.addSourceFile("OpenMuse/SceneDelegate.swift", { target: target.uuid }, "OpenMuse");
    return mod;
  });
}

module.exports = withIOSSceneLifecycle;
