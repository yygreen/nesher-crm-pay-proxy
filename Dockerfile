FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# ⚠ Explicit list — a new module MUST be added here or the container crashes
# on boot with ERR_MODULE_NOT_FOUND and the site 502s.
COPY mercury.js invoice-page.js invoice-store.js inject.js db.js auth.js quote.js http.js draft.js payments-sync.js whatsapp-ui.js whatsapp-media.js whatsapp-webhook.js snapengage.js public-ui.js intake-ui.js status-extra.js board.js server.js ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
