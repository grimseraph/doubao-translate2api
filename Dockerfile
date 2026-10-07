FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/build-ui.mjs scripts/build-plugin.mjs ./scripts/
COPY LICENSE ./LICENSE
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000 ADMIN_DATA_DIR=/admin-data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ARG APP_UID=1000
ARG APP_GID=1000
RUN test "$APP_UID" -gt 0 && mkdir -p /data /admin-data && chown "${APP_UID}:${APP_GID}" /admin-data
USER ${APP_UID}:${APP_GID}
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
