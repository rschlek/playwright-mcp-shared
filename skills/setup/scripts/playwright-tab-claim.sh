#!/usr/bin/env bash
# Linux sibling of playwright-tab-claim.ps1: identical actions, identical
# registry schema (locks/tab-claims.json), identical output and exit codes
# (0 ok, 76 claim-not-found-or-expired, 70 error).
#
# Records which agent session is using which shared-browser tab, so the
# dashboard can show it. A claim is a cooperative label, not a lock: it never
# blocks another client. Entries expire after their TTL, so a session that
# ends without releasing drops off on its own.
#
# Locking: flock on a sidecar lock file serializes writers (the PowerShell
# sibling holds the registry itself with an exclusive handle). The registry is
# replaced by an atomic rename, so the dashboard never reads a half-written
# file. URLs keep only scheme, host, and path; queries and fragments can carry
# tokens and are never recorded. Never put an identity value or credential in
# -Owner or -Task.
set -uo pipefail
export LC_ALL=C

ACTION=""
RUNTIME_ROOT=""
OWNER=""
TASK=""
URL=""
CLAIM_ID=""
TTL_SECONDS=3600
MAX_CLAIMS=200

action_lower() {
    printf '%s' "$ACTION" | tr '[:upper:]' '[:lower:]'
}

# Escape a value the way Windows PowerShell's ConvertTo-Json does, so both
# helpers write the same bytes: backslash, quote, and the HTML-sensitive
# characters < > & ' as \u escapes. Callers never pass control characters.
json_escape() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//</\\u003c}"
    value="${value//>/\\u003e}"
    value="${value//&/\\u0026}"
    value="${value//\'/\\u0027}"
    printf '%s' "$value"
}

fail() {
    printf '{"success":false,"message":"%s","reason":"error","action":"%s"}\n' \
        "$(json_escape "$1")" "$(action_lower)"
    exit 70
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -Action|--action) ACTION="${2:-}"; shift 2 ;;
        -RuntimeRoot|--runtime-root) RUNTIME_ROOT="${2:-}"; shift 2 ;;
        -Owner|--owner) OWNER="${2:-}"; shift 2 ;;
        -Task|--task) TASK="${2:-}"; shift 2 ;;
        -Url|--url) URL="${2:-}"; shift 2 ;;
        -ClaimId|--claim-id) CLAIM_ID="${2:-}"; shift 2 ;;
        -TtlSeconds|--ttl-seconds) TTL_SECONDS="${2:-3600}"; shift 2 ;;
        *) fail "Unknown argument '$1'." ;;
    esac
done

case "$ACTION" in
    Claim|Renew|Release|List|Status) ;;
    *) fail "Action must be one of Claim, Renew, Release, List, Status." ;;
esac

case "$TTL_SECONDS" in
    ''|*[!0-9]*) fail "TtlSeconds must be an integer between 60 and 86400." ;;
esac
if [ "$TTL_SECONDS" -lt 60 ] || [ "$TTL_SECONDS" -gt 86400 ]; then
    fail "TtlSeconds must be an integer between 60 and 86400."
fi

