FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p data uploads/backgrounds

EXPOSE 3000

CMD ["npm", "start"]