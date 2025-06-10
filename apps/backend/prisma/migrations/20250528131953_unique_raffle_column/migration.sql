/*
  Warnings:

  - A unique constraint covering the columns `[created]` on the table `raffles` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "raffles_created_key" ON "raffles"("created");
