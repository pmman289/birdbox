#!/usr/bin/env bash
set -euo pipefail

ROOT=/tmp/birdbox-irr-scheduler-e2e
REMOTE_ROOT=/var/lib/birdbox-irr-scheduler-e2e
REMOTE_RUN=/run/birdbox-irr-scheduler-e2e
REMOTE_USER=birdboxirre2e
SSH_TARGET=${IRR_E2E_SSH_TARGET:?请设置 IRR_E2E_SSH_TARGET 为隔离测试节点的 SSH Host 别名}
SSH_HOST=$(ssh -T -G "$SSH_TARGET" | awk '$1 == "hostname" { print $2; exit }')
SSH_PORT=$(ssh -T -G "$SSH_TARGET" | awk '$1 == "port" { print $2; exit }')
TEST_PASSWORD=$(tr -d - < /proc/sys/kernel/random/uuid)
PORT=31988
SERVER_PID=
LOCAL_BIRD_PID=

cleanup() {
  set +e
  [ -z "$SERVER_PID" ] || kill -TERM "$SERVER_PID" 2>/dev/null
  [ -z "$SERVER_PID" ] || wait "$SERVER_PID" 2>/dev/null
  [ -z "$LOCAL_BIRD_PID" ] || kill -TERM "$LOCAL_BIRD_PID" 2>/dev/null
  [ -z "$LOCAL_BIRD_PID" ] || wait "$LOCAL_BIRD_PID" 2>/dev/null
  ssh "$SSH_TARGET" "if [ -r '$REMOTE_RUN/bird.pid' ]; then kill -TERM \$(cat '$REMOTE_RUN/bird.pid') 2>/dev/null || true; fi; userdel '$REMOTE_USER' 2>/dev/null || true; rm -rf '$REMOTE_ROOT' '$REMOTE_RUN' '/home/$REMOTE_USER'" >/dev/null 2>&1
  rm -rf "$ROOT"
}
trap cleanup EXIT

rm -rf "$ROOT"
install -d -m 0755 "$ROOT" "$ROOT/fakebin"
install -d -m 0700 "$ROOT/data" "$ROOT/data/ssh"
install -d -o bird -g bird -m 0750 "$ROOT/runtime" "$ROOT/run"

ssh-keygen -q -t ed25519 -N '' -C birdbox-controller -f "$ROOT/data/ssh/id_ed25519"
ssh-keyscan -H -p "$SSH_PORT" "$SSH_HOST" > "$ROOT/data/ssh/known_hosts" 2>/dev/null
chmod 0600 "$ROOT/data/ssh/id_ed25519" "$ROOT/data/ssh/known_hosts"

PUBLIC_KEY=$(cut -d' ' -f1-2 "$ROOT/data/ssh/id_ed25519.pub")
ssh "$SSH_TARGET" "set -e
  if ! id '$REMOTE_USER' >/dev/null 2>&1; then useradd -M -s /bin/sh -G bird '$REMOTE_USER'; fi
  install -d -o '$REMOTE_USER' -g bird -m 0750 '$REMOTE_ROOT' '$REMOTE_ROOT/versions' '$REMOTE_ROOT/resources' '$REMOTE_ROOT/resources/versions'
  install -d -o bird -g bird -m 0750 '$REMOTE_RUN'
  install -d -o '$REMOTE_USER' -g '$REMOTE_USER' -m 0700 '/home/$REMOTE_USER' '/home/$REMOTE_USER/.ssh'
  printf '%s\n' 'restrict $PUBLIC_KEY' > '/home/$REMOTE_USER/.ssh/authorized_keys'
  chown '$REMOTE_USER:$REMOTE_USER' '/home/$REMOTE_USER/.ssh/authorized_keys'
  chmod 0600 '/home/$REMOTE_USER/.ssh/authorized_keys'
  printf '%s\n' '# initial generated config' > '$REMOTE_ROOT/versions/generated.conf.initial.conf'
  chown '$REMOTE_USER:bird' '$REMOTE_ROOT/versions/generated.conf.initial.conf'
  chmod 0640 '$REMOTE_ROOT/versions/generated.conf.initial.conf'
  ln -sfn 'versions/generated.conf.initial.conf' '$REMOTE_ROOT/generated.conf'
  printf '%s\n' 'router id 192.0.2.20;' 'protocol device {}' 'include \"$REMOTE_ROOT/generated.conf\";' > '$REMOTE_ROOT/main.conf'
  chown '$REMOTE_USER:bird' '$REMOTE_ROOT/main.conf'
  chmod 0640 '$REMOTE_ROOT/main.conf'
  /usr/sbin/bird -c '$REMOTE_ROOT/main.conf' -s '$REMOTE_RUN/bird.ctl' -P '$REMOTE_RUN/bird.pid' -u bird -g bird
  for i in \$(seq 1 50); do [ -S '$REMOTE_RUN/bird.ctl' ] && break; sleep .1; done
  test -S '$REMOTE_RUN/bird.ctl'"

