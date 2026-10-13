FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib ./lib
COPY worker ./worker
COPY tsconfig.json ./
ENV NODE_ENV=production
CMD ["npm","run","worker"]
