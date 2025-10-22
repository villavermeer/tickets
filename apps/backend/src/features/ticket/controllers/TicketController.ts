import { NextFunction, Request, Response } from "express";
import Controller from "../../../common/controllers/Controller";
import { container, injectable } from "tsyringe";
import { formatMutationResponse, formatSuccessResponse } from "../../../common/utils/responses";
import { ITicketService } from "../services/TicketService";
import ValidationError from "../../../common/classes/errors/ValidationError";
import UnauthorizedError from "../../../common/classes/errors/UnauthorizedError";
import { Context } from "../../../common/utils/context";

export interface ITicketController {
    all(req: Request, res: Response, next: NextFunction): Promise<void>;
    create(req: Request, res: Response, next: NextFunction): Promise<void>;
    update(req: Request, res: Response, next: NextFunction): Promise<void>;
    export(req: Request, res: Response, next: NextFunction): Promise<void>;
    delete(req: Request, res: Response, next: NextFunction): Promise<void>;
    getRelayableTickets(req: Request, res: Response, next: NextFunction): Promise<void>;
    exportRelayableGameTotals(req: Request, res: Response, next: NextFunction): Promise<void>;
    exportRelayableBalanceSummary(req: Request, res: Response, next: NextFunction): Promise<void>;
    exportRelayablePrizes(req: Request, res: Response, next: NextFunction): Promise<void>;
    getRelayBatchHistory(req: Request, res: Response, next: NextFunction): Promise<void>;
    undoRelayBatch(req: Request, res: Response, next: NextFunction): Promise<void>;
}

@injectable()
export class TicketController extends Controller implements ITicketController {

    /**
     * Check if the current user is authorized for relay operations (user ID 58)
     * @throws UnauthorizedError if user is not authorized
     */
    private checkRelayAuthorization(): void {
        const authID = Context.get('authID');
        if (authID !== 58) {
            throw new UnauthorizedError();
        }
    }

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

    public exportRelayableGameTotals = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            // Check if user is authorized for relay operations
            this.checkRelayAuthorization();

            const ticketService = container.resolve<ITicketService>("TicketService");

            const commitParam = (req.query.commit as string) || "false";
            const commit = commitParam === 'true' || commitParam === '1';

            const combineParam = (req.query.combine as string) || "false";
            const combineAcrossGames = combineParam === 'true' || combineParam === '1';

