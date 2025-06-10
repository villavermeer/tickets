-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'CLIENT', 'RUNNER', 'MANAGER');

-- CreateEnum
CREATE TYPE "GameExpiry" AS ENUM ('MIDDAY', 'MIDNIGHT', 'CUSTOM');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'CLIENT',
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,
    "commission" DOUBLE PRECISION NOT NULL DEFAULT 0.0,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" SERIAL NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_codes" (
    "id" SERIAL NOT NULL,
    "code" INTEGER NOT NULL,
    "ticketID" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "expires" "GameExpiry" NOT NULL DEFAULT 'MIDDAY',
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffles" (
    "id" SERIAL NOT NULL,
    "long" INTEGER NOT NULL,
    "medium" INTEGER NOT NULL,
    "short" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "raffles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_id_idx" ON "users"("id");

-- CreateIndex
CREATE INDEX "tickets_id_idx" ON "tickets"("id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_codes_code_key" ON "ticket_codes"("code");

-- CreateIndex
CREATE INDEX "ticket_codes_id_idx" ON "ticket_codes"("id");

-- CreateIndex
CREATE INDEX "games_id_idx" ON "games"("id");

-- CreateIndex
CREATE INDEX "raffles_id_idx" ON "raffles"("id");

-- AddForeignKey
ALTER TABLE "ticket_codes" ADD CONSTRAINT "ticket_codes_ticketID_fkey" FOREIGN KEY ("ticketID") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
