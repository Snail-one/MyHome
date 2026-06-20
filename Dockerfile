FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev

COPY --chown=node:node . .

RUN mkdir -p data uploads/backgrounds && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["npm", "start"]
