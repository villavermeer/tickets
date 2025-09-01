/*
  Warnings:

  - You are about to drop the column `relayedAt` on the `codes` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "codes" DROP COLUMN "relayedAt",
ADD COLUMN     "relayed" TIMESTAMP(3);
