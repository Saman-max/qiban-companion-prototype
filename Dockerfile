FROM node:24.18.0-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 DATABASE_PATH=/app/data/qiban.sqlite
WORKDIR /app
COPY --chown=node:node package.json index.html app.js cloud.js pets.js style.css ./
COPY --chown=node:node assets ./assets
COPY --chown=node:node server ./server
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4173
CMD ["node", "server/index.mjs"]
