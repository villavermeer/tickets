/*
  Warnings:

  - You are about to drop the `ticket_codes` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ticket_codes" DROP CONSTRAINT "ticket_codes_ticketID_fkey";

-- DropTable
DROP TABLE "ticket_codes";

-- CreateTable
CREATE TABLE "codes" (
    "id" SERIAL NOT NULL,
    "code" INTEGER NOT NULL,
    "ticketID" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "codes_code_key" ON "codes"("code");

-- CreateIndex
CREATE INDEX "codes_id_idx" ON "codes"("id");

-- AddForeignKey
ALTER TABLE "codes" ADD CONSTRAINT "codes_ticketID_fkey" FOREIGN KEY ("ticketID") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
