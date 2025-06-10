-- CreateTable
CREATE TABLE "manager_runners" (
    "id" SERIAL NOT NULL,
    "managerID" INTEGER NOT NULL,
    "runnerID" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manager_runners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "manager_runners_id_idx" ON "manager_runners"("id");

-- CreateIndex
CREATE INDEX "manager_runners_managerID_idx" ON "manager_runners"("managerID");

-- CreateIndex
CREATE INDEX "manager_runners_runnerID_idx" ON "manager_runners"("runnerID");

-- AddForeignKey
ALTER TABLE "manager_runners" ADD CONSTRAINT "manager_runners_managerID_fkey" FOREIGN KEY ("managerID") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_runners" ADD CONSTRAINT "manager_runners_runnerID_fkey" FOREIGN KEY ("runnerID") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
