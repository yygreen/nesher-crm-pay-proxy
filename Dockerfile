FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY mercury.js inject.js db.js auth.js quote.js http.js whatsapp-ui.js server.js ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
