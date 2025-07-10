import { Router } from "express";
import { container, injectable, Lifecycle } from "tsyringe";
import { IRaffleController } from "../controllers/RaffleController";
import { HasRole } from "../../auth/middleware/Manager";
import { Role } from "@prisma/client";
import { Authorized } from "../../auth/middleware/Authorized";

export interface IRaffleRouter {
    getRouter(): Router;
}

@injectable()
class RaffleRouter implements IRaffleRouter {
    private router: Router;

    constructor() {
        this.router = Router();
        this.initializeRoutes();
    }

    public static register(): void {
        container.register("RaffleRouter", { useClass: RaffleRouter }, { lifecycle: Lifecycle.ResolutionScoped });
    }

    public getRouter = (): Router => {
        return this.router;
    }

    private initializeRoutes = (): void => {
        const raffleController = container.resolve<IRaffleController>("RaffleController");

        this.router.post('/', Authorized, HasRole(Role.ADMIN), raffleController.save);
        this.router.get('/all', Authorized, HasRole(Role.ADMIN), raffleController.all);
        this.router.get('/today', Authorized, HasRole(Role.ADMIN), raffleController.today);
        this.router.get('/date', Authorized, raffleController.date);

        this.router.get('/winning-tickets', Authorized, raffleController.getWinningTicketsByDate)

        this.router.get('/:id/tickets', Authorized, HasRole(Role.ADMIN), raffleController.tickets)
        this.router.get('/:id', Authorized, HasRole(Role.ADMIN), raffleController.find)
        
    }
}

RaffleRouter.register()

export default RaffleRouter;
