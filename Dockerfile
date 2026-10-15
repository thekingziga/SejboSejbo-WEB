FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Upload screening (lib/moderation.js) samples frames from videos and GIFs
# before a post is published, so the app needs ffmpeg as well as the
# worker. It roughly doubles the image; the alternative was letting videos
# go live unchecked until the worker got to them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public
# Maintenance scripts run with `docker compose exec` - notably the
# uploads-to-S3 migration. Without this they aren't in the image and the
# migration can't be run against the live data.
COPY scripts ./scripts

RUN mkdir -p /app/data /app/uploads \
  && chown -R node:node /app

USER node

EXPOSE 3000
VOLUME ["/app/data", "/app/uploads"]

# Reads PORT rather than hardcoding 3000: server.js honours PORT, so a
# deployment that sets it was silently reporting "unhealthy" forever while
# the app was fine - the check was hitting a port nothing listened on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
