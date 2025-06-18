import { Router } from "express";
import { container, injectable, Lifecycle } from "tsyringe";
import { IRevenueController } from "../controllers/RevenueController";

export interface IRevenueRouter {
    getRouter(): Router;
}

@injectable()
class RevenueRouter implements IRevenueRouter {
    private router: Router;

    constructor() {
        this.router = Router();
        this.initializeRoutes();
    }

    public static register(): void {
        container.register("RevenueRouter", { useClass: RevenueRouter }, { lifecycle: Lifecycle.ResolutionScoped });
    }

    public getRouter = (): Router => {
        return this.router;
    }

    private initializeRoutes = (): void => {
        const revenueController = container.resolve<IRevenueController>("RevenueController");

        this.router.get('/date', revenueController.getRevenueByDate);
        this.router.get('/ticket/:id', revenueController.getRevenueByTicket);
        this.router.get('/runner/:id', revenueController.getRevenueByRunner);
        this.router.get('/manager/:id', revenueController.getRevenueByManager);
    }
}

RevenueRouter.register()

export default RevenueRouter;
