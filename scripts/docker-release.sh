#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE_REPOSITORY=${RELEASE_IMAGE:-pmman/birdbox}
BUILDER=${RELEASE_BUILDER:-birdbox-builder}
SMOKE_PORT=${RELEASE_SMOKE_PORT:-33100}
SMOKE_TIMEOUT=${RELEASE_SMOKE_TIMEOUT:-180}
SKIP_TESTS=0
SKIP_SMOKE=0
OVERWRITE_VERSION=0
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: scripts/docker-release.sh [options]

Build and publish the current package.json version, then update the latest tag.

Options:
  --skip-tests          Skip npm test (npm ci and npm run build still run).
  --skip-smoke          Skip the local Compose smoke test.
  --overwrite-version  Allow replacing an existing version tag.
  --dry-run             Print release metadata and exit before Docker/npm work.
  -h, --help            Show this help.

Environment:
  RELEASE_IMAGE          Image repository (default: pmman/birdbox).
  RELEASE_BUILDER        Buildx builder (default: birdbox-builder).
  RELEASE_SMOKE_PORT     Host port for smoke Compose (default: 33100).
  RELEASE_SMOKE_TIMEOUT  Health wait timeout in seconds (default: 180).
  RELEASE_SMOKE_PROJECT  Compose project name; default is a unique temporary name.
  ALLOW_VERSION_OVERWRITE=1 is equivalent to --overwrite-version.
USAGE
}

die() {
  printf 'release: error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf 'release: %s\n' "$*"
}

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

while (($# > 0)); do
  case "$1" in
    --skip-tests)
      SKIP_TESTS=1
      ;;
    --skip-smoke)
      SKIP_SMOKE=1
      ;;
    --overwrite-version)
      OVERWRITE_VERSION=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
  shift
done

if [[ ${ALLOW_VERSION_OVERWRITE:-0} == 1 ]]; then
  OVERWRITE_VERSION=1
fi

cd "$ROOT_DIR"

