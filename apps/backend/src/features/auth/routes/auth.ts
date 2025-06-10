import {container, injectable} from "tsyringe";
import Router from "../../../common/routes/Router";
import {IAuthController} from "../controllers/AuthController";

@injectable()
export class AuthRouter extends Router {

	constructor() {
		super();
		this.initializeRoutes();
	}

	public static register(): void {
		container.register("AuthRouter", { useClass: AuthRouter });
	}

	protected initializeRoutes(): void {
		// Lazy Resolve AuthController
		const authController = container.resolve<IAuthController>("AuthController");

		this.router.post('/register', authController.register);
		this.router.post('/authorize', authController.authorize);
	}
}