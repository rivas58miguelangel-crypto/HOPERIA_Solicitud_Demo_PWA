FROM node:22-alpine

WORKDIR /app

COPY index.html manifest.webmanifest sw.js icon.svg README.txt server.mjs email-confirmacion.html ./
COPY email-assets ./email-assets

RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV PORT=4173

EXPOSE 4173

CMD ["node", "server.mjs"]
