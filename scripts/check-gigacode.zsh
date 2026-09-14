#!/bin/zsh -f
# Standalone diagnostics. Only Zsh and standard macOS/Linux utilities are required.
emulate -LR zsh
unsetopt BG_NICE ALIASES
zmodload zsh/datetime || exit 2
zmodload zsh/zselect || exit 2

typeset TT_CLI=gigacode TT_MODEL_A='' TT_MODEL_B='' TT_ROOT='' TT_RESULTS=''
typeset TT_HELP='' TT_SESSION_A='' TT_SESSION_B=''
integer TT_TIMEOUT=180 TT_ACP_ONLY=0 TT_FAILED=0 TT_SKIPPED=0 TT_INTERRUPTING=0
typeset -A TT_PIDS TT_STARTED TT_LIMITS TT_CODES

tt_usage() {
  cat <<'HELP'
Usage: ./check-gigacode.zsh [options]

  --model-a ID      Model for participant A (omit to use the CLI default)
  --model-b ID      Model for participant B (omit to use the CLI default)
  --gigacode PATH   Executable name or full path (default: gigacode)
  --timeout SEC    Timeout per model call, in seconds (default: 180)
  --acp-only       Collect version/help and run an ACP initialize request only
  -h, --help       Show this help without running GigaCode

Creates a fresh temporary workspace and a results archive. No project setup needed.
Exit 0: all requested processes finished as expected; inspect logs for semantic results.
Exit 1: a probe failed, timed out, or was skipped. Exit 2: setup/arguments failed.
HELP
}

