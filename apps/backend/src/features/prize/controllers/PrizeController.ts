import { Request, Response } from "express";
import { injectable, container } from "tsyringe";
import Controller from "../../../common/controllers/Controller";
import { formatSuccessResponse } from "../../../common/utils/responses";
import { IPrizeService } from "../services/PrizeService";

export interface IPrizeController {
    byDate(req: Request, res: Response): Promise<void>;
}

@injectable()
export class PrizeController extends Controller implements IPrizeController {
    constructor() { super(); }

    public byDate = async (req: Request, res: Response): Promise<void> => {
        try {
            const date = req.query.date ? new Date(req.query.date as string) : new Date();
            const scopeUserID = req.query.userID ? Number(req.query.userID) : undefined;

            const service = container.resolve<IPrizeService>("PrizeService");
            const prizes = await service.getPrizesByDate(date, scopeUserID);

            res.status(200).json(formatSuccessResponse("Prizes", prizes));
        } catch (error) {
            this.handleError(error, req, res);
        }
    }
}

PrizeController.register("PrizeController");


