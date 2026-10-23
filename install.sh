#!/usr/bin/env bash
# Installs or updates Mitzi on macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/elad-haviv/Mitzi-harness/feature/web-ui/install.sh | bash
set -euo pipefail

REPO="https://github.com/elad-haviv/Mitzi-harness.git"
BRANCH="${MITZI_BRANCH:-feature/web-ui}"
DIR="${MITZI_DIR:-$HOME/.mitzi/app}"
BIN="${MITZI_BIN:-$HOME/.local/bin}"

say() { printf '\033[38;5;208m🐱\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is required. Install it from https://git-scm.com and run this again."
command -v node >/dev/null || die "Node.js 20 or newer is required. Install it from https://nodejs.org and run this again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or newer is required (found $(node --version)). Update it from https://nodejs.org."

if [ -d "$DIR/.git" ]; then
  say "Updating Mitzi in $DIR"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  say "Downloading Mitzi to $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR"
say "Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error
say "Building"
npm run --silent build >/dev/null

mkdir -p "$BIN"
chmod +x "$DIR/dist/index.js"
ln -sf "$DIR/dist/index.js" "$BIN/mitzi"
say "Installed: $BIN/mitzi"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    printf '\n  %s is not on your PATH. Add this line to ~/.zshrc or ~/.bashrc:\n\n    export PATH="%s:$PATH"\n\n' "$BIN" "$BIN"
    ;;
esac

printf '\nOpen the app:        mitzi ui\nIn your browser:     mitzi web\nIn the terminal:     mitzi\n\nMitzi updates itself from Settings → Updates.\n\n'
