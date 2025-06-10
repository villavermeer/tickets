import { Game, Prisma } from "@prisma/client";
import { GameInterface } from "../types";

export class GameMapper {

    public static getSelectableFields(): Prisma.GameSelect {
        return {
            id: true,
            name: true,
            expires: true
        };
    }

    public static format(game: Game): GameInterface {
        return {
            id: game.id,
            name: game.name,
            expires: game.expires
        };
    }

    public static formatMany(games: Game[]): GameInterface[] {
        return games.map(game => this.format(game));
    }
}
