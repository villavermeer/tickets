/*
  Warnings:

  - Added the required column `value` to the `codes` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `tickets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `runnerID` to the `tickets` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "codes" ADD COLUMN     "value" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "runnerID" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "ticket_games" (
    "id" SERIAL NOT NULL,
    "ticketID" INTEGER NOT NULL,
    "gameID" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_games_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_games_id_idx" ON "ticket_games"("id");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_runnerID_fkey" FOREIGN KEY ("runnerID") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_games" ADD CONSTRAINT "ticket_games_ticketID_fkey" FOREIGN KEY ("ticketID") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_games" ADD CONSTRAINT "ticket_games_gameID_fkey" FOREIGN KEY ("gameID") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
