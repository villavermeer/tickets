export interface CreateRaffleRequest {
    raffleID?: number
    gameID: number
    codes: Array<number>
}