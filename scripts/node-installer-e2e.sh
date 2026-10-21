#!/usr/bin/env bash
# Requires Docker (including privileged containers for real systemd), network access,
# and npm dependencies installed in the checkout. No host services/config are modified.
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FIXTURES="$PROJECT_ROOT/scripts/fixtures/node-installer"
TEST_DIRECTORY=$(mktemp -d /tmp/birdbox-node-installer.XXXXXX)
TEST_ID="birdbox-installer-$(basename "$TEST_DIRECTORY" | tr '[:upper:]' '[:lower:]')"
CONTROLLER="$TEST_ID-controller"
TEST_NODE="$TEST_ID-node"
TEST_IMAGE="birdbox-node-installer-e2e:${BIRD_VERSION:-2.17.5}"

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    docker logs --tail 25 "$CONTROLLER" 2>/dev/null || true
    docker exec "$TEST_NODE" journalctl -u birdbox-agent --no-pager -n 20 2>/dev/null || true
  fi
  docker rm -f "$TEST_NODE" "$CONTROLLER" >/dev/null 2>&1 || true
  docker network rm "$TEST_ID" >/dev/null 2>&1 || true
  rm -rf "$TEST_DIRECTORY"
  exit "$status"
}
trap cleanup EXIT

docker build --build-arg "BIRD_VERSION=${BIRD_VERSION:-2.17.5}" -t "$TEST_IMAGE" "$FIXTURES" > "$TEST_DIRECTORY/image-build.log" 2>&1 || {
  cat "$TEST_DIRECTORY/image-build.log"; exit 1;
}
mkdir -p "$TEST_DIRECTORY/bin"
docker run --rm -v "$PROJECT_ROOT/agent:/src:ro" -v "$TEST_DIRECTORY/bin:/out" -w /src \
  -e CGO_ENABLED=0 golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804 \
  sh -c 'agent_arch=$(go env GOARCH); go build -trimpath -ldflags="-s -w -X main.version=installer-e2e -X main.buildArch=$agent_arch" -o "/out/birdbox-agent-$agent_arch" .'
cp "$FIXTURES/verify.mjs" "$TEST_DIRECTORY/verify.mjs"
docker network create "$TEST_ID" >/dev/null
docker run -d --name "$CONTROLLER" --network "$TEST_ID" \
  -v "$PROJECT_ROOT:/app:ro" -v "$TEST_DIRECTORY:/verification" -w /app \
  -e NODE_ENV=test -e BIRDBOX_DATABASE_URL=memory: -e BIRDBOX_DATA_DIR=/verification/data \
  -e BIRDBOX_NODES_FILE=/verification/no-nodes.json -e BIRDBOX_HOST=0.0.0.0 -e BIRDBOX_PORT=3000 \
  -e "BIRDBOX_PUBLIC_URL=http://$CONTROLLER:3000" -e BIRDBOX_SECURE_COOKIE=false \
  -e BIRDBOX_AGENT_BINARY_PATH=/verification/bin \
  node:24-bookworm@sha256:7b559cf7f77d837192392499a850abb1a3d1f49fbc2bd0692d54b212c9e38f6d node --import=tsx src/server.ts >/dev/null
docker exec "$CONTROLLER" node -e '
  for(let i=0;i<100;i++){try{if((await fetch("http://127.0.0.1:3000/api/health")).ok)process.exit(0)}catch{}
  await new Promise(r=>setTimeout(r,200))}process.exit(1)'

verify() { docker exec "$CONTROLLER" node /verification/verify.mjs "$@"; }
create_node() {
  docker run -d --name "$TEST_NODE" --network "$TEST_ID" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock --tmpfs /tmp "$TEST_IMAGE" >/dev/null
  docker exec -i "$TEST_NODE" sh -c 'cat > /etc/bird/bird.conf' <<'EOF'
router id 192.0.2.1;
protocol device {}
EOF
  docker exec "$TEST_NODE" sh -c '
    systemctl restart bird
    for i in $(seq 1 100); do birdc -s /run/bird/bird.ctl show status >/dev/null 2>&1 && break; sleep .1; done
    bird -p -c /etc/bird/bird.conf
    birdc -s /run/bird/bird.ctl show status'
  docker cp "$FIXTURES/check-process.mjs" "$TEST_NODE:/root/check-process.mjs"
}
install_script() {
  docker cp "$TEST_DIRECTORY/$1" "$TEST_NODE:/root/install.sh"
  docker exec "$TEST_NODE" sh /root/install.sh
  verify online "$(docker exec "$TEST_NODE" hostname)"
  docker exec "$TEST_NODE" node /root/check-process.mjs
}
check_config() {
  docker exec "$TEST_NODE" sh -c '
    bird -p -c /etc/bird/bird.conf
    test "$(grep -Fc "include \"/var/lib/birdbox/generated.conf\";" /etc/bird/bird.conf)" -eq 1
    birdc show route 198.51.100.0/24 all | grep -F installer_sentinel'
}

verify setup
create_node
install_script first-command.sh
verify create
check_config
verify reinstall
verify credentials
previous_pid=$(docker exec "$TEST_NODE" systemctl show birdbox-agent --property=MainPID --value)
install_script reinstall.sh
current_pid=$(docker exec "$TEST_NODE" systemctl show birdbox-agent --property=MainPID --value)
test "$previous_pid" != "$current_pid"
verify credentials
verify apply
check_config
echo 'PASS: repeated install restarts the Agent and keeps a single valid BIRD include'

# Delete the whole node filesystem, then run the copied command on a clean host.
docker rm -f "$TEST_NODE" >/dev/null
create_node
install_script reinstall-command.sh
verify credentials
verify apply
check_config
echo "PASS: clean-host migration and restored routes (Debian 12, $(docker exec "$TEST_NODE" uname -m), BIRD ${BIRD_VERSION:-2.17.5}, real systemd)"
