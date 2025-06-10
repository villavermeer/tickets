import { CodeInterface } from "../code";
import { GameInterface } from "../game";
import { RevenueInterface } from "../revenue";

export interface RaffleInterface {
    id: number;
    created: Date;
    game: GameInterface
    codes: Array<CodeInterface>;
    revenue: RevenueInterface
}

export interface CreateRaffleRequest {
    gameID: number
    codes: Array<number>
}