while (( $# )); do
  case "$1" in
    --model-a|--model-b|--gigacode|--timeout)
      if (( $# < 2 )) || [[ -z "$2" ]]; then
        print -u2 -r -- "Missing value for $1"
        exit 2
      fi
      case "$1" in
        --model-a) TT_MODEL_A="$2" ;;
        --model-b) TT_MODEL_B="$2" ;;
        --gigacode) TT_CLI="$2" ;;
        --timeout)
          if [[ "$2" != <-> ]] || (( ${#2} > 5 )) || (( 10#$2 < 1 || 10#$2 > 86400 )); then
            print -u2 -r -- '--timeout must be an integer from 1 to 86400'
            exit 2
          fi
          TT_TIMEOUT=$(( 10#$2 ))
          ;;
      esac
      shift 2
      ;;
    --acp-only) TT_ACP_ONLY=1; shift ;;
    -h|--help) tt_usage; exit 0 ;;
    *) print -u2 -r -- "Unknown option: $1"; tt_usage >&2; exit 2 ;;
  esac
done

if ! TT_CLI=$(whence -p -- "$TT_CLI") || [[ ! -x "$TT_CLI" ]]; then
  print -u2 -r -- 'GigaCode executable not found. Use --gigacode /full/path/to/gigacode.'
  exit 2
fi
typeset -a TT_REQUIRED=(mktemp mkdir tar)
if (( TT_ACP_ONLY )); then
  TT_REQUIRED+=(mkfifo)
else
  TT_REQUIRED+=(uuidgen)
fi
for TT_PROGRAM in "${TT_REQUIRED[@]}"; do
  if ! whence -p -- "$TT_PROGRAM" >/dev/null; then
    print -u2 -r -- "Required command not found: $TT_PROGRAM"
    exit 2
  fi
done

TT_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/teamytime-probe.XXXXXX") || exit 2
TT_ROOT=${TT_ROOT:A}
TT_RESULTS="$TT_ROOT/results"
command mkdir -p "$TT_RESULTS" "$TT_ROOT/workspace" || exit 2
cd "$TT_ROOT/workspace" || exit 2
printf 'zsh=%s\ngigacode=%s\nmodel_a=%s\nmodel_b=%s\ntimeout=%s\nacp_only=%s\n' \
  "$ZSH_VERSION" "$TT_CLI" "$TT_MODEL_A" "$TT_MODEL_B" "$TT_TIMEOUT" "$TT_ACP_ONLY" \
  >"$TT_RESULTS/00-environment.txt"
print -r -- "Results: $TT_RESULTS"

tt_stop() {
  local tt_pid="$1"
  integer tt_deadline=$(( EPOCHSECONDS + 2 ))
  kill -TERM "$tt_pid" 2>/dev/null || return 0
  while kill -0 "$tt_pid" 2>/dev/null && (( EPOCHSECONDS < tt_deadline )); do
    zselect -t 10
  done
  if kill -0 "$tt_pid" 2>/dev/null; then
    kill -KILL "$tt_pid" 2>/dev/null
  fi
  return 0
}

tt_archive() {
  local tt_name
  for tt_name in "${(@k)TT_PIDS}"; do
    tt_stop "${TT_PIDS[$tt_name]}"
    wait "${TT_PIDS[$tt_name]}" 2>/dev/null
  done
  if COPYFILE_DISABLE=1 command tar -czf "$TT_ROOT/teamytime-probe-results.tar.gz" -C "$TT_ROOT" results; then
    print -r -- "Archive: $TT_ROOT/teamytime-probe-results.tar.gz"
  else
    print -u2 -r -- "Could not create archive. Results remain in $TT_RESULTS"
  fi
}

tt_interrupt() {
  (( TT_INTERRUPTING )) && return
  TT_INTERRUPTING=1
  print -r -- 'Interrupted by operator' >"$TT_RESULTS/interrupted.txt"
  print -u2 -r -- 'Stopping probes and saving results...'
  exit "$1"
}
trap 'tt_interrupt 130' INT
trap 'tt_interrupt 143' TERM
trap 'tt_archive' EXIT

tt_start() {
  local tt_name="$1" tt_limit="$2" tt_input="$3"
  shift 3
  printf '%s\n' "$@" >"$TT_RESULTS/$tt_name.argv.txt"
  : >"$TT_RESULTS/$tt_name.stdout.log"
  : >"$TT_RESULTS/$tt_name.stderr.log"
  print -r -- "Running $tt_name"
  command "$@" <"$tt_input" >"$TT_RESULTS/$tt_name.stdout.log" 2>"$TT_RESULTS/$tt_name.stderr.log" &
  TT_PIDS[$tt_name]="$!"
  TT_STARTED[$tt_name]="$EPOCHREALTIME"
  TT_LIMITS[$tt_name]="$tt_limit"
}

tt_finish() {
  local tt_name="$1" tt_pid="${TT_PIDS[$1]}"
  integer tt_code=0 tt_timed_out=0
  while kill -0 "$tt_pid" 2>/dev/null; do
    if (( EPOCHREALTIME - TT_STARTED[$tt_name] >= TT_LIMITS[$tt_name] )); then
      tt_timed_out=1
      print -r -- 'Process exceeded the probe timeout' >"$TT_RESULTS/$tt_name.timeout.txt"
      tt_stop "$tt_pid"
      break
    fi
    zselect -t 10
  done
  wait "$tt_pid" 2>/dev/null
  tt_code=$?
  unset "TT_PIDS[$tt_name]"
  TT_CODES[$tt_name]=$tt_code
  printf '%s\n' "$tt_code" >"$TT_RESULTS/$tt_name.exit.txt"
  if (( tt_code != 0 || tt_timed_out )); then
    (( TT_FAILED += 1 ))
  fi
  print -r -- "$tt_name: exit=$tt_code, timeout=$tt_timed_out"
}

tt_run() {
  local tt_name="$1" tt_limit="$2"
  shift 2
  tt_start "$tt_name" "$tt_limit" /dev/null "$@"
  tt_finish "$tt_name"
}

tt_skip() {
  print -r -- "$2" >"$TT_RESULTS/$1.skipped.txt"
  print -r -- "$1: skipped ($2)"
  (( TT_SKIPPED += 1 ))
}

tt_has() {
  [[ "$TT_HELP" == *"$1"* ]]
}

tt_agent_start() {
  local tt_name="$1" tt_model="$2"
  shift 2
  local -a tt_args=(--chat-recording --approval-mode plan --output-format stream-json)
  [[ -n "$tt_model" ]] && tt_args+=(--model "$tt_model")
  tt_has --max-session-turns && tt_args+=(--max-session-turns 8)
  tt_start "$tt_name" "$TT_TIMEOUT" /dev/null "$TT_CLI" "${tt_args[@]}" "$@"
}

tt_acp() {
  if ! tt_has --acp; then
    tt_skip 08-acp 'Current help does not advertise --acp'
    return
  fi
  local tt_request='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"teamytime-probe","version":"0.1.0"}}}'
  local tt_response='' tt_content='' tt_pid
  local tt_id_pattern='"id"[[:space:]]*:[[:space:]]*1[[:space:]]*[,}]'
  integer tt_fd tt_code=0 tt_limit=$(( TT_TIMEOUT < 30 ? TT_TIMEOUT : 30 ))
  command mkfifo "$TT_ROOT/acp.stdin" || return 2
  exec {tt_fd}<>"$TT_ROOT/acp.stdin" || return 2
  print -r -- "$tt_request" >"$TT_RESULTS/08-acp.stdin.ndjson"
  tt_start 08-acp "$tt_limit" "$TT_ROOT/acp.stdin" "$TT_CLI" --acp
  tt_pid="${TT_PIDS[08-acp]}"
  print -r -- "$tt_request" >&$tt_fd
  while kill -0 "$tt_pid" 2>/dev/null; do
    tt_content=$(<"$TT_RESULTS/08-acp.stdout.log")
    if [[ "$tt_content" =~ "$tt_id_pattern" ]]; then
      tt_response=observed
      break
    fi
    (( EPOCHREALTIME - TT_STARTED[08-acp] >= tt_limit )) && break
    zselect -t 10
  done
  # Also retain a response from an implementation that exits immediately after replying.
  tt_content=$(<"$TT_RESULTS/08-acp.stdout.log")
  [[ "$tt_content" =~ "$tt_id_pattern" ]] && tt_response=observed
  if [[ -n "$tt_response" ]]; then
    print -r -- 'Response ID observed. Inspect raw JSON for result versus error and capabilities.' \
      >"$TT_RESULTS/08-acp.observation.txt"
  else
    print -r -- 'No response with ID 1 observed before process exit or deadline.' \
      >"$TT_RESULTS/08-acp.observation.txt"
    (( TT_FAILED += 1 ))
  fi
  if kill -0 "$tt_pid" 2>/dev/null; then
    print -r -- 'Probe stopped the process after handshake observation/deadline.' \
      >"$TT_RESULTS/08-acp.stopped-by-probe.txt"
    tt_stop "$tt_pid"
  fi
  exec {tt_fd}>&-
  wait "$tt_pid" 2>/dev/null
  tt_code=$?
  unset 'TT_PIDS[08-acp]'
  printf '%s\n' "$tt_code" >"$TT_RESULTS/08-acp.exit.txt"
  print -r -- "08-acp: response=${tt_response:-not-observed}, exit=$tt_code (see raw logs)"
}

tt_run 01-version 30 "$TT_CLI" --version
tt_run 01-help 30 "$TT_CLI" --help
TT_HELP=$(<"$TT_RESULTS/01-help.stdout.log")
TT_HELP+=$'\n'$(<"$TT_RESULTS/01-help.stderr.log")
if [[ "${TT_CODES[01-help]}" != 0 ]]; then
  print -u2 -r -- 'Could not obtain current help; remaining probes skipped.'
  exit 1
fi
if (( TT_ACP_ONLY )); then
  tt_acp || exit 1
  (( TT_FAILED == 0 && TT_SKIPPED == 0 ))
  exit $?
fi

tt_run 01-mcp-help 30 "$TT_CLI" mcp --help
integer TT_CAN_SESSION=1
for TT_FLAG in --chat-recording --approval-mode --output-format --session-id --resume --append-system-prompt; do
  if ! tt_has "$TT_FLAG"; then
    TT_CAN_SESSION=0
    tt_skip "02-capability-${TT_FLAG#--}" "Current help does not advertise $TT_FLAG"
  fi
done

if (( TT_CAN_SESSION )); then
  TT_SESSION_A=$(command uuidgen) || exit 2
  TT_SESSION_B=$(command uuidgen) || exit 2
  TT_SESSION_A=${TT_SESSION_A:l}
  TT_SESSION_B=${TT_SESSION_B:l}
  printf 'SESSION_A=%s\nSESSION_B=%s\n' "$TT_SESSION_A" "$TT_SESSION_B" \
    >"$TT_RESULTS/02-participants.txt"

  tt_agent_start 03-create-a "$TT_MODEL_A" --session-id "$TT_SESSION_A" \
    --append-system-prompt 'Ты координатор. Каждую реплику начинай с ROLE_A:. Не используй инструменты, файлы, внешнюю память или поиск.' \
    'Запомни контрольное слово ORBIT_7319 только в контексте этого разговора. Ответь коротко, что запомнил его.'
  tt_finish 03-create-a
  tt_agent_start 03-create-b "$TT_MODEL_B" --session-id "$TT_SESSION_B" \
    --append-system-prompt 'Ты рецензент. Каждую реплику начинай с ROLE_B:. Не используй инструменты, файлы, внешнюю память или поиск.' \
    'Запомни контрольное слово CEDAR_4826 только в контексте этого разговора. Ответь коротко, что запомнил его.'
  tt_finish 03-create-b

  if [[ "${TT_CODES[03-create-a]}" == 0 && ! -f "$TT_RESULTS/03-create-a.timeout.txt" ]]; then
    tt_agent_start 04-resume-a "$TT_MODEL_A" --resume "$TT_SESSION_A" \
      'Не используй инструменты или файлы. Назови контрольное слово из предыдущего хода этого разговора. Если не помнишь, напиши НЕ ПОМНЮ.'
    tt_finish 04-resume-a
  else
    tt_skip 04-resume-a 'Creation of session A failed'
  fi

  if [[ "${TT_CODES[03-create-a]}" == 0 && "${TT_CODES[03-create-b]}" == 0 \
        && ! -f "$TT_RESULTS/03-create-a.timeout.txt" && ! -f "$TT_RESULTS/03-create-b.timeout.txt" ]]; then
    tt_agent_start 05-parallel-a "$TT_MODEL_A" --resume "$TT_SESSION_A" \
      --append-system-prompt 'Ты координатор. Начни ответ с ROLE_A:. Не используй инструменты или файлы.' \
      'Назови контрольное слово из предыдущих сообщений этого разговора. Если не помнишь, напиши НЕ ПОМНЮ.'
    tt_agent_start 05-parallel-b "$TT_MODEL_B" --resume "$TT_SESSION_B" \
      --append-system-prompt 'Ты рецензент. Начни ответ с ROLE_B:. Не используй инструменты или файлы.' \
      'Назови контрольное слово из предыдущих сообщений этого разговора. Если не помнишь, напиши НЕ ПОМНЮ.'
    tt_finish 05-parallel-a
    tt_finish 05-parallel-b
  else
    tt_skip 05-parallel 'Both session creations must finish without errors or timeouts'
  fi
fi

if tt_has --include-partial-messages && tt_has --chat-recording && tt_has --approval-mode && tt_has --output-format; then
  tt_agent_start 06-partials "$TT_MODEL_A" --include-partial-messages \
    'Не используй инструменты или файлы. Напиши 12 пронумерованных коротких предложений о совместной работе команды. Каждое с новой строки.'
  tt_finish 06-partials
else
  tt_skip 06-partials 'Required output/session parameters are absent from current help'
fi

if tt_has --allowed-tools && tt_has --approval-mode && tt_has --output-format; then
  tt_run 07-tools "$TT_TIMEOUT" "$TT_CLI" --approval-mode=auto-edit \
    --allowed-tools run_shell_command --output-format stream-json \
    -p 'Выполни через run_shell_command: pwd; создай в текущем каталоге файл teamytime-probe.txt с единственной строкой TEAMYTIME_TOOL_OK и прочитай его через cat. Не выполняй другие действия. В финальном ответе укажи прочитанную строку.'
  if [[ -f teamytime-probe.txt ]]; then
    command cat teamytime-probe.txt >"$TT_RESULTS/07-created-file.txt"
  fi
else
  tt_skip 07-tools 'Required tool/approval parameters are absent from current help'
fi

printf 'process_failures=%s\nskipped=%s\n' "$TT_FAILED" "$TT_SKIPPED" >"$TT_RESULTS/09-summary.txt"
print -r -- "Finished: process failures=$TT_FAILED, skipped=$TT_SKIPPED. Semantic results require log review."
(( TT_FAILED == 0 && TT_SKIPPED == 0 ))
exit $?
