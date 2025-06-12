import { NextFunction, Request, Response } from "express";
import Controller from "../../../common/controllers/Controller";
import { container, injectable } from "tsyringe";
import { formatMutationResponse, formatSuccessResponse } from "../../../common/utils/responses";
import { IRunnerService } from "../services/RunnerService";
import { ITicketService } from "../../ticket/services/TicketService";

export interface IRunnerController {
    find(req: Request, res: Response, next: NextFunction): Promise<void>;
    all(req: Request, res: Response, next: NextFunction): Promise<void>;
    manager(req: Request, res: Response, next: NextFunction): Promise<void>;
    tickets(req: Request, res: Response, next: NextFunction): Promise<void>;
}

@injectable()
export class RunnerController extends Controller implements IRunnerController {

    public find = async (req: Request, res: Response, next: NextFunction): Promise<void> => {   
        try {
            const runnerService = container.resolve<IRunnerService>("RunnerService");
            const runner = await runnerService.find(Number(req.params.id));

            res.status(200).json(formatSuccessResponse('Runner', runner));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public all = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const runnerService = container.resolve<IRunnerService>("RunnerService");
            const runners = await runnerService.all();

            res.status(200).json(formatSuccessResponse('Runners', runners));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public manager = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const runnerService = container.resolve<IRunnerService>("RunnerService");
            const runners = await runnerService.manager(Number(req.params.id));

            res.status(200).json(formatSuccessResponse('Runners', runners));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public tickets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const ticketService = container.resolve<ITicketService>("TicketService");
            const tickets = await ticketService.runner(Number(req.params.id), req.query.date ? new Date(req.query.date as string) : undefined);

            res.status(200).json(formatSuccessResponse('Tickets', tickets));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }
}

RunnerController.register()