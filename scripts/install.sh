#!/usr/bin/env bash
# open-claude-code one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/sweetcornna/open-claude-code/main/scripts/install.sh | bash
#
# Installs the npm package globally with bun (preferred) or npm, then verifies
# that `occ --version` actually runs. No sudo: if the global prefix is not
# writable this fails with a hint instead of escalating.

set -euo pipefail

# Single source for the package name — keep in sync with package.json "name"
# and src/constants/brand.ts NPM_PACKAGE_NAME.
PKG="${OCC_INSTALL_PACKAGE:-open-claude-code}"
BIN="occ"

info() { printf '\033[36m[occ-install]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31m[occ-install]\033[0m %s\n' "$*" >&2
  exit 1
}

install_with_bun() {
  info "installing ${PKG} with bun…"
  bun install -g "${PKG}@latest"
}

install_with_npm() {
  local node_major
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "${node_major}" -lt 20 ]; then
    fail "Node.js >= 20 is required (found $(node --version 2>/dev/null || echo 'none')). Install Node 20+ or bun (https://bun.sh) and re-run."
  fi
  info "installing ${PKG} with npm…"
  npm install -g "${PKG}@latest"
}

if command -v bun >/dev/null 2>&1; then
  install_with_bun
elif command -v npm >/dev/null 2>&1; then
  install_with_npm
else
  fail "neither bun nor npm found. Install bun (curl -fsSL https://bun.sh/install | bash) or Node.js 20+ first, then re-run."
fi

if command -v "${BIN}" >/dev/null 2>&1; then
  info "installed: $(${BIN} --version)"
  info "run \`${BIN}\` in a project directory to get started — the first run walks you through migration, login, and model setup."
else
  # Installed but the bin dir isn't on PATH — tell the user where it went.
  if command -v bun >/dev/null 2>&1 && bun pm ls -g 2>/dev/null | grep -q "${PKG}"; then
    fail "installed, but \`${BIN}\` is not on your PATH. Add \"\$(bun pm bin -g)\" to PATH and re-open your shell."
  fi
  NPM_BIN=$(npm bin -g 2>/dev/null || npm prefix -g 2>/dev/null || true)
  fail "installed, but \`${BIN}\` is not on your PATH. Check your npm global bin dir (${NPM_BIN:-npm prefix -g}) is on PATH and re-open your shell."
fi
