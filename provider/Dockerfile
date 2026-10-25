FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src/crypto.ts src/feed.ts ./src/
COPY provider/provider.ts provider/server.ts ./provider/
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=80
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "provider/server.ts"]
