import { Router } from "express";
import { container, injectable, Lifecycle } from "tsyringe";
import { IPrizeController } from "../controllers/PrizeController";
import { Authorized } from "../../auth/middleware/Authorized";

export interface IPrizeRouter {
    getRouter(): Router;
}

@injectable()
export class PrizeRouter implements IPrizeRouter {
    private router: Router;

    constructor() {
        this.router = Router();
        this.initializeRoutes();
    }

    public getRouter(): Router { return this.router; }

    private initializeRoutes(): void {
        const controller = container.resolve<IPrizeController>("PrizeController");

        // GET /prize/date?date=YYYY-MM-DD&userID=optional
        this.router.get('/date', Authorized, controller.byDate);
    }

    public static register(): void {
        container.register("PrizeRouter", { useClass: PrizeRouter }, { lifecycle: Lifecycle.ResolutionScoped });
    }
}

PrizeRouter.register();

export default PrizeRouter;