if [ -z "$RUNTIME_ROOT" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || fail "Cannot resolve the script directory."
    INSTALLED_ROOT="$(dirname "$SCRIPT_DIR")"
    if [ -n "${PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT:-}" ]; then
        RUNTIME_ROOT="$PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT"
    elif [ "$(basename "$SCRIPT_DIR")" = "bin" ] && [ -f "$INSTALLED_ROOT/state/linux-service-config.json" ]; then
        # An installed copy uses the runtime it lives in.
        RUNTIME_ROOT="$INSTALLED_ROOT"
    elif [ -n "${XDG_DATA_HOME:-}" ]; then
        RUNTIME_ROOT="$XDG_DATA_HOME/playwright-mcp-shared"
    elif [ -n "${HOME:-}" ]; then
        RUNTIME_ROOT="$HOME/.local/share/playwright-mcp-shared"
    else
        fail "HOME is unavailable and PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT is not set."
    fi
fi
case "$RUNTIME_ROOT" in /*) ;; *) RUNTIME_ROOT="$PWD/$RUNTIME_ROOT" ;; esac

# Percent-encode every byte outside the characters a URL path keeps as-is,
# the way .NET's Uri.AbsolutePath does (spaces, quotes, angle brackets,
# braces, non-ASCII bytes, and so on). Existing %XX escapes are kept.
UNSAFE_PATH_RE="[^A-Za-z0-9._~!\$&'()*+,;=:@/%-]"
encode_path() {
    local value="$1" out="" byte char
    if [[ ! "$value" =~ $UNSAFE_PATH_RE ]]; then
        printf '%s' "$value"
        return
    fi
    for byte in $(printf '%s' "$value" | od -An -tx1 -v); do
        case "$byte" in
            # ! $ % & ' ( ) * + , - . / 0-9 : ; = @ A-Z _ a-z ~ stay as they are.
            21|2[4-9a-f]|3[0-9abd]|4[0-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]|7e)
                printf -v char '%b' "\\x$byte"
                out="$out$char"
                ;;
            *) out="$out%${byte^^}" ;;
        esac
    done
    printf '%s' "$out"
}

# RFC 3986 dot-segment removal, as .NET applies to http and https paths.
remove_dot_segments() {
    local input="$1" output="" segment
    local -a parts kept=()
    IFS='/' read -r -a parts <<<"${input#/}"
    local last_index=$(( ${#parts[@]} - 1 ))
    local index=0 trailing=0
    for segment in "${parts[@]}"; do
        case "$segment" in
            .) [ "$index" -eq "$last_index" ] && trailing=1 ;;
            ..)
                [ "${#kept[@]}" -gt 0 ] && unset 'kept[${#kept[@]}-1]'
                [ "$index" -eq "$last_index" ] && trailing=1
                ;;
            *) kept+=("$segment") ;;
        esac
        index=$(( index + 1 ))
    done
    for segment in "${kept[@]}"; do
        output="$output/$segment"
    done
    if [ "$trailing" -eq 1 ] || [ -z "$output" ]; then
        output="$output/"
    fi
    case "$input" in */) [ "${output: -1}" = "/" ] || output="$output/" ;; esac
    printf '%s' "$output"
}

