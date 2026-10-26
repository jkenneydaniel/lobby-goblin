# Build with the repository root as context. The game is installed separately.
ARG BASE_IMAGE=node:24.22.0-bookworm-slim@sha256:ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7
FROM ${BASE_IMAGE}
ARG TARGETARCH
ARG STEAMCMD_SHA256=cebf0046bfd08cf45da6bc094ae47aa39ebf4155e5ede41373b579b8f1071e7c
RUN test "$TARGETARCH" = amd64 \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl lib32gcc-s1 lib32stdc++6 lib32z1 libatomic1 libcurl4 libsdl2-2.0-0 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/steamcmd /home/node/.steam/sdk64 /steamcmd/rust \
 && curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz -o /tmp/steamcmd.tar.gz \
 && echo "$STEAMCMD_SHA256  /tmp/steamcmd.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/steamcmd.tar.gz -C /opt/steamcmd && rm /tmp/steamcmd.tar.gz \
 && chown -R node:node /opt/steamcmd /home/node/.steam /steamcmd/rust
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY transport.js ./transport.js
COPY entrypoint.mjs ./entrypoint.mjs
LABEL org.opencontainers.image.title="Lobby Goblin Rust server" \
 org.opencontainers.image.source="https://github.com/jkenneydaniel/lobby-goblin" \
 org.opencontainers.image.licenses="MIT" \
 io.lobby-goblin.rust-mods="1" io.lobby-goblin.game="rust" io.lobby-goblin.compatibility="1" io.lobby-goblin.image-revision="3"
ENV HOME=/home/node RUST_SERVER_IDENTITY=lobby-goblin-rust RUST_SERVER_PORT=28015 RUST_SERVER_QUERYPORT=28017 RUST_RCON_PORT=28016
EXPOSE 28015/udp 28017/udp 28016/tcp
STOPSIGNAL SIGTERM
# This proof is published only after the game reports completed world startup.
HEALTHCHECK --interval=2s --timeout=3s --start-period=10m --retries=3 CMD node -e "const fs=require('node:fs');try{const v=JSON.parse(fs.readFileSync('/tmp/lobby-goblin-rust-ready.json'));if(!Number.isInteger(v.pid)||v.pid<2)process.exit(1);process.kill(v.pid,0);}catch{process.exit(1)}"
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
