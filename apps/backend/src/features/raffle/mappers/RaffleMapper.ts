import { Raffle, Prisma } from "@prisma/client";
import { RaffleInterface } from "@tickets/types/dist/raffle";
import { CodeMapper } from "../../code/mappers/CodeMapper";
import { TicketMapper } from "../../ticket/mappers/TicketMapper";
import { GameMapper } from "../../game/mappers/GameMapper";
import { container } from "tsyringe";
import { IRevenueService } from "../../revenue/services/RevenueService";

export class RaffleMapper {

    public static getSelectableFields(): Prisma.RaffleSelect {
        return {
            id: true,
            game: {
                select: GameMapper.getSelectableFields()
            },
            created: true,
            codes: {
                select: CodeMapper.getSelectableFields()
            },
        };
    }

    public static async format(raffle: any): Promise<RaffleInterface> {
        const revenueService = container.resolve<IRevenueService>("RevenueService")

        return {
            id: raffle.id,
            game: GameMapper.format(raffle.game),
            codes: raffle.codes ? raffle.codes.map(CodeMapper.format) : [],
            created: raffle.created,
            revenue: await revenueService.getRevenueByRaffle(raffle.id)
        };
    }

    public static async formatMany(raffles: Raffle[]): Promise<RaffleInterface[]> {
        return Promise.all(raffles.map(raffle => this.format(raffle)));
    }
}