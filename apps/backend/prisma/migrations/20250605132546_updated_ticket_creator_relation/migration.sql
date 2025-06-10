/*
  Warnings:

  - You are about to drop the column `runnerID` on the `tickets` table. All the data in the column will be lost.
  - Added the required column `creatorID` to the `tickets` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_runnerID_fkey";

-- DropIndex
DROP INDEX "tickets_runnerID_idx";

-- AlterTable
ALTER TABLE "tickets" DROP COLUMN "runnerID",
ADD COLUMN     "creatorID" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "tickets_creatorID_idx" ON "tickets"("creatorID");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_creatorID_fkey" FOREIGN KEY ("creatorID") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
