ARG BASE_IMAGE=ghcr.io/jkenneydaniel/lobby-goblin-steamcmd@sha256:acb54444388c2b0886fbb5937d0faa16a18a8cf14e28586cb62de203cd64429b
FROM $BASE_IMAGE
USER 0:0
COPY runtime/ /opt/lobby/
RUN mkdir -p /software /control /request /result \
 && chown 1000:1000 /software /control /request /result \
 && chmod 700 /software /control /request /result
LABEL org.opencontainers.image.title="Lobby Goblin Steam software preparation worker" \
 org.opencontainers.image.source="https://github.com/jkenneydaniel/lobby-goblin" \
 org.opencontainers.image.licenses="MIT" \
 io.lobby-goblin.provider="steamcmd-worker" io.lobby-goblin.compatibility="1" io.lobby-goblin.image-revision="1"
USER 1000:1000
WORKDIR /home/node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/opt/lobby/panel/providers/steamcmd/worker.js"]
CMD []
