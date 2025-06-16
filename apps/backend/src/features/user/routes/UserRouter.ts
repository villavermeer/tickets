import { Request, Response, Router } from "express";
import { container, injectable } from "tsyringe";
import { IUserController } from "../controllers/UserController";

export interface IUserRouter {
    getRouter(): Router;
}

@injectable()
export class UserRouter implements IUserRouter {

    private router: Router;

    constructor() {
        this.router = Router();
        this.initializeRoutes();
    }

    public getRouter = (): Router => {
        return this.router;
    }

    private initializeRoutes(): void {
        const userController = container.resolve<IUserController>("UserController");
        
        this.router.get('/', userController.getCurrentUser);
        this.router.put('/:id', userController.update); 
        this.router.delete('/:id', userController.delete);
    }

    public static register(): void {
        container.register("UserRouter", { useClass: UserRouter });
    }
}

UserRouter.register();

export default UserRouter;