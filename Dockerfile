FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Card reader (ocr-engine.js) uses LSTM only and the 4.0.0_best_int English
# data only. Drop the unused tesseract cores and the float model so the image
# does not carry ~35 MB it never reads. rm -f: a renamed file costs size, never a boot.
RUN rm -rf node_modules/@tesseract.js-data/eng/4.0.0 \
 && rm -f node_modules/tesseract.js-core/tesseract-core.js \
          node_modules/tesseract.js-core/tesseract-core.wasm \
          node_modules/tesseract.js-core/tesseract-core.wasm.js \
          node_modules/tesseract.js-core/tesseract-core-simd.js \
          node_modules/tesseract.js-core/tesseract-core-simd.wasm \
          node_modules/tesseract.js-core/tesseract-core-simd.wasm.js \
          node_modules/tesseract.js-core/tesseract-core-relaxedsimd.js \
          node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm \
          node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm.js
# ⚠ Explicit list — a new module MUST be added here or the container crashes
# on boot with ERR_MODULE_NOT_FOUND and the site 502s.
COPY mercury.js nmi-card.js nmi-webhook.js nmi-recovery.js invoice-page.js open-pay.js invoice-store.js inject.js strip-stripe.js db.js auth.js quote.js http.js draft.js payments-sync.js payment-posts.js whatsapp-ui.js whatsapp-media.js whatsapp-webhook.js snapengage.js public-ui.js intake-ui.js status-extra.js needs-axis.js board.js money-hop.js mercury-gateway.js money-watch.js money-map.js crm-search.js money-pay.js ocr-card.js ocr-engine.js ocr-glyphs.js ocr-glyphs.json ocr-glyph-worker.js card-charge.js server.js ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
