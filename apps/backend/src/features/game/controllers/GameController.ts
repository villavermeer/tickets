import { NextFunction, Request, Response } from "express";
import Controller from "../../../common/controllers/Controller";
import { container, injectable } from "tsyringe";
import { formatMutationResponse, formatSuccessResponse } from "../../../common/utils/responses";
import { IGameService } from "../services/GameService";

export interface IGameController {
    all(req: Request, res: Response, next: NextFunction): Promise<void>;
}

@injectable()
export class GameController extends Controller implements IGameController {

    public all = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const gameService = container.resolve<IGameService>("GameService");
            const games = await gameService.all();

            res.status(200).json(formatSuccessResponse('Games', games));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }
}

GameController.register()