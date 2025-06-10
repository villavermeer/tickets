import { Router } from "express";
import { container, injectable, Lifecycle } from "tsyringe";
import { IRunnerController } from "../controllers/RunnerController";

export interface IRunnerRouter {
    getRouter(): Router;
}

@injectable()
class RunnerRouter implements IRunnerRouter {
    private router: Router;

    constructor() {
        this.router = Router();
        this.initializeRoutes();
    }

    public static register(): void {
        container.register("RunnerRouter", { useClass: RunnerRouter }, { lifecycle: Lifecycle.ResolutionScoped });
    }

    public getRouter = (): Router => {
        return this.router;
    }

    private initializeRoutes = (): void => {
        const runnerController = container.resolve<IRunnerController>("RunnerController");
        
        this.router.get('/all', runnerController.all);
        this.router.get('/:id/tickets', runnerController.tickets);
        this.router.get('/:id', runnerController.find);
    }
}

RunnerRouter.register()

export default RunnerRouter;
