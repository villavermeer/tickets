import { Request, Response } from "express";
import { container, injectable } from "tsyringe";
import { formatMutationResponse, formatSuccessResponse } from "../../../common/utils/responses";
import Controller from "../../../common/controllers/Controller";
import { Context } from "../../../common/utils/context";
import { IUserService } from "../services/UserService";

export interface IUserController {
    getCurrentUser(req: Request, res: Response): Promise<void>;
    update(req: Request, res: Response): Promise<void>;
    delete(req: Request, res: Response): Promise<void>;
}

@injectable()
export class UserController extends Controller implements IUserController {
    public getCurrentUser = async (req: Request, res: Response): Promise<void> => {
        const userService = container.resolve<IUserService>("UserService");

        const user = await userService.current();
        res.status(200).json(formatSuccessResponse('User', user));
    }

    public update = async (req: Request, res: Response): Promise<void> => {
        try {
            const userService = container.resolve<IUserService>("UserService");
            const user = await userService.update({ id: parseInt(req.params.id), ...req.body });

            res.status(200).json(formatSuccessResponse('User', user));
        } catch (error) {
            this.handleError(error, req, res);
        }
    }

    public delete = async (req: Request, res: Response): Promise<void> => {
        try {
            const userService = container.resolve<IUserService>("UserService");
            await userService.delete(parseInt(req.params.id));

            res.status(200).json(formatMutationResponse('User deleted'));
        } catch (error) {
            this.handleError(error, req, res);
        }
    }

}

UserController.register();

export default UserController;