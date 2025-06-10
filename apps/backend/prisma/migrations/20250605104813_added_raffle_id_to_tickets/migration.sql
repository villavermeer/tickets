-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "raffleID" INTEGER;

-- CreateIndex
CREATE INDEX "tickets_raffleID_idx" ON "tickets"("raffleID");

-- CreateIndex
CREATE INDEX "tickets_runnerID_idx" ON "tickets"("runnerID");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_raffleID_fkey" FOREIGN KEY ("raffleID") REFERENCES "raffles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
