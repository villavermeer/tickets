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
    games: number[];
    codes: CodeInterface[];
}

export interface RelayableTicketOverview {
    code: string;
    games: string[];
    gameIds: number[];
    totalValue: number;
    ticketCount: number;
}

export interface RelayableTicketEntry {
    code: string;
    codeLength: number;
    value: number;
    deduction: number;
    final: number;
}

export interface ChunkedRelayableTicket {
    gameCombination: string[];
    codes: string[];
    totalValue: number;
    ticketCount: number;
    deduction: number;
    finalValue: number;
    entries: RelayableTicketEntry[];
}

export interface ExportTicketRequest {
    startDate: string;
    endDate: string;
}