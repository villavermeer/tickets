-- DropForeignKey
ALTER TABLE "codes" DROP CONSTRAINT "codes_raffleID_fkey";

-- DropForeignKey
ALTER TABLE "codes" DROP CONSTRAINT "codes_ticketID_fkey";

-- DropForeignKey
ALTER TABLE "manager_runners" DROP CONSTRAINT "manager_runners_managerID_fkey";

-- DropForeignKey
ALTER TABLE "manager_runners" DROP CONSTRAINT "manager_runners_runnerID_fkey";

-- DropForeignKey
ALTER TABLE "raffles" DROP CONSTRAINT "raffles_gameID_fkey";

-- DropForeignKey
ALTER TABLE "ticket_games" DROP CONSTRAINT "ticket_games_gameID_fkey";

-- DropForeignKey
ALTER TABLE "ticket_games" DROP CONSTRAINT "ticket_games_ticketID_fkey";

-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_creatorID_fkey";

-- AddForeignKey
ALTER TABLE "manager_runners" ADD CONSTRAINT "manager_runners_managerID_fkey" FOREIGN KEY ("managerID") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_runners" ADD CONSTRAINT "manager_runners_runnerID_fkey" FOREIGN KEY ("runnerID") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_creatorID_fkey" FOREIGN KEY ("creatorID") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codes" ADD CONSTRAINT "codes_ticketID_fkey" FOREIGN KEY ("ticketID") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codes" ADD CONSTRAINT "codes_raffleID_fkey" FOREIGN KEY ("raffleID") REFERENCES "raffles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_games" ADD CONSTRAINT "ticket_games_ticketID_fkey" FOREIGN KEY ("ticketID") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_games" ADD CONSTRAINT "ticket_games_gameID_fkey" FOREIGN KEY ("gameID") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffles" ADD CONSTRAINT "raffles_gameID_fkey" FOREIGN KEY ("gameID") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
