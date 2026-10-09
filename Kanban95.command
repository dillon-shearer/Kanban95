#!/bin/bash
# Kanban95 launcher for macOS. Double-click in Finder (a Terminal window opens), or run
# `./Kanban95.command /path/to/project`. Any folder (a plain one is made a local git repo); default is this repo.
# Same steps as Kanban95.cmd: Node 24 first on PATH (through fnm when the Node on PATH is older), install, build, start.
if [ -n "$KANBAN95_AGENT" ]; then
  echo "Kanban95 is already running; verify with npm test, not by starting the app."
  exit 1
fi
cd "$(dirname "$0")" || exit 1
REPO="${1:-$PWD}"
fail() { echo; echo "$1"; read -r -p "Press Enter to close." _; exit 1; }
node24() { node -e "process.exit(process.versions.node.split('.')[0] < 24 ? 1 : 0)" 2>/dev/null; }
if ! node24; then
  NODE24="$(fnm exec --using=24 which node 2>/dev/null)"
  [ -n "$NODE24" ] && PATH="$(dirname "$NODE24"):$PATH"
  node24 || fail "Kanban95 needs Node 24 or newer. Install it, for example: fnm install 24"
fi
[ -d node_modules ] || npm install || fail "Kanban95 did not start. The messages above say why."
npm run dev -- "$REPO" || fail "Kanban95 did not start. The messages above say why."
