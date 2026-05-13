FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/types/package.json ./packages/types/

RUN corepack enable && yarn install --frozen-lockfile

COPY apps/backend ./apps/backend
COPY packages/types ./packages/types

WORKDIR /app
RUN yarn workspace @tickets/types build

WORKDIR /app
RUN yarn workspace backend exec prisma generate
RUN yarn workspace backend run build

WORKDIR /app/apps/backend
EXPOSE 8080

CMD ["sh", "-c", "npx prisma migrate deploy && node -r tsconfig-paths/register dist/index.js"]
