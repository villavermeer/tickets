import { CodeInterface } from "../../code/types";
import { GameInterface } from "../../game/types";

export interface TicketInterface {
    id: number;
    name: string;
    runnerID: number;
    codes: CodeInterface[];
    games: GameInterface[];
    created: Date;
    updated: Date;
}
