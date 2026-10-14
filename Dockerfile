FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/app.db
# Mount a persistent volume at /data or your database is wiped on every deploy.
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
