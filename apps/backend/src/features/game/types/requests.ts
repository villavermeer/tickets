import { GameExpiry } from "@prisma/client";

export interface CreateGameRequest {
    name: string;
    expires: GameExpiry;
}