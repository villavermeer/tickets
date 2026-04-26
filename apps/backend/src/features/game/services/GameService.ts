import { Game } from "@prisma/client";
import Service, { IServiceInterface } from "../../../common/services/Service";
import { injectable } from "tsyringe";
import { GameInterface } from "../types";
import { GameMapper } from "../mappers/GameMapper";
import { CreateGameRequest } from "../types/requests";
import { DateTime } from "luxon";
import { isGameUnavailableForDate } from "../utils/gameAvailability";

export interface IGameService extends IServiceInterface {
    all(): Promise<GameInterface[]>;
    link(ticketID: number, games: number[]): Promise<void>;
}

@injectable()
export class GameService extends Service implements IGameService {
    public all = async (): Promise<GameInterface[]> => {
        const nowAmsterdam = DateTime.now().setZone("Europe/Amsterdam");
        const games = await this.db.game.findMany({
            select: GameMapper.getSelectableFields()
        });
        return GameMapper
            .formatMany(games)
            .filter((game) => !isGameUnavailableForDate(game.name, nowAmsterdam));
    }

    public link = async (ticketID: number, games: number[]): Promise<void> => {
        for(let game of games) {
            await this.db.ticketGame.create({
                data: {
                    ticketID,
                    gameID: game
                }
            });
        }
    }
}

GameService.register()