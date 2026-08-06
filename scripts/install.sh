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
PKG="${OCC_INSTALL_PACKAGE:-@sweetcornna/open-claude-code}"
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

# Browser tools (`--chrome`) run through browser-use, a Python tool launched with
# uvx. It is not an npm dependency, so it has to be provisioned separately.
# Skipped entirely with OCC_INSTALL_SKIP_BROWSER=1, and never fatal: occ works
# fine without browser tools, and failing the whole install over an optional
# feature would be the wrong trade.
provision_browser_tools() {
  if [ "${OCC_INSTALL_SKIP_BROWSER:-0}" = "1" ]; then
    return 0
  fi

  if ! command -v uvx >/dev/null 2>&1; then
    info "installing uv (needed by browser tools)…"
    # Download and run as two steps rather than `curl … | sh`. In a pipeline the
    # exit status is the *last* command's, so a failed download still reports
    # success once an empty script runs cleanly — and the user gets "re-open
    # your shell" instead of the real problem. `set -o pipefail` at the top of
    # this file happens to cover it, but correctness here should not depend on
    # a setting twenty lines away that someone could reasonably move.
    local uv_installer
    uv_installer=$(mktemp)
    if ! curl -LsSf https://astral.sh/uv/install.sh -o "${uv_installer}" ||
      ! sh "${uv_installer}" >/dev/null 2>&1; then
      rm -f "${uv_installer}"
      info "could not install uv — browser tools (\`--chrome\`) will be unavailable."
      info "install it yourself later: https://docs.astral.sh/uv/getting-started/installation/"
      return 0
    fi
    rm -f "${uv_installer}"
    # uv installs to ~/.local/bin, which is usually not on PATH in this shell yet.
    export PATH="${HOME}/.local/bin:${PATH}"
  fi

  if ! command -v uvx >/dev/null 2>&1; then
    info "uv installed but \`uvx\` is not on PATH — re-open your shell, then run \`${BIN} chrome\`."
    return 0
  fi

  # Fetch the package now so the first browser action is not a multi-minute
  # download in the middle of a task.
  info "fetching browser-use…"
  if uvx --from 'browser-use[cli]' python -c 'import browser_use.mcp.server' >/dev/null 2>&1; then
    info "browser tools ready. Chrome or Chromium must also be installed."
  else
    info "could not fetch browser-use — \`${BIN} chrome\` will retry later."
  fi
}

if command -v "${BIN}" >/dev/null 2>&1; then
  info "installed: $(${BIN} --version)"
  provision_browser_tools
  info "run \`${BIN}\` in a project directory to get started — the first run walks you through migration, login, and model setup."
else
  # Installed but the bin dir isn't on PATH — tell the user where it went.
  if command -v bun >/dev/null 2>&1 && bun pm ls -g 2>/dev/null | grep -q "${PKG}"; then
    fail "installed, but \`${BIN}\` is not on your PATH. Add \"\$(bun pm bin -g)\" to PATH and re-open your shell."
  fi
  NPM_BIN=$(npm bin -g 2>/dev/null || npm prefix -g 2>/dev/null || true)
  fail "installed, but \`${BIN}\` is not on your PATH. Check your npm global bin dir (${NPM_BIN:-npm prefix -g}) is on PATH and re-open your shell."
fi
