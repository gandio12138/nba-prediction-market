#!/usr/bin/env bash
# Agent-agnostic shim — sourced by orchestrator scripts to abstract
# provider-specific commands, flags, env vars, and config paths.
#
# Detection heuristic (first match wins):
#   1. DEGA_PROVIDER env var (explicit override)
#   2. Parent process name (claude, gemini, codex)
#   3. Session env vars (CLAUDECODE, GEMINI_CLI, etc.)
#   4. Fallback: claude
#
# Usage: source "${SCRIPT_DIR}/agent-shim.sh"

# Guard against double-sourcing
if [[ -n "${_DEGA_AGENT_SHIM_LOADED:-}" ]]; then
  return 0
fi
_DEGA_AGENT_SHIM_LOADED=1

# --- Core home ---

DEGA_CORE_HOME="${DEGA_CORE_HOME:-${HOME}/.degacore}"
export DEGA_CORE_HOME

# --- Provider detection ---

_dega_detect_provider() {
  # 1. Explicit env var
  if [[ -n "${DEGA_PROVIDER:-}" ]]; then
    echo "${DEGA_PROVIDER}"
    return
  fi

  # 2. Parent process name
  local ppid_name
  ppid_name="$(ps -o comm= -p "${PPID}" 2>/dev/null || true)"
  case "${ppid_name##*/}" in
  claude*)
    echo "claude"
    return
    ;;
  gemini*)
    echo "gemini"
    return
    ;;
  codex*)
    echo "codex"
    return
    ;;
  esac

  # 3. Session env vars
  if [[ -n "${CLAUDECODE:-}" ]]; then
    echo "claude"
    return
  fi
  if [[ -n "${GEMINI_CLI:-}" ]]; then
    echo "gemini"
    return
  fi

  # 4. Fallback
  echo "claude"
}

# Cache the detected provider for the lifetime of this shell
_DEGA_PROVIDER_CACHE=""

# --- Public API ---

# Returns the detected agent provider name (claude, gemini, codex).
dega_agent_type() {
  if [[ -z "${_DEGA_PROVIDER_CACHE}" ]]; then
    _DEGA_PROVIDER_CACHE="$(_dega_detect_provider)"
  fi
  echo "${_DEGA_PROVIDER_CACHE}"
}

# Returns the CLI command to invoke the agent.
dega_agent_command() {
  local provider
  provider="$(dega_agent_type)"
  case "${provider}" in
  claude) echo "claude" ;;
  gemini) echo "gemini" ;;
  codex) echo "codex" ;;
  *) echo "${provider}" ;;
  esac
}

# Returns the agent-specific config directory path.
dega_agent_config_dir() {
  local provider
  provider="$(dega_agent_type)"
  case "${provider}" in
  claude) echo "${HOME}/.claude" ;;
  gemini) echo "${HOME}/.gemini" ;;
  codex) echo "${HOME}/.codex" ;;
  *) echo "${HOME}/.${provider}" ;;
  esac
}

# Returns flags for headless (non-interactive) invocation.
dega_agent_headless_flags() {
  local provider
  provider="$(dega_agent_type)"
  case "${provider}" in
  claude) echo "--dangerously-skip-permissions --verbose --output-format stream-json" ;;
  gemini) echo "--yolo" ;;
  codex) echo "--yolo" ;;
  *) echo "--headless" ;;
  esac
}

# Returns the session env var name that the agent sets when running.
# Returns empty string for agents that don't set a session var (e.g., Codex).
dega_agent_session_var() {
  local provider
  provider="$(dega_agent_type)"
  case "${provider}" in
  claude) echo "CLAUDECODE" ;;
  gemini) echo "GEMINI_CLI" ;;
  codex) echo "" ;;
  *) echo "" ;;
  esac
}

# Returns the flag used to pass a prompt string to the agent CLI.
# For Codex, returns "exec" — the prompt is a positional arg to the exec subcommand.
dega_agent_prompt_flag() {
  local provider
  provider="$(dega_agent_type)"
  case "${provider}" in
  claude) echo "-p" ;;
  gemini) echo "-p" ;;
  codex) echo "exec" ;;
  *) echo "-p" ;;
  esac
}

# Returns the flag for JSON-formatted output.
dega_agent_json_flag() {
  local provider
  provider="$(dega_agent_type)"
  case "${provider}" in
  claude) echo "--output-format json" ;;
  gemini) echo "--output-format json" ;;
  codex) echo "--json" ;;
  *) echo "--output-format json" ;;
  esac
}

# Assembles a full headless command string for the detected agent.
# Handles Codex's `exec` subcommand pattern vs Claude/Gemini's flag-based pattern.
#
# Usage: cmd="$(dega_agent_build_headless_cmd "your prompt here")"
#        eval "${cmd}"
#
# Claude/Gemini: claude --dangerously-skip-permissions -p "prompt"
# Codex:         codex --yolo exec "prompt"
dega_agent_build_headless_cmd() {
  local prompt="${1:?dega_agent_build_headless_cmd: prompt argument required}"
  local cmd headless_flags prompt_flag

  cmd="$(dega_agent_command)"
  headless_flags="$(dega_agent_headless_flags)"
  prompt_flag="$(dega_agent_prompt_flag)"

  if [[ "${prompt_flag}" == "exec" ]]; then
    # Codex: command + headless flags + exec subcommand + prompt as positional arg
    printf '%s %s exec %q' "${cmd}" "${headless_flags}" "${prompt}"
  else
    # Claude/Gemini: command + headless flags + prompt flag + prompt
    printf '%s %s %s %q' "${cmd}" "${headless_flags}" "${prompt_flag}" "${prompt}"
  fi
}
