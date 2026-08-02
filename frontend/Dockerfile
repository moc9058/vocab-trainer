FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src src
RUN npm run build

FROM nginx:alpine AS runtime
COPY nginx.conf.template /tmp/nginx.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
ENV BACKEND_URL=http://localhost:3000
# Public DNS resolves the Cloud Run *.run.app backend URL; docker-compose
# overrides this with Docker's embedded DNS (127.0.0.11) so the `backend`
# service name resolves locally.
ENV DNS_RESOLVER=8.8.8.8
EXPOSE 5173
CMD ["sh", "-c", "envsubst '$BACKEND_URL $DNS_RESOLVER' < /tmp/nginx.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
