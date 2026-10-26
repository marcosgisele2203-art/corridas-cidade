FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=America/Campo_Grande
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
USER node
CMD ["node", "server.js"]
