ARG BASE_IMAGE=node:24.22.0-bookworm-slim@sha256:ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7
FROM ${BASE_IMAGE}
WORKDIR /app
COPY server.mjs ./server.mjs
USER 1000:0
LABEL org.opencontainers.image.title="Lobby Goblin Status Page" io.lobby-goblin.compatibility="1" io.lobby-goblin.application="status-page" io.lobby-goblin.image-revision="1"
EXPOSE 8080/tcp
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
