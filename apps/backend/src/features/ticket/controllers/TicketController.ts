import { NextFunction, Request, Response } from "express";
import Controller from "../../../common/controllers/Controller";
import { container, injectable } from "tsyringe";
import { formatMutationResponse, formatSuccessResponse } from "../../../common/utils/responses";
import { ITicketService } from "../services/TicketService";
import ValidationError from "../../../common/classes/errors/ValidationError";

export interface ITicketController {
    all(req: Request, res: Response, next: NextFunction): Promise<void>;
    create(req: Request, res: Response, next: NextFunction): Promise<void>;
    update(req: Request, res: Response, next: NextFunction): Promise<void>;
    export(req: Request, res: Response, next: NextFunction): Promise<void>;
    delete(req: Request, res: Response, next: NextFunction): Promise<void>;
}

@injectable()
export class TicketController extends Controller implements ITicketController {

    public all = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const ticketService = container.resolve<ITicketService>("TicketService");
            const tickets = await ticketService.all(req.query.start as string, req.query.end as string, req.query.managerID as string, req.query.runnerID as string);

            res.status(200).json(formatSuccessResponse('Tickets', tickets));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const ticketService = container.resolve<ITicketService>("TicketService");
            const ticket = await ticketService.create(req.body);

            if(!ticket) {
                throw new ValidationError('Error creating ticket');
            }

            res.status(200).json(formatMutationResponse('Ticket created'));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const ticketService = container.resolve<ITicketService>("TicketService");
            
            await ticketService.update(
                Number(req.params.id), 
                req.body
            );

            res.status(200).json(formatMutationResponse('Ticket updated'));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public export = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const ticketService = container.resolve<ITicketService>("TicketService");
            const buffer = await ticketService.export(req.body);

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename=tickets.xlsx');
            res.send(buffer);
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public delete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const ticketService = container.resolve<ITicketService>("TicketService");
            await ticketService.delete(Number(req.params.id));

            res.status(200).json(formatMutationResponse('Ticket removed'));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }
}

TicketController.register()