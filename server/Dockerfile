FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
USER node
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1
CMD ["node", "server.js"]
