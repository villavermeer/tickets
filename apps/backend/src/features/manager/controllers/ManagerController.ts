import { NextFunction, Request, Response } from "express";
import Controller from "../../../common/controllers/Controller";
import { container, injectable } from "tsyringe";
import { formatMutationResponse, formatSuccessResponse } from "../../../common/utils/responses";
import { IManagerService } from "../services/ManagerService";
import { ITicketService } from "../../ticket/services/TicketService";

export interface IManagerController {
    all(req: Request, res: Response, next: NextFunction): Promise<void>;
    find(req: Request, res: Response, next: NextFunction): Promise<void>;
    tickets(req: Request, res: Response, next: NextFunction): Promise<void>;
}

@injectable()
export class ManagerController extends Controller implements IManagerController {

    public all = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const managerService = container.resolve<IManagerService>("ManagerService");
            const managers = await managerService.all();

            res.status(200).json(formatSuccessResponse('Managers', managers));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public find = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const managerService = container.resolve<IManagerService>("ManagerService");
            const manager = await managerService.find(Number(req.params.id));

            res.status(200).json(formatSuccessResponse('Manager', manager));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public tickets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const ticketService = container.resolve<ITicketService>("TicketService");
            const tickets = await ticketService.manager(Number(req.params.id));

            res.status(200).json(formatSuccessResponse('Tickets', tickets));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }
}

ManagerController.register()