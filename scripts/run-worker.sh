#!/usr/bin/env bash
#
# Starts the transcode worker under enforced resource caps.
#
# Run this on the transcode host, NOT the web server. Verify the caps are
# real before trusting them: a kernel without the cgroup memory controller
# accepts --memory and silently discards it, which is how an unbounded
# ffmpeg took a Raspberry Pi down. Check with:
#
#   cat /sys/fs/cgroup/cgroup.controllers   # must list 'memory'
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/sejbosejbo-worker/worker.env}"
IMAGE="${IMAGE:-sejbosejbo-worker:local}"
NAME="${NAME:-sejbosejbo-worker}"
MEMORY="${WORKER_MEMORY:-2g}"
CPUS="${WORKER_CPUS:-2}"

if ! grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null; then
  echo "!! This kernel has no cgroup memory controller - --memory would be ignored." >&2
  echo "   Add 'cgroup_enable=memory cgroup_memory=1' to the kernel cmdline and reboot," >&2
  echo "   or run the worker somewhere else. Refusing to start unbounded." >&2
  exit 1
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --env-file "$ENV_FILE" \
  --memory "$MEMORY" --memory-swap "$MEMORY" \
  --cpus "$CPUS" \
  --pids-limit 256 \
  "$IMAGE"

# Prove the limit landed rather than assuming it did.
applied=$(docker inspect "$NAME" --format '{{.HostConfig.Memory}}')
if [ "$applied" = "0" ]; then
  echo "!! memory limit was not applied - stopping the worker" >&2
  docker rm -f "$NAME" >/dev/null 2>&1
  exit 1
fi

echo "worker started"
echo "  memory: $(awk -v b="$applied" 'BEGIN{printf "%.0f MB", b/1048576}') (swap disabled)"
echo "  cpus:   $CPUS"
echo "  logs:   docker logs -f $NAME"
