-- CreateTable
CREATE TABLE "frozen_balances" (
    "id" SERIAL NOT NULL,
    "userID" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "balance" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "frozen_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "frozen_balances_userID_idx" ON "frozen_balances"("userID");

-- CreateIndex
CREATE INDEX "frozen_balances_date_idx" ON "frozen_balances"("date");

-- CreateIndex
CREATE UNIQUE INDEX "frozen_balances_userID_date_key" ON "frozen_balances"("userID", "date");

-- AddForeignKey
ALTER TABLE "frozen_balances" ADD CONSTRAINT "frozen_balances_userID_fkey" FOREIGN KEY ("userID") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
