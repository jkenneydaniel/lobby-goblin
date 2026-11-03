ARG BASE_IMAGE=ghcr.io/jkenneydaniel/lobby-goblin-steamcmd@sha256:5787b7de944e2646d84ca9788a6d10572cb811dd04dd1f89f55d9da0d293919a
FROM $BASE_IMAGE
USER 0:0
COPY runtime/ /opt/lobby/
RUN mkdir -p /software /control /request /result \
 && chown 1000:1000 /software /control /request /result \
 && chmod 700 /software /control /request /result
LABEL org.opencontainers.image.title="Lobby Goblin Steam software preparation worker" \
 org.opencontainers.image.source="https://github.com/jkenneydaniel/lobby-goblin" \
 org.opencontainers.image.licenses="MIT" \
 io.lobby-goblin.provider="steamcmd-worker" io.lobby-goblin.compatibility="1" io.lobby-goblin.image-revision="2"
USER 1000:1000
WORKDIR /home/node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/opt/lobby/panel/providers/steamcmd/worker.js"]
CMD []
