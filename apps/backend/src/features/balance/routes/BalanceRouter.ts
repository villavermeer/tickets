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
        
        // Get balance history (date range via query: startDate, endDate)
        this.router.get(
            "/:userID/history",
            Authorized,
            balanceController.getBalanceHistory
        );
        
        // Process payout (admins and managers)
        this.router.post(
            "/:userID/payout",
            Authorized,
            balanceController.processPayout
        );
        
        // Process correction (admins and managers)
        this.router.post(
            "/:userID/correction",
            Authorized,
            balanceController.processCorrection
        );
            
        // Add custom balance action (admins only)
        this.router.post(
            "/:userID/action",
            Authorized,
            HasRole(Role.ADMIN),
            balanceController.addBalanceAction
        );
        
        // Update balance action (admins only)
        this.router.put(
            "/action/:actionID",
            Authorized,
            HasRole(Role.ADMIN),
            balanceController.updateBalanceAction
        );
        
        // Delete balance action (admins only)
        this.router.delete(
            "/action/:actionID",
            Authorized,
            HasRole(Role.ADMIN),
            balanceController.deleteBalanceAction
        );
    }

    public static register(): void {
        container.register("BalanceRouter", { useClass: BalanceRouter }, { lifecycle: Lifecycle.ResolutionScoped });
    }
}

BalanceRouter.register();

export default BalanceRouter;
