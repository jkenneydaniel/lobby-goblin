ARG BASE_IMAGE=ghcr.io/jkenneydaniel/lobby-goblin-steamcmd@sha256:acb54444388c2b0886fbb5937d0faa16a18a8cf14e28586cb62de203cd64429b
FROM $BASE_IMAGE
ARG TARGETARCH
USER 0:0
RUN test "$TARGETARCH" = amd64 \
 && apt-get update && apt-get install -y --no-install-recommends libatomic1 libcurl4 libsdl2-2.0-0 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /steamcmd/rust
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY transport.js entrypoint.mjs managed-entrypoint.mjs ./
LABEL org.opencontainers.image.title="Lobby Goblin managed Rust runtime" \
 org.opencontainers.image.source="https://github.com/jkenneydaniel/lobby-goblin" \
 org.opencontainers.image.licenses="MIT" \
 io.lobby-goblin.rust-mods="1" io.lobby-goblin.game="rust" io.lobby-goblin.compatibility="1" \
 io.lobby-goblin.software-delivery="runtime" io.lobby-goblin.software-provider="steamcmd" io.lobby-goblin.image-revision="1"
ENV HOME=/home/node RUST_SERVER_IDENTITY=lobby-goblin-rust RUST_SERVER_PORT=28015 RUST_SERVER_QUERYPORT=28017 RUST_RCON_PORT=28016
EXPOSE 28015/udp 28017/udp 28016/tcp
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=2s --timeout=3s --start-period=10m --retries=3 CMD node -e "const fs=require('node:fs');try{const v=JSON.parse(fs.readFileSync('/tmp/lobby-goblin-rust-ready.json'));if(!Number.isInteger(v.pid)||v.pid<2)process.exit(1);process.kill(v.pid,0);}catch{process.exit(1)}"
ENTRYPOINT ["node", "/app/managed-entrypoint.mjs"]
CMD []