            const buffer = await ticketService.exportRelayableGameTotals(
                req.query.start as string,
                req.query.end as string,
                commit,
                combineAcrossGames
            );

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=relayable-game-totals-${req.query.start}-${req.query.end}.xlsx`);
            res.send(buffer);
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public exportRelayableBalanceSummary = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const ticketService = container.resolve<ITicketService>("TicketService");

            const buffer = await ticketService.exportRelayableBalanceSummary(
                req.query.start as string,
                req.query.end as string
            );

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=relayable-saldo-${req.query.start}-${req.query.end}.xlsx`);
            res.send(buffer);
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public exportRelayablePrizes = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const ticketService = container.resolve<ITicketService>("TicketService");

            const scopeParam = req.query.userID as string;
            const scopeUserID = scopeParam ? Number(scopeParam) : undefined;
            const parsedScope = scopeUserID && !Number.isNaN(scopeUserID) ? scopeUserID : undefined;

            const buffer = await ticketService.exportRelayablePrizes(
                req.query.start as string,
                req.query.end as string,
                req.query.prizeDate as string | undefined,
                parsedScope
            );

            const filenameDate = (req.query.prizeDate as string) || (req.query.end as string) || (req.query.start as string);

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=relayable-prijzen-${filenameDate}.xlsx`);
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

    /**
     * Get relayable tickets with flexible date parameter support
     * 
     * Supported date formats:
     * - ISO strings: "2025-08-20T00:00:00+02:00" (URL encoded)
     * - Simple dates: "2025-08-20" (start: 00:00:00, end: 23:59:59)
     * - Date with time: "2025-08-20 21:00" or "2025-08-20 21:00:00"
     * 
     * Examples for demo:
     * - /ticket/relayable?start=2025-08-20&end=2025-08-20&pdf=true
     * - /ticket/relayable?start=2025-08-20&end=2025-08-20 21:00&pdf=true
     * - /ticket/relayable?start=2025-08-19&end=2025-08-21&pdf=true
     * 
     * @param req.query.start - Start date/time (various formats supported)
     * @param req.query.end - End date/time (various formats supported)
     * @param req.query.commit - Whether to commit the relay (default: false)
     * @param req.query.pdf - Whether to export as PDF (default: false)
     * @param req.query.export - Whether to export as Excel (default: false)
     * @param req.query.compact - Whether to use compact PDF format (default: false)
     */
    public getRelayableTickets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const ticketService = container.resolve<ITicketService>("TicketService");

            const commitParam = (req.query.commit as string) || "false";
            const commit = commitParam === 'true' || commitParam === '1';
            
            const exportParam = (req.query.export as string) || "false";
            const shouldExport = exportParam === 'true' || exportParam === '1';
            
            const pdfParam = (req.query.pdf as string) || "false";
            const shouldExportPDF = pdfParam === 'true' || pdfParam === '1';
            const compactParam = (req.query.compact as string) || "false";
            const compact = compactParam === 'true' || compactParam === '1';
            const combineParam = (req.query.combine as string) || "false";
            const combineAcrossGames = combineParam === 'true' || combineParam === '1';

            // Check authorization for PDF and Excel exports (relay ticket exports)
            if (shouldExportPDF || shouldExport) {
                this.checkRelayAuthorization();
            }

            if (shouldExportPDF) {
                // Return PDF file
                const buffer = await ticketService.exportRelayableTicketsPDF(
                    req.query.start as string, 
                    req.query.end as string,
                    commit,
                    compact,
                    combineAcrossGames
                );

                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename=relayable-tickets-${req.query.start}-${req.query.end}.pdf`);
                res.send(buffer);
            } else if (shouldExport) {
                // Return Excel file
                try {
                    console.log('Starting Excel export for relayable tickets...');
                    const buffer = await ticketService.exportRelayableTickets(
                        req.query.start as string, 
                        req.query.end as string,
                        commit,
                        combineAcrossGames
                    );
                    
                    console.log('Excel export completed, buffer size:', (buffer as any).length || 'unknown');
                    console.log('Buffer type:', typeof buffer);
                    console.log('Buffer constructor:', buffer.constructor.name);
                    
                    if (!buffer) {
                        throw new Error('Generated Excel buffer is null or undefined');
                    }

                    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                    res.setHeader('Content-Disposition', `attachment; filename=relayable-tickets-${req.query.start}-${req.query.end}.xlsx`);
                    if ((buffer as any).length) {
                        res.setHeader('Content-Length', (buffer as any).length.toString());
                    }
                    res.send(buffer);
                } catch (exportError: any) {
                    console.error('Error during Excel export:', exportError);
                    // Send a proper error response instead of falling through to handleError
                    res.status(500).json({
                        status: "error",
                        error: "Failed to generate Excel file",
                        details: exportError.message || 'Unknown error'
                    });
                }
            } else {
                // Return JSON data
                const relayableTickets = await ticketService.getRelayableTickets(
                    req.query.start as string, 
                    req.query.end as string,
                    commit,
                    combineAcrossGames
                );

                res.status(200).json(formatSuccessResponse('Results', relayableTickets));
            }
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public getRelayBatchHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            // Check if user is authorized for relay operations
            this.checkRelayAuthorization();

            const ticketService = container.resolve<ITicketService>("TicketService");
            const history = await ticketService.getRelayBatchHistory();

            res.status(200).json(formatSuccessResponse('batches', history));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }

    public undoRelayBatch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            // Check if user is authorized for relay operations
            this.checkRelayAuthorization();

            const ticketService = container.resolve<ITicketService>("TicketService");
            await ticketService.undoRelayBatch(Number(req.params.id));

            res.status(200).json(formatMutationResponse('Relay batch undone successfully'));
        } catch (error: any) {
            this.handleError(error, req, res);
        }
    }
}

TicketController.register()
