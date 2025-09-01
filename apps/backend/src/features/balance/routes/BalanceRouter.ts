import { Router } from "express";
import { container, injectable, Lifecycle } from "tsyringe";
import { IBalanceController } from "../controllers/BalanceController";
import { HasRole } from "../../auth/middleware/Manager";
import { Role } from "@prisma/client";
import { Authorized } from "../../auth/middleware/Authorized";

export interface IBalanceRouter {
    getRouter(): Router;
}

@injectable()
export class BalanceRouter implements IBalanceRouter {

    private router: Router;

    constructor() {
        this.router = Router();
        this.initializeRoutes();
    }

    public getRouter = (): Router => {
        return this.router;
    }

    private initializeRoutes(): void {
        const balanceController = container.resolve<IBalanceController>("BalanceController");
        
        this.router.get(
            "/:userID",
            Authorized,
            balanceController.getUserBalance
        );
        
        // Get balance actions
        this.router.get(
            "/:userID/actions",
            Authorized,
            balanceController.getBalanceActions
        );
        
        // Process payout (admins only)
        this.router.post(
            "/:userID/payout",
            Authorized,
            HasRole(Role.ADMIN),
            balanceController.processPayout
        );
        
        // Process correction (admins only)
        this.router.post(
            "/:userID/correction",
            Authorized,
            HasRole(Role.ADMIN),
            balanceController.processCorrection
        );
            
        // Add custom balance action (admins only)
        this.router.post(
            "/:userID/action",
            Authorized,
            HasRole(Role.ADMIN),
            balanceController.addBalanceAction
        );
    }

    public static register(): void {
        container.register("BalanceRouter", { useClass: BalanceRouter }, { lifecycle: Lifecycle.ResolutionScoped });
    }
}

BalanceRouter.register();

export default BalanceRouter;
