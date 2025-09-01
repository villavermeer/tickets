-- AlterTable
ALTER TABLE "codes" ADD COLUMN     "relayBatchID" INTEGER,
ADD COLUMN     "relayedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "relay_batches" (
    "id" SERIAL NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relay_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "relay_batches_id_idx" ON "relay_batches"("id");

-- AddForeignKey
ALTER TABLE "codes" ADD CONSTRAINT "codes_relayBatchID_fkey" FOREIGN KEY ("relayBatchID") REFERENCES "relay_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
