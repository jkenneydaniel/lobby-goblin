ARG BASE_IMAGE=debian:bookworm-slim@sha256:a4672c0cb26fbdde88e38fa2dfb6c681942306680e41e4378b28770b6e79ee91
FROM ${BASE_IMAGE}
ARG TARGETARCH
ARG IMAGE_REVISION=1
LABEL org.opencontainers.image.title="Lobby Goblin Factorio runtime" \
      org.opencontainers.image.source="https://github.com/jkenneydaniel/lobby-goblin" \
      org.opencontainers.image.version="runtime-fc.${IMAGE_REVISION}" \
      io.lobby-goblin.compatibility="1" \
      io.lobby-goblin.software-delivery="runtime" \
      io.lobby-goblin.image-revision="${IMAGE_REVISION}"
RUN test "$TARGETARCH" = amd64 && apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates python3 passwd libstdc++6 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -g 845 factorio && useradd -u 845 -g 845 -d /factorio -s /usr/sbin/nologin factorio && \
    mkdir -p /factorio /opt/factorio /usr/local/lib/lobby-goblin && chown 845:845 /factorio
COPY entrypoint.py runtime.py /usr/local/lib/lobby-goblin/
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY rcon.py /usr/local/bin/rcon
COPY LICENSE /usr/local/share/doc/lobby-goblin/LICENSE
RUN chmod 755 /docker-entrypoint.sh /usr/local/bin/rcon
ENV FACTORIO_RUNTIME=true FACTORIO_VERSION=stable \
    PORT=34197 RCON_PORT=27015 SAVES=/factorio/saves CONFIG=/factorio/config \
    MODS=/factorio/mods SCENARIOS=/factorio/scenarios SCRIPTOUTPUT=/factorio/script-output \
    PUID=845 PGID=845 DLC_SPACE_AGE=true LOAD_LATEST_SAVE=true \
    GENERATE_NEW_SAVE=false UPDATE_MODS_ON_START=false
VOLUME /factorio
EXPOSE 34197/udp 27015/tcp
STOPSIGNAL SIGTERM
ENTRYPOINT ["/docker-entrypoint.sh"]
