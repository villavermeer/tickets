-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "raffleID" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "tickets_raffleID_idx" ON "tickets"("raffleID");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_raffleID_fkey" FOREIGN KEY ("raffleID") REFERENCES "raffles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
