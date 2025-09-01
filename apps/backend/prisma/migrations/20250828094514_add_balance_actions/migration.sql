-- CreateEnum
CREATE TYPE "BalanceActionType" AS ENUM ('PAYOUT', 'CORRECTION', 'COMMISSION_EARNED', 'TICKET_SALE', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "BalanceActionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "balances" (
    "id" SERIAL NOT NULL,
    "userID" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "totalEarned" INTEGER NOT NULL DEFAULT 0,
    "totalPaidOut" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_actions" (
    "id" SERIAL NOT NULL,
    "balanceID" INTEGER NOT NULL,
    "type" "BalanceActionType" NOT NULL,
    "status" "BalanceActionStatus" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "description" TEXT,
    "reference" TEXT,
    "processedBy" INTEGER,
    "processedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "balance_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "balances_userID_key" ON "balances"("userID");

-- CreateIndex
CREATE INDEX "balances_id_idx" ON "balances"("id");

-- CreateIndex
CREATE INDEX "balances_userID_idx" ON "balances"("userID");

-- CreateIndex
CREATE INDEX "balance_actions_id_idx" ON "balance_actions"("id");

-- CreateIndex
CREATE INDEX "balance_actions_balanceID_idx" ON "balance_actions"("balanceID");

-- CreateIndex
CREATE INDEX "balance_actions_type_idx" ON "balance_actions"("type");

-- CreateIndex
CREATE INDEX "balance_actions_status_idx" ON "balance_actions"("status");

-- CreateIndex
CREATE INDEX "balance_actions_created_idx" ON "balance_actions"("created");

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_userID_fkey" FOREIGN KEY ("userID") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_actions" ADD CONSTRAINT "balance_actions_balanceID_fkey" FOREIGN KEY ("balanceID") REFERENCES "balances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
