#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=agent-shim.sh
source "${SCRIPT_DIR}/agent-shim.sh"

PROJECT_DIR="$(pwd)"
STATE="${PROJECT_DIR}/.canon/state.json"
TUI_WRITE="${DEGA_CORE_HOME}/scripts/terminal-ui-write.sh"

# ── Init state file ──────────────────────────────────────────────────
mkdir -p .canon
if [[ -f "${TUI_WRITE}" ]]; then
  bash "${TUI_WRITE}" "${STATE}" \
    phase=init status=idle log.info="Waiting for /canon-start..."
else
  printf '{"phase":"init","status":"idle","startedAt":"%s","updatedAt":"%s","logs":[],"error":null,"metrics":{}}\n' \
    "$(date -u +%FT%TZ)" "$(date -u +%FT%TZ)" >"${STATE}"
fi

# ── Launch mode: Canon TUI (preferred) or tmux (fallback) ────────────
if command -v canon >/dev/null 2>&1; then
  # Canon TUI mode — single process, no tmux needed.
  # Canon handles conversation + Builder/Automation views natively.
  # TODO: add --prompt "/canon-start" once canon supports prefill
  echo "Launching Canon TUI. Type /canon-start to begin."
  exec canon run "${PROJECT_DIR}"
fi

# ── Fallback: tmux with agent + dashboard ────────────────────────────
if ! command -v tmux >/dev/null 2>&1; then
  echo "error: neither canon nor tmux found. Install one of:"
  echo "  canon — see DEGAorg/canon-tui README"
  echo "  tmux  — brew install tmux"
  exit 1
fi

# Dashboard renderer (best available without Canon TUI)
_canon_dashboard_cmd() {
  if command -v terminal-ui >/dev/null 2>&1; then
    echo "terminal-ui --state ${STATE}"
    return
  fi
  if [[ -f "${DEGA_CORE_HOME}/scripts/terminal-ui/dist/cli.js" ]]; then
    echo "node ${DEGA_CORE_HOME}/scripts/terminal-ui/dist/cli.js --state ${STATE}"
    return
  fi
  echo "bash -c 'while true; do clear; cat \"${STATE}\" 2>/dev/null; sleep 1; done'"
}
RIGHT_CMD="$(_canon_dashboard_cmd)"

# Create tmux: left=agent, right=dashboard
HEADLESS_FLAGS="$(dega_agent_headless_flags)"
AGENT_CMD="$(dega_agent_command) ${HEADLESS_FLAGS}; "
AGENT_CMD+="[[ -f '${TUI_WRITE}' ]] && bash '${TUI_WRITE}' '${STATE}' status=idle log.info='Agent session ended'; "
AGENT_CMD+="echo 'Agent exited. Run ./canon.sh to restart, or Ctrl-D to close.'; "
AGENT_CMD+="exec bash"
tmux new-session -d -s canon "${AGENT_CMD}"
tmux split-window -h -t canon -p 40 "${RIGHT_CMD}"
tmux select-pane -t canon:.0

# Pre-type /canon-start (user hits Enter to confirm)
tmux send-keys -t canon:.0 "/canon-start" ""

# Status bar
tmux set-option -t canon status-left " Canon "
tmux set-option -t canon status-right " %H:%M "

exec tmux attach-session -t canon
