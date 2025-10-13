#!/bin/bash
set -e

PROJECT_NAME="vibe-starter"

echo "🧹 Cleaning previous builds..."
rm -rf npx-cli/dist
mkdir -p npx-cli/dist/macos-arm64
mkdir -p npx-cli/dist/macos-x64
mkdir -p npx-cli/dist/linux-x64
mkdir -p npx-cli/dist/windows-x64

echo "🔨 Building frontend..."
cd frontend && npm run build && cd ..

echo "🔨 Building Rust backend..."
cargo build --release

echo "📦 Creating distribution packages..."

# Create bundle payload (binary + frontend assets)
WORKDIR="$(pwd)"
BUNDLE_DIR="$WORKDIR/.bundle"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/frontend"

# copy frontend/dist into bundle so server can serve static files
cp -R frontend/dist "$BUNDLE_DIR/frontend/dist"

# macOS ARM64 (M1/M2)
if [[ "$(uname)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
    cp target/release/server "$BUNDLE_DIR/$PROJECT_NAME"
    (cd "$BUNDLE_DIR" && zip -q -r "$PROJECT_NAME.zip" .)
    mv "$BUNDLE_DIR/$PROJECT_NAME.zip" npx-cli/dist/macos-arm64/
fi

# macOS x64
if [[ "$(uname)" == "Darwin" && "$(uname -m)" == "x86_64" ]]; then
    cp target/release/server "$BUNDLE_DIR/$PROJECT_NAME"
    (cd "$BUNDLE_DIR" && zip -q -r "$PROJECT_NAME.zip" .)
    mv "$BUNDLE_DIR/$PROJECT_NAME.zip" npx-cli/dist/macos-x64/
fi

# Linux x64
if [[ "$(uname)" == "Linux" ]]; then
    cp target/release/server "$BUNDLE_DIR/$PROJECT_NAME"
    (cd "$BUNDLE_DIR" && zip -q -r "$PROJECT_NAME.zip" .)
    mv "$BUNDLE_DIR/$PROJECT_NAME.zip" npx-cli/dist/linux-x64/
fi

echo "✅ Build complete!"
echo "📍 Distribution files created in npx-cli/dist/"

# cleanup bundle workspace
rm -rf "$BUNDLE_DIR"