command -v node >/dev/null 2>&1 || die 'node is required'
VERSION=$(node -p "const p = JSON.parse(require('fs').readFileSync('package.json', 'utf8')); p.version || ''")
[[ "$VERSION" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid package version: $VERSION"
[[ "$VERSION" != latest ]] || die 'package version must not be latest'
[[ "$IMAGE_REPOSITORY" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid image repository: $IMAGE_REPOSITORY"
[[ "$SMOKE_PORT" =~ ^[0-9]+$ ]] && ((10#$SMOKE_PORT >= 1 && 10#$SMOKE_PORT <= 65535)) || die "invalid smoke port: $SMOKE_PORT"
[[ "$SMOKE_TIMEOUT" =~ ^[0-9]+$ ]] && ((10#$SMOKE_TIMEOUT >= 1)) || die "invalid smoke timeout: $SMOKE_TIMEOUT"

command -v git >/dev/null 2>&1 || die 'git is required'
GIT_STATUS=$(git status --porcelain=v1)
if [[ -n "$GIT_STATUS" ]]; then
  printf '%s\n' "$GIT_STATUS" >&2
  die 'working tree is not clean; commit or stash changes before releasing'
fi
VCS_REF=$(git rev-parse --short=12 HEAD)
BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
VERSION_IMAGE="${IMAGE_REPOSITORY}:${VERSION}"
LATEST_IMAGE="${IMAGE_REPOSITORY}:latest"

note "version=${VERSION} commit=${VCS_REF} build_date=${BUILD_DATE}"
note "version image=${VERSION_IMAGE} latest image=${LATEST_IMAGE}"

if ((DRY_RUN)); then
  note 'dry run; no npm, Docker, registry, or Compose commands executed'
  exit 0
fi

for command_name in npm docker curl sha256sum awk tr; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done
docker buildx version >/dev/null 2>&1 || die 'Docker Buildx is required'
docker compose version >/dev/null 2>&1 || die 'Docker Compose is required'

if ((OVERWRITE_VERSION == 0)); then
  inspect_status=0
  inspect_output=$(docker buildx imagetools inspect "$VERSION_IMAGE" 2>&1) || inspect_status=$?
  if ((inspect_status == 0)); then
    die "version tag already exists: $VERSION_IMAGE (use --overwrite-version only for an intentional replacement)"
  fi
  if ! grep -Eiq 'not found|manifest unknown|no such manifest|404' <<<"$inspect_output"; then
    inspect_error="$inspect_output"
    printf '%s\n' "$inspect_error" >&2
    die "cannot determine whether version tag exists: $VERSION_IMAGE"
  fi
else
  note "version tag replacement enabled for $VERSION_IMAGE"
fi

if docker buildx inspect --builder "$BUILDER" >/dev/null 2>&1; then
  note "using existing Buildx builder $BUILDER"
else
  run docker buildx create --name "$BUILDER" --driver docker-container --driver-opt network=host --use
fi
run docker buildx inspect --builder "$BUILDER" --bootstrap >/dev/null

run npm ci
if ((SKIP_TESTS == 0)); then
  run npm test
else
  note 'npm test skipped'
fi
run npm run build

run docker buildx build \
  --builder "$BUILDER" \
  --platform linux/amd64 \
  --build-arg "BIRDBOX_VERSION=$VERSION" \
  --build-arg "VCS_REF=$VCS_REF" \
  --build-arg "BUILD_DATE=$BUILD_DATE" \
  --tag "$VERSION_IMAGE" \
  --load \
  .

note 'checking local image metadata and all bundled Agent binaries'
actual_version=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$VERSION_IMAGE")
actual_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$VERSION_IMAGE")
actual_date=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.created"}}' "$VERSION_IMAGE")
[[ "$actual_version" == "$VERSION" ]] || die "image version label mismatch: $actual_version"
[[ "$actual_revision" == "$VCS_REF" ]] || die "image revision label mismatch: $actual_revision"
[[ "$actual_date" == "$BUILD_DATE" ]] || die "image build date label mismatch: $actual_date"

docker run --rm --platform linux/amd64 --user 0:0 --entrypoint /bin/sh "$VERSION_IMAGE" -c '
  set -eu
  directory=/usr/local/lib/birdbox-agent
  expected="amd64 arm64 arm armv6 armv5 mips mipsle mips64 mips64le riscv64"
  for arch in $expected; do
    path="/usr/local/lib/birdbox-agent-$arch"
    test -f "$path"
    test -x "$path"
  done
  test "$(find /usr/local/lib -maxdepth 1 -type f -name "birdbox-agent-*" | wc -l)" -eq 10
'

SMOKE_PROJECT=${RELEASE_SMOKE_PROJECT:-}
if [[ -z "$SMOKE_PROJECT" ]]; then
  version_suffix=$(printf '%s' "$VERSION" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')
  SMOKE_PROJECT="birdbox-release-smoke-${version_suffix}-$$"
fi
[[ "$SMOKE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "invalid smoke Compose project: $SMOKE_PROJECT"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
ENV_FILE="$ROOT_DIR/.env.example"
SMOKE_MYSQL_VOLUME="${SMOKE_PROJECT}_birdbox_mysql"
SMOKE_DATA_VOLUME="${SMOKE_PROJECT}_birdbox_data"
SMOKE_TMP=''
SMOKE_CLEANUP=0
SMOKE_PASSWORD=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')
SMOKE_ROOT_PASSWORD=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')
SMOKE_ENV=(
  "BIRDBOX_IMAGE_TAG=$VERSION"
  'MYSQL_DATABASE=birdbox'
  'MYSQL_USER=birdbox'
  "MYSQL_PASSWORD=$SMOKE_PASSWORD"
  "MYSQL_ROOT_PASSWORD=$SMOKE_ROOT_PASSWORD"
  'BIRDBOX_BIND_ADDRESS=127.0.0.1'
  "BIRDBOX_PORT=$SMOKE_PORT"
  "BIRDBOX_PUBLIC_URL=http://127.0.0.1:$SMOKE_PORT"
  'BIRDBOX_SECURE_COOKIE=false'
)

compose() {
  env "${SMOKE_ENV[@]}" docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" --project-name "$SMOKE_PROJECT" "$@"
}

cleanup() {
  status=$?
  set +e
  if ((SMOKE_CLEANUP)); then
    compose down --volumes --remove-orphans >/dev/null 2>&1
    docker volume rm "$SMOKE_MYSQL_VOLUME" "$SMOKE_DATA_VOLUME" >/dev/null 2>&1
  fi
  if [[ -n "$SMOKE_TMP" ]]; then
    rm -rf -- "$SMOKE_TMP"
  fi
  exit "$status"
}
trap cleanup EXIT

wait_for_healthy() {
  service=$1
  for ((attempt = 1; attempt <= 10#$SMOKE_TIMEOUT; attempt++)); do
    container_id=$(compose ps -q "$service" 2>/dev/null || true)
    if [[ -n "$container_id" ]]; then
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id" 2>/dev/null || true)
      if [[ "$health" == healthy ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  compose ps >&2 || true
  die "Compose service did not become healthy: $service"
}

if ((SKIP_SMOKE == 0)); then
  existing_containers=$(compose ps -aq 2>/dev/null || true)
  [[ -z "$existing_containers" ]] || die "smoke Compose project already has containers: $SMOKE_PROJECT"
  if docker volume inspect "$SMOKE_MYSQL_VOLUME" >/dev/null 2>&1 || docker volume inspect "$SMOKE_DATA_VOLUME" >/dev/null 2>&1; then
    die "smoke volume already exists for project $SMOKE_PROJECT; choose another RELEASE_SMOKE_PROJECT"
  fi
  SMOKE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/birdbox-release.XXXXXX")
  SMOKE_CLEANUP=1
  note "starting isolated smoke project $SMOKE_PROJECT on 127.0.0.1:$SMOKE_PORT"
  run docker volume create "$SMOKE_MYSQL_VOLUME" >/dev/null
  run docker volume create "$SMOKE_DATA_VOLUME" >/dev/null
  run docker run --rm --user 0:0 --volume "$SMOKE_DATA_VOLUME:/var/lib/birdbox" --entrypoint /bin/sh "$VERSION_IMAGE" -c 'chown -R 10001:10001 /var/lib/birdbox && chmod 0750 /var/lib/birdbox'
  compose up -d
  wait_for_healthy db
  wait_for_healthy birdbox
  compose ps

  base_url="http://127.0.0.1:$SMOKE_PORT"
  health_response=$(curl -fsS --retry 30 --retry-all-errors --retry-delay 1 "$base_url/api/health")
  node -e 'const value = JSON.parse(process.argv[1]); if (value.status !== "ok") process.exit(1)' "$health_response"
  auth_response=$(curl -fsS --retry 10 --retry-all-errors --retry-delay 1 "$base_url/api/auth/status")
  node -e 'const value = JSON.parse(process.argv[1]); if (typeof value.authenticated !== "boolean") process.exit(1)' "$auth_response"

  for arch in amd64 arm64 arm armv6 armv5 mips mipsle mips64 mips64le riscv64; do
    binary_file="$SMOKE_TMP/birdbox-agent-$arch"
    download_url="$base_url/api/agent/releases/latest/download?arch=$arch"
    checksum_url="$base_url/api/agent/releases/latest/checksum?arch=$arch"
    curl -fsS --retry 10 --retry-all-errors --retry-delay 1 -o "$binary_file" "$download_url"
    expected_checksum=$(curl -fsS --retry 10 --retry-all-errors --retry-delay 1 "$checksum_url" | tr -d '[:space:]')
    actual_checksum=$(sha256sum "$binary_file" | awk '{print $1}')
    [[ "$expected_checksum" =~ ^[0-9a-fA-F]{64}$ ]] || die "invalid checksum response for Agent $arch"
    [[ "$expected_checksum" == "$actual_checksum" ]] || die "Agent checksum mismatch for $arch"
  done
  note 'local health, auth, Agent inventory, download, and checksum checks passed'
else
  note 'Compose smoke test skipped'
fi

run docker buildx build \
  --builder "$BUILDER" \
  --platform linux/amd64,linux/arm64 \
  --build-arg "BIRDBOX_VERSION=$VERSION" \
  --build-arg "VCS_REF=$VCS_REF" \
  --build-arg "BUILD_DATE=$BUILD_DATE" \
  --tag "$VERSION_IMAGE" \
  --provenance=mode=max \
  --sbom=true \
  --push \
  .

run docker buildx imagetools create --tag "$LATEST_IMAGE" "$VERSION_IMAGE"
version_inspect=$(docker buildx imagetools inspect "$VERSION_IMAGE")
latest_inspect=$(docker buildx imagetools inspect "$LATEST_IMAGE")
version_digest=$(awk '$1 == "Digest:" { print $2; exit }' <<<"$version_inspect")
latest_digest=$(awk '$1 == "Digest:" { print $2; exit }' <<<"$latest_inspect")
[[ -n "$version_digest" && "$version_digest" == "$latest_digest" ]] || die 'latest digest does not match the version manifest'
for platform in linux/amd64 linux/arm64; do
  grep -Fq "$platform" <<<"$version_inspect" || die "published manifest is missing platform $platform"
done

note "published $VERSION_IMAGE and updated $LATEST_IMAGE"
note "manifest digest=$version_digest"
