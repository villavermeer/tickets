import {NextFunction, Request, Response} from "express";
import {container, injectable} from "tsyringe";
import {IAuthService} from "../services/AuthService";
import Controller from "../../../common/controllers/Controller";
import { AuthorizeRequest, CreateUserRequest } from "../types/requests";
import { formatMutationResponse } from "../../../common/utils/responses";

export interface IAuthController {
	authorize(req: Request, res: Response, next: NextFunction): Promise<void>;
	register(req: Request, res: Response, next: NextFunction): Promise<void>;
}

@injectable()
class AuthController extends Controller implements IAuthController {

	public authorize = async (req: Request<any, any, AuthorizeRequest>, res: Response, next: NextFunction): Promise<void> => {
		try {
			console.log('Authorizing')

			const authService = container.resolve<IAuthService>("AuthService");

			const { user, token } = await authService.authorize(req.body);

			res.status(200).json(formatMutationResponse('Authorization successful', { user, token }))
		} catch (error: any) {

			console.log(JSON.stringify(error))

			this.handleError(error, req, res);
		}
	}

	public register = async (req: Request<any, any, CreateUserRequest>, res: Response) => {
		try {
			const authService = container.resolve<IAuthService>("AuthService");

			await authService.register(req.body);

			res.status(200).json(formatMutationResponse('Registration successful'));
		} catch (error: any) {
			console.error(error)
			this.handleError(error, req, res);
		}
	};
}

AuthController.register()