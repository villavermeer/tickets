import { Game } from "@prisma/client";
import Service, { IServiceInterface } from "../../../common/services/Service";
import { injectable } from "tsyringe";
import { GameInterface } from "../types";
import { GameMapper } from "../mappers/GameMapper";
import { CreateGameRequest } from "../types/requests";

export interface IGameService extends IServiceInterface {
    all(): Promise<GameInterface[]>;
    link(ticketID: number, games: number[]): Promise<void>;
}

@injectable()
export class GameService extends Service implements IGameService {
    public all = async (): Promise<GameInterface[]> => {
        const games = await this.db.game.findMany({
            select: GameMapper.getSelectableFields()
        });
        return GameMapper.formatMany(games);
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