printf '%s\n' 'router id 192.0.2.10;' 'protocol device {}' > "$ROOT/runtime/bird.conf"
chown bird:bird "$ROOT/runtime/bird.conf"
chmod 0640 "$ROOT/runtime/bird.conf"
/usr/sbin/bird -c "$ROOT/runtime/bird.conf" -s "$ROOT/run/bird.ctl" -P "$ROOT/run/bird.pid" -u bird -g bird
LOCAL_BIRD_PID=$(cat "$ROOT/run/bird.pid")
for _ in $(seq 1 50); do [ -S "$ROOT/run/bird.ctl" ] && break; sleep .1; done
test -S "$ROOT/run/bird.ctl"

cat > "$ROOT/fakebin/bgpq4" <<'SCRIPT'
#!/bin/sh
set -eu
state="${BIRDBOX_IRR_E2E_STATE:?}"
count=0
[ ! -r "$state" ] || count=$(cat "$state")
count=$((count + 1))
printf '%s\n' "$count" > "$state"
if [ "$count" -eq 1 ]; then prefix=192.0.2.0/24
elif [ "$count" -eq 2 ]; then prefix=198.51.100.0/24
else echo 'simulated IRR failure' >&2; exit 1
fi
printf '{"birdbox_prefixes":[{"prefix":"%s","exact":true}]}\n' "$prefix"
SCRIPT
chmod 0755 "$ROOT/fakebin/bgpq4"

cat > "$ROOT/data/inventory.json" <<JSON
{
  "version": 27,
  "nodes": [
    {
      "id": "local_e2e", "kind": "managed-node", "name": "Local E2E",
      "transport": "local", "sshHost": null, "sshPort": null, "sshUser": null,
      "sshIdentity": "default", "deploymentMode": "legacy",
      "mainConfigPath": "$ROOT/runtime/bird.conf", "generatedConfigPath": "$ROOT/runtime/bird.conf",
      "socketPath": "$ROOT/run/bird.ctl", "routerId": "192.0.2.10", "listenPort": 179
    },
    {
      "id": "remote_e2e", "kind": "managed-node", "name": "Remote E2E",
      "transport": "ssh", "sshHost": "$SSH_HOST", "sshPort": $SSH_PORT, "sshUser": "$REMOTE_USER",
      "sshIdentity": "managed", "deploymentMode": "include",
      "mainConfigPath": "$REMOTE_ROOT/main.conf", "generatedConfigPath": "$REMOTE_ROOT/generated.conf",
      "socketPath": "$REMOTE_RUN/bird.ctl", "routerId": "192.0.2.20", "listenPort": 179
    }
  ],
  "peers": [], "defines": [], "functions": [], "filters": [], "rpki": [],
  "staticProtocols": [], "sourcePolicies": [], "sessions": [], "ibgpDomains": []
}
JSON

PATH="$ROOT/fakebin:$PATH" \
NODE_ENV=test BIRDBOX_DATABASE_URL=memory: \
BIRDBOX_DATA_DIR="$ROOT/data" BIRDBOX_NODES_FILE="$ROOT/nodes.json" \
BIRDBOX_HOST=127.0.0.1 BIRDBOX_PORT="$PORT" \
BIRDBOX_RUNTIME_DIR="$ROOT/runtime" BIRDBOX_SOCKET_PATH="$ROOT/run/bird.ctl" BIRDBOX_PID_PATH="$ROOT/run/bird.pid" \
BIRDBOX_IRR_MIN_REFRESH_INTERVAL_SECONDS=1 BIRDBOX_IRR_SCHEDULER_INTERVAL_MS=250 \
BIRDBOX_IRR_E2E_STATE="$ROOT/bgpq-count" \
./node_modules/.bin/tsx src/server.ts > "$ROOT/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 100); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep .1; done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null
curl -fsS -c "$ROOT/cookies" -H 'content-type: application/json' \
  -d "{\"password\":\"$TEST_PASSWORD\",\"confirmation\":\"$TEST_PASSWORD\"}" \
  "http://127.0.0.1:$PORT/api/auth/setup" >/dev/null

