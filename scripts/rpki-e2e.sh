#!/usr/bin/env bash
# Disposable Docker/controller/Agent/BIRD lab; no host routing changes.
set -euo pipefail
PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIRECTORY=$(mktemp -d /tmp/birdbox-rpki-e2e.XXXXXX)
TEST_ID="birdbox-rpki-$(basename "$TEST_DIRECTORY" | tr '[:upper:]' '[:lower:]')"
CONTROLLER="$TEST_ID-controller"
TEST_NODE="$TEST_ID-node"
TEST_IMAGE="birdbox-node-installer-e2e:${BIRD_VERSION:-2.17.5}"
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    docker exec "$TEST_NODE" sh -c 'birdc -s /run/bird/bird.ctl show protocols all; birdc -s /run/bird/bird.ctl show route table RTR4 all; birdc -s /run/bird/bird.ctl show route table RTR6 all' 2>/dev/null || true
    docker logs --tail 30 "$CONTROLLER" 2>/dev/null || true
    docker exec "$TEST_NODE" journalctl -u birdbox-agent --no-pager -n 20 2>/dev/null || true
  fi
  docker rm -f "$TEST_NODE" "$CONTROLLER" >/dev/null 2>&1 || true
  docker network rm "$TEST_ID" >/dev/null 2>&1 || true
  rm -rf "$TEST_DIRECTORY"
  exit "$status"
}
trap cleanup EXIT
if ! docker image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
  docker build --build-arg "BIRD_VERSION=${BIRD_VERSION:-2.17.5}" -t "$TEST_IMAGE" "$PROJECT_ROOT/scripts/fixtures/node-installer"
fi
mkdir -p "$TEST_DIRECTORY/bin"
docker run --rm -v "$PROJECT_ROOT/agent:/src:ro" -v "$TEST_DIRECTORY/bin:/out" -w /src -e CGO_ENABLED=0 golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804 \
  sh -c 'agent_arch=$(go env GOARCH); go build -trimpath -o "/out/birdbox-agent-$agent_arch" .'
cp "$PROJECT_ROOT/scripts/fixtures/node-installer/verify.mjs" "$TEST_DIRECTORY/verify.mjs"
cp "$PROJECT_ROOT/scripts/fixtures/rpki-verify.mjs" "$TEST_DIRECTORY/rpki-verify.mjs"
cp "$PROJECT_ROOT/scripts/fixtures/rpki-rtr.mjs" "$TEST_DIRECTORY/rpki-rtr.mjs"
docker network create "$TEST_ID" >/dev/null
docker run -d --name "$CONTROLLER" --network "$TEST_ID" -p 127.0.0.1::3000 -v "$PROJECT_ROOT:/app:ro" -v "$TEST_DIRECTORY:/verification" -w /app \
  -e NODE_ENV=test -e BIRDBOX_DATABASE_URL=memory: -e BIRDBOX_DATA_DIR=/verification/data -e BIRDBOX_NODES_FILE=/verification/no-nodes.json \
  -e BIRDBOX_HOST=0.0.0.0 -e BIRDBOX_PORT=3000 -e "BIRDBOX_PUBLIC_URL=http://$CONTROLLER:3000" -e BIRDBOX_SECURE_COOKIE=false \
  -e BIRDBOX_AGENT_BINARY_PATH=/verification/bin node:24-bookworm@sha256:7b559cf7f77d837192392499a850abb1a3d1f49fbc2bd0692d54b212c9e38f6d node --import=tsx src/server.ts >/dev/null
docker exec "$CONTROLLER" node -e 'for(let i=0;i<100;i++){try{if((await fetch("http://127.0.0.1:3000/api/health")).ok)process.exit(0)}catch{} await new Promise(r=>setTimeout(r,200))}process.exit(1)'
docker exec "$CONTROLLER" node /verification/verify.mjs setup
docker run -d --name "$TEST_NODE" --network "$TEST_ID" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock --tmpfs /tmp "$TEST_IMAGE" >/dev/null
docker exec -i "$TEST_NODE" sh -c 'cat > /etc/bird/bird.conf' <<'BIRD'
router id 192.0.2.1;
protocol device {}
protocol direct lab_connected { interface "lab0"; ipv4; ipv6; }
BIRD
for attempt in $(seq 1 100); do
  if docker exec "$TEST_NODE" test -S /run/systemd/private; then break; fi
  sleep .1
done
docker exec "$TEST_NODE" sh -c 'ip link add lab0 type dummy; ip link set lab0 up; ip addr add 192.0.2.1/24 dev lab0; ip -6 addr add 2001:db8:ff::1/64 dev lab0; sleep 2'
docker exec "$TEST_NODE" systemctl restart bird
docker cp "$TEST_DIRECTORY/first.sh" "$TEST_NODE:/root/install.sh"
docker exec "$TEST_NODE" sh /root/install.sh > "$TEST_DIRECTORY/install.log" 2>&1
docker exec "$CONTROLLER" node /verification/verify.mjs online "$(docker exec "$TEST_NODE" hostname)"
docker exec "$CONTROLLER" node /verification/verify.mjs create
docker exec -i "$TEST_NODE" sh -c 'cat > /etc/bird/roa4.conf' <<'ROA4'
route 198.51.100.0/24 max 28 as 64514;
ROA4
docker exec -i "$TEST_NODE" sh -c 'cat > /etc/bird/roa6.conf' <<'ROA6'
route 2001:db8:100::/48 max 64 as 64515;
ROA6
docker exec "$CONTROLLER" node /verification/rpki-verify.mjs "$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTROLLER")"
docker exec "$TEST_NODE" sh -c 'bird --version; bird -p -c /etc/bird/bird.conf'
echo "PASS: RPKI real HTTP + installed Go Agent + BIRD ${BIRD_VERSION:-2.17.5}; Debian 12; real RTR v1 TCP; dual-stack announcements/serial withdrawal; local ROA files; dependencies; CAS; stop/re-enable/delete; private Docker network"
