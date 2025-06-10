import { Prisma, Ticket } from "@prisma/client";
import { UserMapper } from "../../user/mappers/UserMapper";
import { CodeMapper } from "../../code/mappers/CodeMapper";
import { GameMapper } from "../../game/mappers/GameMapper";
import { TicketInterface, UserInterface } from "@tickets/types";

export type SelectableTicketFields = Prisma.TicketGetPayload<{
    select: ReturnType<typeof TicketMapper.getSelectableFields>
}>;

export class TicketMapper {

    public static getSelectableFields(): Prisma.TicketSelect {
        return {
            id: true,
            name: true,
            games: {
                select: {
                    game: {
                        select: GameMapper.getSelectableFields()
                    }
                }
            },
            codes: {
                select: CodeMapper.getSelectableFields()
            },
            creator: {
                select: UserMapper.getSelectableFields()
            },
            created: true,
            updated: true
        }
    }

    public static format(ticket: any): TicketInterface {
        return {
            id: ticket.id ?? 0,
            name: ticket.name ?? '',
            creator: UserMapper.format(ticket.creator) as UserInterface,
            created: ticket.created ?? new Date(),
            updated: ticket.updated ?? new Date(),
            games: ticket.games.map((game: any) => game.game),
            codes: CodeMapper.formatMany(ticket.codes ?? []),
        };
    }

    public static formatMany(tickets: Ticket[]): TicketInterface[] {
        return tickets.map(ticket => TicketMapper.format(ticket));
    }
}
