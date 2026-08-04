FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY mercury.js inject.js db.js auth.js quote.js http.js draft.js whatsapp-ui.js whatsapp-media.js server.js ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
