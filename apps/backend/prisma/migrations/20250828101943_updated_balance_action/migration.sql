/*
  Warnings:

  - The values [COMMISSION_EARNED,REFUND,ADJUSTMENT] on the enum `BalanceActionType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `description` on the `balance_actions` table. All the data in the column will be lost.
  - You are about to drop the column `metadata` on the `balance_actions` table. All the data in the column will be lost.
  - You are about to drop the column `processedAt` on the `balance_actions` table. All the data in the column will be lost.
  - You are about to drop the column `processedBy` on the `balance_actions` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `balance_actions` table. All the data in the column will be lost.
  - You are about to drop the column `totalEarned` on the `balances` table. All the data in the column will be lost.
  - You are about to drop the column `totalPaidOut` on the `balances` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "BalanceActionType_new" AS ENUM ('PAYOUT', 'CORRECTION', 'TICKET_SALE');
ALTER TABLE "balance_actions" ALTER COLUMN "type" TYPE "BalanceActionType_new" USING ("type"::text::"BalanceActionType_new");
ALTER TYPE "BalanceActionType" RENAME TO "BalanceActionType_old";
ALTER TYPE "BalanceActionType_new" RENAME TO "BalanceActionType";
DROP TYPE "BalanceActionType_old";
COMMIT;

-- DropIndex
DROP INDEX "balance_actions_status_idx";

-- AlterTable
ALTER TABLE "balance_actions" DROP COLUMN "description",
DROP COLUMN "metadata",
DROP COLUMN "processedAt",
DROP COLUMN "processedBy",
DROP COLUMN "status";

-- AlterTable
ALTER TABLE "balances" DROP COLUMN "totalEarned",
DROP COLUMN "totalPaidOut";

-- DropEnum
DROP TYPE "BalanceActionStatus";
