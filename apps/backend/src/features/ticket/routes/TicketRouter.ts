import { Router } from "express";
import { container, injectable, Lifecycle } from "tsyringe";
import { ITicketController } from "../controllers/TicketController";
import { IRunnerController } from "../../runner/controllers/RunnerController";
import ExcelJS from "exceljs";

export interface ITicketRouter {
    getRouter(): Router;
}

@injectable()
class TicketRouter implements ITicketRouter {
    private router: Router;

    constructor() {
        this.router = Router();
        this.initializeRoutes();
    }

    public static register(): void {
        container.register("TicketRouter", { useClass: TicketRouter }, { lifecycle: Lifecycle.ResolutionScoped });
    }

    public getRouter = (): Router => {
        return this.router;
    }

    private initializeRoutes = (): void => {
        const ticketController = container.resolve<ITicketController>("TicketController");

        this.router.get('/', ticketController.all);
        this.router.get('/relayable', ticketController.getRelayableTickets);
        this.router.get('/relayable/game-totals', ticketController.exportRelayableGameTotals);
        this.router.get('/relayable/balance', ticketController.exportRelayableBalanceSummary);
        this.router.get('/relayable/prizes', ticketController.exportRelayablePrizes);
        this.router.get('/relay-batches', ticketController.getRelayBatchHistory);
        this.router.post('/', ticketController.create);
        this.router.post('/export', ticketController.export);
        this.router.put('/:id', ticketController.update);
        this.router.delete('/:id', ticketController.delete);
        this.router.delete('/relay-batches/:id', ticketController.undoRelayBatch);
    }
}

TicketRouter.register()

export default TicketRouter;
