import * as vscode from "vscode";
import { readSettings } from "./settings";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

const UPDATER_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour

export function registerAutoUpdater(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  const checkForUpdates = async (manual = false) => {
    const settings = readSettings();
    if (!settings.autoUpdate && !manual) {
      return;
    }

    try {
      const currentVersion = context.extension.packageJSON?.version;
      if (!currentVersion) {
        throw new Error("Could not determine current extension version.");
      }

      const res = await fetch("https://api.github.com/repos/muxammadreza/openclaw-config-vscode/releases/latest", {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "openclaw-config-vscode"
        }
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch latest release: ${res.statusText}`);
      }

      const release = await res.json() as { tag_name: string; assets: { name: string; url: string; browser_download_url: string }[] };
      const latestVersion = release.tag_name.replace(/^v/, "");

      if (latestVersion === currentVersion) {
        if (manual) {
          vscode.window.showInformationMessage(`OpenClaw Config is up to date (v${currentVersion}).`);
        }
        return;
      }

      const vsixAsset = release.assets.find(a => a.name.endsWith(".vsix"));
      if (!vsixAsset) {
        if (manual) {
          vscode.window.showWarningMessage(`New version v${latestVersion} found, but no .vsix asset is attached to the release.`);
        }
        output.appendLine(`[updater] Release v${latestVersion} has no .vsix asset.`);
        return;
      }

      if (!manual) {
        output.appendLine(`[updater] Update downloaded in background. Version: v${latestVersion}`);
      } else {
        vscode.window.showInformationMessage(`Downloading update v${latestVersion} from GitHub...`);
      }

      const downloadRes = await fetch(vsixAsset.browser_download_url);
      if (!downloadRes.ok) {
        throw new Error(`Failed to download VSIX: ${downloadRes.statusText}`);
      }

      const buffer = await downloadRes.arrayBuffer();
      const tempPath = path.join(os.tmpdir(), `openclaw-config-vscode-${latestVersion}-${Date.now()}.vsix`);
      await fs.writeFile(tempPath, Buffer.from(buffer));

      output.appendLine(`[updater] Installing extension from ${tempPath}...`);
      
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(tempPath));
      
      const reload = await vscode.window.showInformationMessage(
        `OpenClaw Config updated to v${latestVersion}. Please reload the window to apply the update.`,
        "Reload Window"
      );
      
      if (reload === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }

      // Cleanup
      await fs.rm(tempPath, { force: true }).catch(() => {});

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`[updater] Failed to check for updates: ${msg}`);
      if (manual) {
        vscode.window.showErrorMessage(`Update check failed: ${msg}`);
      }
    }
  };

  // Run initial check after a delay
  setTimeout(() => checkForUpdates(), 5000);

  // Poll periodically
  const interval = setInterval(() => checkForUpdates(), UPDATER_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });

  // Register manual command
  context.subscriptions.push(
    vscode.commands.registerCommand("openclawConfig.checkForUpdates", () => checkForUpdates(true))
  );
}
