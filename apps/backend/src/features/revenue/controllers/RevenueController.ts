import { Request, Response } from "express";
import { formatSuccessResponse } from "../../../common/utils/responses";
import { container, injectable } from "tsyringe";
import Controller from "../../../common/controllers/Controller";
import { IRevenueService } from "../services/RevenueService";

export interface IRevenueController {
    getRevenueByDate(req: Request, res: Response): Promise<void>;
    getRevenueByTicket(req: Request, res: Response): Promise<void>;
    getRevenueByRaffle(req: Request, res: Response): Promise<void>;
    getRevenueByRunner(req: Request, res: Response): Promise<void>;
}

@injectable()
export class RevenueController extends Controller implements IRevenueController {

    constructor() {
        super();
    }

    public getRevenueByDate = async (req: Request, res: Response): Promise<void> => {
        try {
            const revenueService = container.resolve<IRevenueService>("RevenueService");
            const date = new Date(req.query.date as string);

            const revenue = await revenueService.getRevenueByDate(date)

            res.status(200).json(formatSuccessResponse('Revenue', revenue));
        } catch (error) {
            this.handleError(error, req, res);
        }
    }

    public getRevenueByRunner = async (req: Request, res: Response): Promise<void> => {
        try {
            const revenueService = container.resolve<IRevenueService>("RevenueService");
            const revenue = await revenueService.getRevenueByRunner(Number(req.params.id), req.query.date ? new Date(req.query.date as string) : undefined)

            res.status(200).json(formatSuccessResponse('Revenue', revenue));
        } catch (error) {
            this.handleError(error, req, res);
        }
    }

    public getRevenueByTicket = async (req: Request, res: Response): Promise<void> => {
        try {
            const revenueService = container.resolve<IRevenueService>("RevenueService");
            const revenue = await revenueService.getRevenueByTicket(Number(req.params.id))

            res.status(200).json(formatSuccessResponse('Revenue', revenue));
        } catch (error) {
            this.handleError(error, req, res);
        }
    }

    public getRevenueByRaffle = async (req: Request, res: Response): Promise<void> => {
        try {
            const revenueService = container.resolve<IRevenueService>("RevenueService");
            const revenue = await revenueService.getRevenueByRaffle(Number(req.params.id))

            res.status(200).json(formatSuccessResponse('Revenue', revenue));
        } catch (error) {
            this.handleError(error, req, res);
        }
    }
}