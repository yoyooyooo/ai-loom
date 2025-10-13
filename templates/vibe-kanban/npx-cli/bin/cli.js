#!/usr/bin/env node

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Detect current platform -> dist subdir
function getPlatformDir() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "win32" && arch === "x64") return "windows-x64";

  console.error(`❌ Unsupported platform: ${platform}-${arch}`);
  console.error("Supported platforms: linux-x64, macos-arm64, macos-x64, windows-x64");
  process.exit(1);
}

function main() {
  const platformDir = getPlatformDir();
  const extractDir = path.join(__dirname, "..", "dist", platformDir);
  const binName = process.platform === "win32" ? "vibe-starter.exe" : "vibe-starter";
  const zipPath = path.join(extractDir, "vibe-starter.zip");
  // Use OS temp dir to ensure we can write SQLite DB
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-starter-"));
  const binPath = path.join(runDir, binName);

  console.log("🚀 Starting vibe-starter...");

  if (!fs.existsSync(zipPath)) {
    console.error(`❌ Binary not found for ${platformDir}`);
    console.error(`Expected: ${zipPath}`);
    console.error("Please ensure the package was built correctly for your platform.");
    process.exit(1);
  }

  console.log(`📦 Extracting vibe-starter for ${platformDir}...`);

  // Extract archive contents
  const unzipCmd = process.platform === "win32"
    ? `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${runDir}' -Force"`
    : `unzip -qq -o "${zipPath}" -d "${runDir}"`;

  try {
    execSync(unzipCmd, { stdio: "inherit" });
  } catch (error) {
    console.error("❌ Failed to extract binary:", error.message);
    process.exit(1);
  }

  // Ensure executable permission on Unix
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(binPath, 0o755);
    } catch (error) {
      console.error("❌ Failed to set executable permissions:", error.message);
      process.exit(1);
    }
  }

  // IMPORTANT: Run binary in runDir so relative paths (frontend/dist) & DB path work
  try {
    process.chdir(runDir);
  } catch (error) {
    console.error("❌ Failed to change working directory:", error.message);
    process.exit(1);
  }

  console.log("🎉 Launching vibe-starter...");
  console.log("✨ The application will open in your browser automatically.");

  try {
    const dbPath = path.join(runDir, "vibe-starter.db");
    // Ensure DB file exists and is writable
    try {
      if (!fs.existsSync(dbPath)) {
        fs.writeFileSync(dbPath, "");
      }
    } catch (e) {
      console.warn("⚠️  Failed to pre-create DB file:", e.message);
    }
    execSync(`"${binPath}"`, { stdio: "inherit", env: { ...process.env, DATABASE_URL: `sqlite://${dbPath}` } });
  } catch (error) {
    console.error("❌ Failed to start application:", error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n👋 Goodbye!');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Goodbye!');
  process.exit(0);
});

main();