CREATE=$(curl -fsS -b "$ROOT/cookies" -H 'content-type: application/json' \
  -d '{"nodeIds":null,"label":"IRR scheduler E2E","name":"IRR_E2E_V4","type":"cidr4","enabled":true,"entrySource":{"kind":"irr-as-set","asSet":"AS219332:AS-PMMAN","server":"rr.ntt.net","databases":[],"refreshIntervalSeconds":2,"prefixLimit":100,"allowMoreSpecific":false},"entries":["203.0.113.0/24"]}' \
  "http://127.0.0.1:$PORT/api/defines")
DEFINE_ID=$(node -e 'const x=JSON.parse(process.argv[1]); if(x.resource.entries[0]!=="192.0.2.0/24")process.exit(1); process.stdout.write(x.resource.id)' "$CREATE")

LOCAL_LINK="$ROOT/runtime/resources/define_${DEFINE_ID}.conf"
REMOTE_LINK="$REMOTE_ROOT/resources/define_${DEFINE_ID}.conf"
test "$(grep -c '192.0.2.0/24' "$LOCAL_LINK")" -eq 1
ssh "$SSH_TARGET" "test \"\$(grep -c '192.0.2.0/24' '$REMOTE_LINK')\" -eq 1"
LOCAL_FIRST=$(readlink "$LOCAL_LINK")
REMOTE_FIRST=$(ssh "$SSH_TARGET" "readlink '$REMOTE_LINK'")

sleep 1
test "$(cat "$ROOT/bgpq-count")" -eq 1
test "$(readlink "$LOCAL_LINK")" = "$LOCAL_FIRST"
test "$(ssh "$SSH_TARGET" "readlink '$REMOTE_LINK'")" = "$REMOTE_FIRST"

for _ in $(seq 1 30); do
  [ "$(cat "$ROOT/bgpq-count")" -ge 2 ] && grep -q '198.51.100.0/24' "$LOCAL_LINK" \
    && ssh "$SSH_TARGET" "grep -q '198.51.100.0/24' '$REMOTE_LINK'" && break
  sleep .25
done
test "$(cat "$ROOT/bgpq-count")" -ge 2
grep -q '198.51.100.0/24' "$LOCAL_LINK"
ssh "$SSH_TARGET" "grep -q '198.51.100.0/24' '$REMOTE_LINK'"
LOCAL_SECOND=$(readlink "$LOCAL_LINK")
REMOTE_SECOND=$(ssh "$SSH_TARGET" "readlink '$REMOTE_LINK'")
test "$LOCAL_FIRST" != "$LOCAL_SECOND"
test "$REMOTE_FIRST" != "$REMOTE_SECOND"

for _ in $(seq 1 30); do [ "$(cat "$ROOT/bgpq-count")" -ge 3 ] && break; sleep .25; done
test "$(cat "$ROOT/bgpq-count")" -ge 3
sleep 1
test "$(cat "$ROOT/bgpq-count")" -eq 3
test "$(readlink "$LOCAL_LINK")" = "$LOCAL_SECOND"
test "$(ssh "$SSH_TARGET" "readlink '$REMOTE_LINK'")" = "$REMOTE_SECOND"
grep -q '198.51.100.0/24' "$LOCAL_LINK"
ssh "$SSH_TARGET" "grep -q '198.51.100.0/24' '$REMOTE_LINK'"

LOCAL_CHECK=$(birdc -s "$ROOT/run/bird.ctl" 'configure check')
REMOTE_CHECK=$(ssh "$SSH_TARGET" "birdc -s '$REMOTE_RUN/bird.ctl' 'configure check'")
DASHBOARD=$(curl -fsS -b "$ROOT/cookies" "http://127.0.0.1:$PORT/api/dashboard")
node -e 'const x=JSON.parse(process.argv[1]); const d=x.inventory.defines[0]; if(d.entries[0]!=="198.51.100.0/24"||d.sync.status!=="error"||!d.sync.error.includes("simulated IRR failure"))process.exit(1); console.log(JSON.stringify({entries:d.entries,status:d.sync.status,error:d.sync.error,contentHash:d.sync.contentHash,lastSuccessAt:d.sync.lastSuccessAt,nextRefreshAt:d.sync.nextRefreshAt}))' "$DASHBOARD"
printf 'local_first=%s\nlocal_second=%s\nremote_first=%s\nremote_second=%s\nlocal_check=%s\nremote_check=%s\nbgpq_calls=%s\n' \
  "$LOCAL_FIRST" "$LOCAL_SECOND" "$REMOTE_FIRST" "$REMOTE_SECOND" "$LOCAL_CHECK" "$REMOTE_CHECK" "$(cat "$ROOT/bgpq-count")"
