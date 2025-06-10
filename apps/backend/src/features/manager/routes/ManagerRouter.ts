import { Router } from "express";
import { container, injectable, Lifecycle } from "tsyringe";
import { IManagerController } from "../controllers/ManagerController";
import { IRunnerController } from "../../runner/controllers/RunnerController";

export interface IManagerRouter {
    getRouter(): Router;
}

@injectable()
class ManagerRouter implements IManagerRouter {
    private router: Router;

    constructor() {
        this.router = Router();
        this.initializeRoutes();
    }

    public static register(): void {
        container.register("ManagerRouter", { useClass: ManagerRouter }, { lifecycle: Lifecycle.ResolutionScoped });
    }

    public getRouter = (): Router => {
        return this.router;
    }

    private initializeRoutes = (): void => {
        const managerController = container.resolve<IManagerController>("ManagerController");
        const runnerController = container.resolve<IRunnerController>("RunnerController");

        this.router.get('/all', managerController.all);
        this.router.get('/:id/tickets', managerController.tickets);
        this.router.get('/:id/runners', runnerController.manager);
        this.router.get('/:id', managerController.find);
    }
}

ManagerRouter.register()

export default ManagerRouter;
