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
            const page = req.query.page ? Math.max(1, Number(req.query.page)) : 1;
            const pageSize = req.query.pageSize ? Math.max(1, Math.min(200, Number(req.query.pageSize))) : 50;

            const service = container.resolve<IPrizeService>("PrizeService");
            const payload = await service.getPrizesByDate(date, scopeUserID, page, pageSize);

            res.status(200).json(formatSuccessResponse("Prizes", {
                prizes: payload.groups,
                page: payload.page,
                pageSize: payload.pageSize,
                hasMore: payload.hasMore,
                totalTickets: payload.totalTickets
            }));
        } catch (error) {
            this.handleError(error, req, res);
        }
    }
}

PrizeController.register("PrizeController");


