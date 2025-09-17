import {Router} from 'express';
import {IBaseRouter} from "./Router";
import {container, injectable, Lifecycle} from "tsyringe";
import ContextHandler from "../middleware/ContextHandler";

export interface IMainRouter {
    getRouter(): Router;
}

@injectable()
class MainRouter implements IMainRouter {
    private router = Router();

    // List of routers to auto-register
    private readonly routes: { path: string; identifier: string }[] = [
        { path: '/auth', identifier: "AuthRouter" },
        { path: '/manager', identifier: "ManagerRouter" },
        { path: '/runner', identifier: "RunnerRouter" },
        { path: '/ticket', identifier: "TicketRouter" },
        { path: '/game', identifier: "GameRouter" },
        { path: '/raffle', identifier: "RaffleRouter" },
        { path: '/prize', identifier: "PrizeRouter" },
        { path: '/user', identifier: "UserRouter" },
        { path: '/revenue', identifier: "RevenueRouter" },
        { path: '/balance', identifier: "BalanceRouter" },
    ];

    constructor() {
        this.initializeRoutes();
    }

    public static register(): void {
        container.register("MainRouter", { useClass: MainRouter }, { lifecycle: Lifecycle.ResolutionScoped });
    }

    public getRouter(): Router {
        return this.router;
    }

    private initializeRoutes(): void {
        this.router.use(ContextHandler);

        this.routes.forEach(({ path, identifier }) => {
            const routerInstance = container.resolve<IBaseRouter>(identifier);
            this.router.use(path, routerInstance.getRouter());
        });
    }
}

export default MainRouter;
