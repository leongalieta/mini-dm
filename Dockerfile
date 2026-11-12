FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV PORT=3777
ENV HOST=0.0.0.0
ENV MINI_DM_NO_OPEN=1

EXPOSE 3777

CMD ["node", "server.js"]
