ARG BASE_IMAGE=node:24.22.0-bookworm-slim@sha256:ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7
FROM $BASE_IMAGE
ARG TARGETARCH
ARG STEAMCMD_SHA256
RUN test "$TARGETARCH" = amd64 \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl lib32gcc-s1 lib32stdc++6 lib32z1 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/steamcmd /home/node/.steam/sdk64 \
 && curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz -o /tmp/steamcmd.tar.gz \
 && echo "$STEAMCMD_SHA256  /tmp/steamcmd.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/steamcmd.tar.gz -C /opt/steamcmd \
 && rm /tmp/steamcmd.tar.gz \
 && chown -R node:node /opt/steamcmd /home/node/.steam
LABEL org.opencontainers.image.title="Lobby Goblin SteamCMD runtime" \
 org.opencontainers.image.source="https://github.com/jkenneydaniel/lobby-goblin" \
 org.opencontainers.image.licenses="MIT" \
 io.lobby-goblin.provider="steamcmd" io.lobby-goblin.compatibility="1" io.lobby-goblin.image-revision="1"
ENV HOME=/home/node
USER 1000:1000
WORKDIR /home/node
ENTRYPOINT ["/opt/steamcmd/steamcmd.sh"]
CMD ["+quit"]
