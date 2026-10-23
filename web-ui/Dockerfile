FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine
RUN apk add --no-cache curl
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY register.sh /register.sh
COPY 40-consul-register.sh /docker-entrypoint.d/40-consul-register.sh
RUN chmod +x /register.sh /docker-entrypoint.d/40-consul-register.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
