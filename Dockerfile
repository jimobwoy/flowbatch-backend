FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/app.db
# Your database lives in /data. On Railway, attach a Volume mounted at /data.
# On your own server: docker run -v flowbatch-data:/data ...
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
