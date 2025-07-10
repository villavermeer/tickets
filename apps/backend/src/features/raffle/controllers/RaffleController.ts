import { NextFunction, Request, Response } from "express";
import Controller from "../../../common/controllers/Controller";
import { container, injectable } from "tsyringe";
import { formatMutationResponse, formatSuccessResponse } from "../../../common/utils/responses";
import { IRaffleService } from "../services/RaffleService";
import { CreateRaffleRequest } from "../types/requests";
import { ITicketService } from "../../ticket/services/TicketService";

export interface IRaffleController {
    save(req: Request, res: Response, next: NextFunction): Promise<void>;
    all(req: Request, res: Response, next: NextFunction): Promise<void>;
    tickets(req: Request, res: Response, next: NextFunction): Promise<void>;
    today(req: Request, res: Response, next: NextFunction): Promise<void>;
    find(req: Request, res: Response, next: NextFunction): Promise<void>;
    date(req: Request, res: Response, next: NextFunction): Promise<void>;
    getWinningTicketsByDate(req: Request, res: Response, next: NextFunction): Promise<void>;
}

@injectable()
export class RaffleController extends Controller implements IRaffleController {

    public find = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const raffle = await container
                .resolve<IRaffleService>("RaffleService")
                .find(parseInt(req.params.id));

            res.status(200).json(formatSuccessResponse('Raffle', raffle));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public save = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            container
                .resolve<IRaffleService>("RaffleService")
                .save(req.body);

            res.status(200).json(formatMutationResponse('Raffle saved successfully'));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public all = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const raffles = await container
                .resolve<IRaffleService>("RaffleService")
                .all();

            res.status(200).json(formatSuccessResponse('Raffles', raffles));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public tickets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tickets = await container
                .resolve<ITicketService>("TicketService")
                .raffle(parseInt(req.params.id), req.query.start as string, req.query.end as string);

            res.status(200).json(formatSuccessResponse('Tickets', tickets));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }
    
    public today = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const raffle = await container
                .resolve<IRaffleService>("RaffleService")
                .today();

            res.status(200).json(formatSuccessResponse('Raffle', raffle));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public date = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const date = new Date(req.query.date as string);

            const raffles = await container
                .resolve<IRaffleService>("RaffleService")
                .date(date);

            res.status(200).json(formatSuccessResponse('Raffles', raffles));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public getWinningTicketsByDate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const date = new Date(req.query.date as string);

            const tickets = await container
                .resolve<IRaffleService>("RaffleService")
                .getWinningTicketsByDate(date); 

            res.status(200).json(formatSuccessResponse('Tickets', tickets));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }
}

RaffleController.register()