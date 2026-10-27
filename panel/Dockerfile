FROM docker:29.9.0-cli AS docker-cli
FROM node:24.22.0-bookworm-slim
LABEL org.opencontainers.image.title="Lobby Goblin" org.opencontainers.image.version="0.3.12-alpha" org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/jkenneydaniel/lobby-goblin" io.lobby-goblin.runtime="1"
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
# Docker/Buildx use the OS trust store; Node's bundled roots do not cover them.
COPY --from=docker-cli /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chown=node:node *.json *.js *.lua ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node LICENSE ./LICENSE
COPY --chown=node:node public ./public
COPY --chown=node:node core ./core
COPY --chown=node:node applications ./applications
COPY --chown=node:node providers ./providers
COPY --chown=node:node fleet ./fleet
USER node
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node", "health.js"]
CMD ["node", "server.js"]
