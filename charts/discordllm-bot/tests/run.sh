#!/bin/sh
# Checks the chart: that it lints and renders what its values say.
#
#   sh charts/discordllm-bot/tests/run.sh
set -eu

chart=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0

ok() { echo "  ok    $1"; }
bad() { echo "  FAIL  $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

base="--set image.repository=ghcr.io/you/mybot --set image.tag=main-1-abc"
render() { helm template mybot "$chart" --namespace bots $base "$@"; }

echo "chart"
check "lints" "helm lint '$chart' $base >/dev/null 2>&1"

render > "$work/default.yaml"
check "names objects after the release" "grep -q '^  name: mybot$' '$work/default.yaml'"
check "creates a claim called <release>-data" "grep -q '^  name: mybot-data$' '$work/default.yaml'"
check "keeps the claim on uninstall" "grep -q 'helm.sh/resource-policy: keep' '$work/default.yaml'"
check "runs one replica, recreated" "grep -q 'type: Recreate' '$work/default.yaml' && grep -q 'replicas: 1' '$work/default.yaml'"
check "puts HOME on the volume" "grep -A1 'name: HOME' '$work/default.yaml' | grep -q '/data/home'"
check "has no Service unless asked" "! grep -q 'kind: Service' '$work/default.yaml'"

check "refuses to render without an image tag" "! helm template mybot '$chart' --set image.repository=x >/dev/null 2>&1"

render --set config.BOT_TIMEZONE=UTC --set-string config.DISCORD_GUILD_ID=123456789012345678 > "$work/config.yaml"
check "writes settings as strings" "grep -q 'DISCORD_GUILD_ID: \"123456789012345678\"' '$work/config.yaml'"
a=$(grep 'checksum/config' "$work/default.yaml")
b=$(grep 'checksum/config' "$work/config.yaml")
check "restarts the pod when a setting changes" "[ '$a' != '$b' ]"

render --set secretEnv.DISCORD_BOT_TOKEN.secret=mybot-secrets --set secretEnv.DISCORD_BOT_TOKEN.key=discord-bot-token \
  --set 'envFromSecrets[0]=mybot-env' > "$work/secrets.yaml"
check "maps a secret key to a variable" "grep -A4 'name: DISCORD_BOT_TOKEN' '$work/secrets.yaml' | grep -q 'key: discord-bot-token'"
check "loads a whole secret" "grep -A1 'secretRef' '$work/secrets.yaml' | grep -q 'name: mybot-env'"

render --set secrets.DISCORD_BOT_TOKEN=abc --set secrets.HOMEBOX_TOKEN=def > "$work/created.yaml"
check "creates a Secret from values and loads it" "grep -q '^  name: mybot-secrets$' '$work/created.yaml' && grep -q 'DISCORD_BOT_TOKEN: \"abc\"' '$work/created.yaml' && grep -A1 'secretRef' '$work/created.yaml' | grep -q 'name: mybot-secrets'"
c=$(grep 'checksum/secrets' "$work/created.yaml")
d=$(render --set secrets.DISCORD_BOT_TOKEN=changed | grep 'checksum/secrets')
check "restarts the pod when a secret value changes" "[ '$c' != '$d' ]"
check "creates no Secret unless given values" "! grep -q 'kind: Secret' '$work/default.yaml'"

cat > "$work/extra.yaml" <<'YAML'
extraObjects:
  - apiVersion: external-secrets.io/v1
    kind: ExternalSecret
    metadata:
      name: '{{ include "bot.fullname" . }}-env'
    spec:
      target:
        name: '{{ include "bot.fullname" . }}-env'
  - |
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: {{ .Release.Name }}-extra
YAML
render -f "$work/extra.yaml" > "$work/extras.yaml"
check "installs extra objects, templated, as maps or strings" "grep -q 'kind: ExternalSecret' '$work/extras.yaml' && grep -q 'mybot-env' '$work/extras.yaml' && grep -q 'name: mybot-extra' '$work/extras.yaml'"

render --set persistence.existingClaim=old-claim > "$work/existing.yaml"
check "uses an existing claim and creates none" "grep -q 'claimName: old-claim' '$work/existing.yaml' && ! grep -q PersistentVolumeClaim '$work/existing.yaml'"

render --set persistence.name=mybot-storage --set persistence.size=5Gi --set persistence.storageClass=fast > "$work/named.yaml"
check "creates the claim as asked" "grep -q '^  name: mybot-storage$' '$work/named.yaml' && grep -q 'storage: \"5Gi\"' '$work/named.yaml' && grep -q 'storageClassName: \"fast\"' '$work/named.yaml' && grep -q 'claimName: mybot-storage' '$work/named.yaml'"

render --set persistence.enabled=false > "$work/none.yaml"
check "runs with no volume when persistence is off" "! grep -q PersistentVolumeClaim '$work/none.yaml' && ! grep -q 'name: HOME' '$work/none.yaml'"

echo
if [ "$fails" -gt 0 ]; then echo "$fails failed"; exit 1; fi
echo "all passed"
