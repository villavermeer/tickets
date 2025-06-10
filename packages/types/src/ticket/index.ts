import { CodeInterface } from "../code";
import { GameInterface } from "../game";
import { UserInterface } from "../user";

export interface TicketInterface {
    id: number;
    name: string;
    creator: UserInterface;
    codes: CodeInterface[];
    games: GameInterface[];
    created: Date;
    updated: Date;
}

export interface UpdateTicketRequest {
    id: number;
    name: string;
    games: Array<number>;
    codes: Array<{
        code: number;
        value: number;
    }>;
}

export interface ExportTicketRequest {
    startDate: string;
    endDate: string;
}