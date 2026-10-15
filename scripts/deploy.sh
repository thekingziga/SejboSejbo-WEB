#!/usr/bin/env bash
#
# Build, publish and deploy in one step.
# Runs on the target docker host.
#
#   ./deploy.sh            # version from package.json
#   ./deploy.sh 1.44.2     # explicit
#   ./deploy.sh --no-push  # local only, for a throwaway test build
# everything else. Push first, deploy second: an image that only exists on
# the machine it runs on is not a rollback plan.
#
#   ./deploy.sh            # version from package.json
#   ./deploy.sh 1.31.0     # explicit
#   ./deploy.sh --no-push  # local only, for a throwaway test build
set -euo pipefail

SRC="${SRC:-/opt/sejbosejbo-src}"
STACK="${STACK:-/opt/sejbosejbo}"
REPO="${REPO:-thekingziga/sejbosejbo}"
PUSH=true
VERSION=""
# Pushes run as whoever holds the Docker Hub login on this host.
PUSH_USER="${PUSH_USER:-ldocker}"
DOCKER_PUSH="docker"
if [ "$(id -un)" != "$PUSH_USER" ]; then
  DOCKER_PUSH="sudo -u $PUSH_USER -H docker"
fi

for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=false ;;
    *) VERSION="$arg" ;;
  esac
done

[ -z "$VERSION" ] && VERSION=$(node -p "require('$SRC/package.json').version")
echo "==> version $VERSION"

# Refuse to overwrite a published tag by accident: a tag that already
# exists on the hub with different content makes "roll back to X"
# meaningless.
if [ "$PUSH" = true ] && docker manifest inspect "$REPO:$VERSION" >/dev/null 2>&1; then
  echo "!! $REPO:$VERSION already exists on Docker Hub."
  echo "   Bump the version in package.json, or pass --no-push for a local build."
  exit 1
fi

echo "==> building"
docker build -q -t "$REPO:$VERSION" -t "$REPO:latest" "$SRC"

if [ "$PUSH" = true ]; then
  echo "==> pushing to Docker Hub"
  # Hub credentials on this host belong to the ldocker user, not root:
  # pushing as root fails with "requested access to the resource is denied"
  # and an empty auths map.
  $DOCKER_PUSH push -q "$REPO:$VERSION"
  $DOCKER_PUSH push -q "$REPO:latest"
  docker manifest inspect "$REPO:$VERSION" >/dev/null 2>&1 \
    || { echo "!! push did not land - refusing to deploy an unpublished image"; exit 1; }
  echo "   published $REPO:$VERSION"
fi

echo "==> deploying"
sed -i "s|image: $REPO:.*|image: $REPO:$VERSION|" "$STACK/docker-compose.yml"
(cd "$STACK" && docker compose up -d)

sleep 12
LIVE=$(curl -s --max-time 10 http://127.0.0.1:3040/health || true)
echo "==> health: ${LIVE:-no response}"
case "$LIVE" in
  *"\"version\":\"$VERSION\""*) echo "==> $VERSION is live" ;;
  *) echo "!! health did not report $VERSION - check: docker logs sejbosejbo"; exit 1 ;;
esac
