FROM node:24.18.0-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci

COPY . .

RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "run", "start:dev"]