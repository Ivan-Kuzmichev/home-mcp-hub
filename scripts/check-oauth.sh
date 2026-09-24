#!/usr/bin/env bash
# Smoke checks from docs/SPEC.md → «План работ», stage 2.
# Usage: scripts/check-oauth.sh https://hub.example.com <secret>
set -uo pipefail

BASE="${1:?usage: $0 <base-url> <secret>}"
SECRET="${2:?usage: $0 <base-url> <secret>}"
BASE="${BASE%/}"
fail=0

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
mask() { sed "s/$SECRET/{secret}/g"; }

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

expect_status() {
  local want="$1" label="$2"; shift 2
  local got; got=$(status "$@")
  [[ "$got" == "$want" ]] && pass "$label → $got" || bad "$label → $got (want $want)"
}

echo "Without the prefix everything is an empty 404"
for p in / /admin /login /api/mcp /api/auth/ok /.well-known/oauth-authorization-server /.well-known/openid-configuration /.well-known/oauth-protected-resource; do
  expect_status 404 "GET $p" "$BASE$p"
done
expect_status 404 "POST /api/mcp" -X POST "$BASE/api/mcp"

echo "MCP without a token: 401 + WWW-Authenticate"
headers=$(curl -s -D - -o /dev/null -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$BASE/$SECRET/api/mcp")
code=$(echo "$headers" | head -1 | awk '{print $2}')
[[ "$code" == 401 ]] && pass "POST /{secret}/api/mcp → 401" || bad "POST /{secret}/api/mcp → $code (want 401)"
want_rm="resource_metadata=\"$BASE/$SECRET/.well-known/oauth-protected-resource\""
echo "$headers" | grep -qi "www-authenticate:.*$want_rm" && pass "WWW-Authenticate points at the prefixed PRM" \
  || bad "WWW-Authenticate: $(echo "$headers" | grep -i www-authenticate | mask)"

echo "Protected resource metadata"
prm=$(curl -s "$BASE/$SECRET/.well-known/oauth-protected-resource")
echo "$prm" | grep -q "\"resource\":\"$BASE/$SECRET/api/mcp\"" && pass "resource = $BASE/{secret}/api/mcp" || bad "PRM: $(echo "$prm" | mask)"
echo "$prm" | grep -q "\"authorization_servers\":\[\"$BASE/$SECRET\"\]" && pass "authorization_servers = [$BASE/{secret}]" || bad "PRM authorization_servers"

echo "Authorization server metadata at all three addresses"
for p in "/.well-known/oauth-authorization-server/$SECRET" "/.well-known/openid-configuration/$SECRET" "/$SECRET/.well-known/openid-configuration"; do
  label="GET $(echo "$p" | mask)"
  md=$(curl -s "$BASE$p")
  if echo "$md" | grep -q "\"issuer\":\"$BASE/$SECRET\"" \
    && echo "$md" | grep -q '"registration_endpoint"' \
    && echo "$md" | grep -q '"code_challenge_methods_supported":\["S256"\]'; then
    pass "$label: issuer, registration_endpoint, S256"
  else
    bad "$label: $(echo "$md" | head -c 300 | mask)"
  fi
done
expect_status 404 "AS metadata with a wrong secret" "$BASE/.well-known/oauth-authorization-server/wrong-secret-000"

echo "Dynamic client registration"
reg=$(curl -s -w '\n%{http_code}' -H 'Content-Type: application/json' \
  -d '{"client_name":"check-oauth","redirect_uris":["https://evil.example.com/cb"],"token_endpoint_auth_method":"none"}' \
  "$BASE/$SECRET/api/auth/oauth2/register")
code=$(echo "$reg" | tail -1)
[[ "$code" == 400 || "$code" == 403 ]] && pass "foreign redirect_uri rejected → $code" || bad "foreign redirect_uri → $code"
code=$(status -H 'Content-Type: application/json' \
  -d '{"client_name":"check-oauth","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"token_endpoint_auth_method":"none"}' \
  "$BASE/$SECRET/api/auth/oauth2/register")
case "$code" in
  403) pass "registration disabled (allow_dcr off) → 403" ;;
  200|201) pass "registration enabled (allow_dcr on) → $code; delete the check-oauth client in the admin panel" ;;
  *) bad "Claude redirect_uri registration → $code" ;;
esac

echo
[[ $fail == 0 ]] && echo "All checks passed" || echo "Some checks failed"
exit $fail
