import { Request, Response } from "express";
import { container, injectable } from "tsyringe";
import { formatMutationResponse, formatSuccessResponse } from "../../../common/utils/responses";
import { IUserService, UserService } from "../services/UserService";
import Controller from "../../../common/controllers/Controller";
import { Context } from "../../../common/utils/context";

export interface IUserController {
    getCurrentUser(req: Request, res: Response): Promise<void>;
}

@injectable()
export class UserController extends Controller implements IUserController {
    public getCurrentUser = async (req: Request, res: Response): Promise<void> => {
        const userService = container.resolve<IUserService>("UserService");

        const user = await userService.current();
        res.status(200).json(formatSuccessResponse('User', user));
    }

}

UserController.register();

export default UserController;