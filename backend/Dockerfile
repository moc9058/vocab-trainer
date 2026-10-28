FROM node:24-alpine AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY backend/DB ./DB
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
EXPOSE 3000
CMD ["node", "dist/index.js"]
