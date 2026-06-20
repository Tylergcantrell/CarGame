FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build:server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server ./server
EXPOSE 8787
CMD ["node", "server/game-server.mjs"]
