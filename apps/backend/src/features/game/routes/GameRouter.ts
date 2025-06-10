import { Router } from "express";
import { container, injectable, Lifecycle } from "tsyringe";
import { IGameController } from "../controllers/GameController";

export interface IGameRouter {
    getRouter(): Router;
}

@injectable()
class GameRouter implements IGameRouter {
    private router: Router;

    constructor() {
        this.router = Router();
        this.initializeRoutes();
    }

    public static register(): void {
        container.register("GameRouter", { useClass: GameRouter }, { lifecycle: Lifecycle.ResolutionScoped });
    }

    public getRouter = (): Router => {
        return this.router;
    }

    private initializeRoutes = (): void => {
        const gameController = container.resolve<IGameController>("GameController");
        
        this.router.get('/all', gameController.all);
    }
}

GameRouter.register()

export default GameRouter;
