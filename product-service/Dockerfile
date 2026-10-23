FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY proto ./proto
COPY src ./src
USER node
EXPOSE 3001 50051
CMD ["node", "src/server.js"]
