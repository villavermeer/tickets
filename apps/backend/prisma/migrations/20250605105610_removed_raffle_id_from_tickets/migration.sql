/*
  Warnings:

  - You are about to drop the column `raffleID` on the `tickets` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_raffleID_fkey";

-- DropIndex
DROP INDEX "tickets_raffleID_idx";

-- AlterTable
ALTER TABLE "tickets" DROP COLUMN "raffleID";