# Keep scheme, host, and path. Query strings and fragments can carry tokens
# and are never recorded. Mirrors ConvertTo-RedactedUrl in the PowerShell
# sibling: http(s) keeps scheme://authority/path (no user information, no
# default port); any other scheme keeps scheme:path.
DRIVE_PATH_RE='^[A-Za-z]:[\/]'
SCHEME_RE='^([A-Za-z][A-Za-z0-9+.-]+):(.*)$'
IPV6_AUTHORITY_RE='^(\[[0-9A-Fa-f:.]+\])(:([0-9]*))?$'
HOST_AUTHORITY_RE='^([^]:[]+)(:([0-9]*))?$'
FILE_DRIVE_RE='^/[A-Za-z]:(/|$)'
redact_url() {
    local value="$1" scheme rest authority path host port
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    # A bare drive path is a file URL to .NET.
    if [[ "$value" =~ $DRIVE_PATH_RE ]]; then
        path="${value//\\//}"
        printf 'file:%s' "$(encode_path "${path%%[?#]*}")"
        return 0
    fi
    [[ "$value" =~ $SCHEME_RE ]] || return 1
    scheme="${BASH_REMATCH[1],,}"
    rest="${BASH_REMATCH[2]}"
    if [ "$scheme" = "http" ] || [ "$scheme" = "https" ]; then
        rest="${rest//\\//}"
        case "$rest" in //*) rest="${rest#//}" ;; *) return 1 ;; esac
        authority="${rest%%[/?#]*}"
        rest="${rest:${#authority}}"
        path="${rest%%[?#]*}"
        authority="${authority##*@}"
        if [[ "$authority" =~ $IPV6_AUTHORITY_RE ]]; then
            host="${BASH_REMATCH[1]}"
            port="${BASH_REMATCH[3]}"
        elif [[ "$authority" =~ $HOST_AUTHORITY_RE ]]; then
            host="${BASH_REMATCH[1]}"
            port="${BASH_REMATCH[3]}"
        else
            return 1
        fi
        host="${host,,}"
        if [ -n "$port" ]; then
            port=$(( 10#$port ))
            [ "$port" -le 65535 ] || return 1
            if { [ "$scheme" = "http" ] && [ "$port" -eq 80 ]; } ||
                { [ "$scheme" = "https" ] && [ "$port" -eq 443 ]; }; then
                port=""
            fi
        fi
        [ -n "$port" ] && host="$host:$port"
        [ -n "$path" ] || path="/"
        printf '%s://%s%s' "$scheme" "$host" "$(encode_path "$(remove_dot_segments "$path")")"
        return 0
    fi
    case "$rest" in
        //*)
            rest="${rest#//}"
            authority="${rest%%[/?#]*}"
            rest="${rest:${#authority}}"
            path="${rest%%[?#]*}"
            [ -n "$path" ] || path="/"
            ;;
        *) path="${rest%%[?#]*}" ;;
    esac
    # .NET reports a file URL's drive path without the leading slash.
    if [ "$scheme" = "file" ] && [[ "$path" =~ $FILE_DRIVE_RE ]]; then
        path="${path#/}"
    fi
    printf '%s:%s' "$scheme" "$(encode_path "$path")"
}

if [ "$ACTION" = "Claim" ]; then
    if [[ ! "$OWNER" =~ ^[A-Za-z0-9._:-]+$ ]] || [ "${#OWNER}" -gt 80 ]; then
        fail "Owner must be 1-80 characters using letters, digits, period, underscore, colon, or hyphen."
    fi
    # Count characters, not bytes: drop UTF-8 continuation bytes first.
    TASK_CHARACTERS="${TASK//[$'\x80'-$'\xbf']/}"
    if [ "${#TASK_CHARACTERS}" -gt 120 ] || [[ "$TASK" == *[[:cntrl:]]* ]]; then
        fail "Task must be at most 120 printable characters."
    fi
    if [[ -z "${URL//[[:space:]]/}" ]]; then
        fail "Claim requires the URL the tab was opened at."
    fi
    URL="$(redact_url "$URL")" || fail "Url must be an absolute URL."
fi
if { [ "$ACTION" = "Renew" ] || [ "$ACTION" = "Release" ]; } && [[ ! "$CLAIM_ID" =~ ^[a-f0-9]{32}$ ]]; then
    fail "$ACTION requires a valid claim ID."
fi
if [ "$ACTION" = "Renew" ] && [[ -n "${URL//[[:space:]]/}" ]]; then
    URL="$(redact_url "$URL")" || fail "Url must be an absolute URL."
else
    [ "$ACTION" = "Renew" ] && URL=""
fi

LOCKS_ROOT="$RUNTIME_ROOT/locks"
mkdir -p "$LOCKS_ROOT" || fail "Cannot create '$LOCKS_ROOT'."
CLAIM_PATH="$LOCKS_ROOT/tab-claims.json"
LOCK_PATH="$LOCKS_ROOT/tab-claims.lock"

exec 9>>"$LOCK_PATH" || fail "Cannot open the tab-claim lock at '$LOCK_PATH'."
if ! flock -w 5 9; then
    fail "The tab-claim registry remained busy for five seconds."
fi

# Read the registry into one record per claim, fields separated by the ASCII
# unit separator: claim_id, owner,
# task, url, claimed_utc, renewed_utc, expires_utc. String values stay in their
# JSON-escaped form (which never contains a raw control character), so they are written back
# byte for byte. A non-string value reads as empty. Prints INVALID when the
# file is not well-formed JSON. Plain POSIX awk, no JSON tool dependency.
read_registry() {
    [ -s "$CLAIM_PATH" ] || return 0
    awk '
    function fail_parse() { ERR = 1; P = N + 1 }
    function skip_ws(   c) {
        while (P <= N) {
            c = substr(S, P, 1)
            if (c == " " || c == "\t" || c == "\n" || c == "\r") P++
            else break
        }
    }
    function parse_string(   c, start) {
        P++
        start = P
        while (P <= N) {
            c = substr(S, P, 1)
            if (c == "\\") {
                if (index("\"\\/bfnrtu", substr(S, P + 1, 1)) == 0) { fail_parse(); return }
                P += 2
                continue
            }
            if (c == "\"") { STR = substr(S, start, P - start); P++; return }
            if (c < " ") { fail_parse(); return }
            P++
        }
        fail_parse()
    }
    # mode: "top" (root object), "claims" (value of the root claims key),
    # "item" (element of the claims array), "claim" (a claim object), "" (other).
    function parse_value(mode,   c, rest) {
        skip_ws()
        if (P > N) { fail_parse(); return "" }
        c = substr(S, P, 1)
        if (c == "\"") { parse_string(); return "s" }
        if (c == "{") {
            if (mode == "claims" || mode == "item") parse_object("claim")
            else parse_object(mode == "top" ? "top" : "")
            return "o"
        }
        if (c == "[") { parse_array(mode == "claims" ? "item" : ""); return "a" }
        rest = substr(S, P, 32)
        if (match(rest, /^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?/)) { P += RLENGTH; return "n" }
        if (substr(S, P, 4) == "true") { P += 4; return "b" }
        if (substr(S, P, 5) == "false") { P += 5; return "b" }
        if (substr(S, P, 4) == "null") { P += 4; return "z" }
        fail_parse()
        return ""
    }
    function parse_object(mode,   key, type, k) {
        P++
        if (mode == "claim") for (k in F) delete F[k]
        skip_ws()
        if (substr(S, P, 1) == "}") { P++; if (mode == "claim") emit(); return }
        while (P <= N) {
            skip_ws()
            if (substr(S, P, 1) != "\"") { fail_parse(); return }
            parse_string()
            key = STR
            skip_ws()
            if (substr(S, P, 1) != ":") { fail_parse(); return }
            P++
            if (mode == "top" && key == "claims") type = parse_value("claims")
            else type = parse_value("")
            if (ERR) return
            if (mode == "claim") F[key] = (type == "s") ? STR : ""
            skip_ws()
            c = substr(S, P, 1)
            if (c == ",") { P++; continue }
            if (c == "}") { P++; if (mode == "claim") emit(); return }
            fail_parse()
            return
        }
        fail_parse()
    }
    function parse_array(mode,   c) {
        P++
        skip_ws()
        if (substr(S, P, 1) == "]") { P++; return }
        while (P <= N) {
            parse_value(mode)
            if (ERR) return
            skip_ws()
            c = substr(S, P, 1)
            if (c == ",") { P++; continue }
            if (c == "]") { P++; return }
            fail_parse()
            return
        }
        fail_parse()
    }
    function emit() {
        OUT[++COUNT] = F["claim_id"] US F["owner"] US F["task"] US F["url"] US \
            F["claimed_utc"] US F["renewed_utc"] US F["expires_utc"]
    }
    { S = (NR == 1) ? $0 : S "\n" $0 }
    END {
        US = sprintf("%c", 31)
        sub(/^\357\273\277/, "", S)
        N = length(S)
        P = 1
        if (S ~ /^[ \t\r\n]*$/) exit
        parse_value("top")
        skip_ws()
        if (ERR || P <= N) { print "INVALID"; exit }
        for (i = 1; i <= COUNT; i++) print OUT[i]
    }' "$CLAIM_PATH"
}

# A timestamp in the round-trip form PowerShell writes ("o": seven fraction
# digits, Z). Anything else that parses is normalized to it, as the
# PowerShell sibling does on every pass; an unparsable value is rejected.
CANONICAL_TIME='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}Z$'
normalize_time() {
    local value="$1" seconds fraction
    if [[ "$value" =~ $CANONICAL_TIME ]]; then
        printf '%s' "$value"
        return 0
    fi
    [ -n "$value" ] || return 1
    seconds="$(date -u -d "$value" +%s.%N 2>/dev/null)" || return 1
    fraction="${seconds#*.}"
    fraction="${fraction:0:7}"
    printf '%s.%sZ' "$(date -u -d "@${seconds%.*}" +%Y-%m-%dT%H:%M:%S)" "$fraction"
}

NOW_RAW="$(date -u +%s.%N)"
NOW_SECONDS="${NOW_RAW%.*}"
NOW_FRACTION="${NOW_RAW#*.}"
NOW_FRACTION="${NOW_FRACTION:0:7}"
NOW="$(date -u -d "@$NOW_SECONDS" +%Y-%m-%dT%H:%M:%S).${NOW_FRACTION}Z"
EXPIRES_AT="$(date -u -d "@$(( NOW_SECONDS + TTL_SECONDS ))" +%Y-%m-%dT%H:%M:%S).${NOW_FRACTION}Z"

REGISTRY="$(read_registry)"
if [ "$REGISTRY" = "INVALID" ]; then
    fail "The tab-claim registry is invalid JSON."
fi

# Drop expired and malformed entries on every pass.
IDS=() OWNERS=() TASKS=() URLS=() CLAIMED=() RENEWED=() EXPIRES=()
while IFS=$'\037' read -r id owner task url claimed renewed expires; do
    [[ "$id" =~ ^[a-f0-9]{32}$ ]] || continue
    claimed="$(normalize_time "$claimed")" || continue
    renewed="$(normalize_time "$renewed")" || continue
    expires="$(normalize_time "$expires")" || continue
    [[ "$expires" > "$NOW" ]] || continue
    IDS+=("$id") OWNERS+=("$owner") TASKS+=("$task") URLS+=("$url")
    CLAIMED+=("$claimed") RENEWED+=("$renewed") EXPIRES+=("$expires")
done <<<"$REGISTRY"

write_registry() {
    local body="" index temp
    for index in "${!IDS[@]}"; do
        [ -n "$body" ] && body="$body,"
        body="$body$(printf '{"claim_id":"%s","owner":"%s","task":"%s","url":"%s","claimed_utc":"%s","renewed_utc":"%s","expires_utc":"%s"}' \
            "${IDS[$index]}" "${OWNERS[$index]}" "${TASKS[$index]}" "${URLS[$index]}" \
            "${CLAIMED[$index]}" "${RENEWED[$index]}" "${EXPIRES[$index]}")"
    done
    temp="$CLAIM_PATH.$$.tmp"
    printf '{"claims":[%s],"schema":1}' "$body" >"$temp" || { rm -f "$temp"; fail "Cannot write '$CLAIM_PATH'."; }
    mv -f "$temp" "$CLAIM_PATH" || { rm -f "$temp"; fail "Cannot write '$CLAIM_PATH'."; }
}

if [ "$ACTION" = "List" ] || [ "$ACTION" = "Status" ]; then
    body=""
    for index in "${!IDS[@]}"; do
        [ -n "$body" ] && body="$body,"
        body="$body$(printf '{"owner":"%s","task":"%s","url":"%s","claimed_utc":"%s","expires_utc":"%s"}' \
            "${OWNERS[$index]}" "${TASKS[$index]}" "${URLS[$index]}" "${CLAIMED[$index]}" "${EXPIRES[$index]}")"
    done
    printf '{"count":%s,"claims":[%s],"action":"list"}\n' "${#IDS[@]}" "$body"
    exit 0
fi

if [ "$ACTION" = "Claim" ]; then
    if [ "${#IDS[@]}" -ge "$MAX_CLAIMS" ]; then
        fail "The tab-claim registry already holds $MAX_CLAIMS active claims."
    fi
    NEW_CLAIM_ID="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
    [[ "$NEW_CLAIM_ID" =~ ^[a-f0-9]{32}$ ]] || fail "Could not generate a claim ID."
    IDS+=("$NEW_CLAIM_ID") OWNERS+=("$(json_escape "$OWNER")") TASKS+=("$(json_escape "$TASK")")
    URLS+=("$(json_escape "$URL")") CLAIMED+=("$NOW") RENEWED+=("$NOW") EXPIRES+=("$EXPIRES_AT")
    write_registry
    printf '{"action":"claim","claim_id":"%s","claimed":true,"owner":"%s","url":"%s","expires_utc":"%s"}\n' \
        "$NEW_CLAIM_ID" "$(json_escape "$OWNER")" "$(json_escape "$URL")" "$EXPIRES_AT"
    exit 0
fi

MATCH=""
for index in "${!IDS[@]}"; do
    [ "${IDS[$index]}" = "$CLAIM_ID" ] && MATCH="$index"
done
if [ -z "$MATCH" ]; then
    # Rewrite anyway so expired entries are pruned.
    write_registry
    printf '{"success":false,"reason":"claim-not-found-or-expired","action":"%s"}\n' "$(action_lower)"
    exit 76
fi

if [ "$ACTION" = "Renew" ]; then
    RENEWED[MATCH]="$NOW"
    EXPIRES[MATCH]="$EXPIRES_AT"
    [ -n "$URL" ] && URLS[MATCH]="$(json_escape "$URL")"
    write_registry
    printf '{"success":true,"url":"%s","claim_id":"%s","expires_utc":"%s","action":"renew"}\n' \
        "${URLS[$MATCH]}" "$CLAIM_ID" "$EXPIRES_AT"
    exit 0
fi

unset 'IDS[$MATCH]' 'OWNERS[$MATCH]' 'TASKS[$MATCH]' 'URLS[$MATCH]' \
    'CLAIMED[$MATCH]' 'RENEWED[$MATCH]' 'EXPIRES[$MATCH]'
write_registry
printf '{"success":true,"action":"release"}\n'
exit 0
