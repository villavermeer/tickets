/*
  Warnings:

  - You are about to drop the column `long` on the `raffles` table. All the data in the column will be lost.
  - You are about to drop the column `medium` on the `raffles` table. All the data in the column will be lost.
  - You are about to drop the column `short` on the `raffles` table. All the data in the column will be lost.
  - Added the required column `raffleID` to the `codes` table without a default value. This is not possible if the table is not empty.
  - Added the required column `gameID` to the `raffles` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "codes" ADD COLUMN     "raffleID" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "raffles" DROP COLUMN "long",
DROP COLUMN "medium",
DROP COLUMN "short",
ADD COLUMN     "gameID" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "codes_ticketID_idx" ON "codes"("ticketID");

-- CreateIndex
CREATE INDEX "codes_raffleID_idx" ON "codes"("raffleID");

-- CreateIndex
CREATE INDEX "raffles_gameID_idx" ON "raffles"("gameID");

-- AddForeignKey
ALTER TABLE "codes" ADD CONSTRAINT "codes_raffleID_fkey" FOREIGN KEY ("raffleID") REFERENCES "raffles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffles" ADD CONSTRAINT "raffles_gameID_fkey" FOREIGN KEY ("gameID") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
