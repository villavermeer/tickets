-- DropForeignKey
ALTER TABLE "codes" DROP CONSTRAINT "codes_raffleID_fkey";

-- DropForeignKey
ALTER TABLE "codes" DROP CONSTRAINT "codes_ticketID_fkey";

-- AlterTable
ALTER TABLE "codes" ALTER COLUMN "ticketID" DROP NOT NULL,
ALTER COLUMN "raffleID" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "codes" ADD CONSTRAINT "codes_ticketID_fkey" FOREIGN KEY ("ticketID") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codes" ADD CONSTRAINT "codes_raffleID_fkey" FOREIGN KEY ("raffleID") REFERENCES "raffles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
