import { CodeInterface } from "../../code/types";

export interface CreateTicketRequest {
    name: string
    games: number[]
    runnerID: number
    codes: CodeInterface[]
}