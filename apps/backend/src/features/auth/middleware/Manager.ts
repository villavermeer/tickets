import { NextFunction, Request, Response } from "express";
import { Context } from "../../../common/utils/context";
import { IUserService } from "../../user/services/UserService";
import { container } from "tsyringe";
import { Role } from "@prisma/client";
import UnauthorizedError from "../../../common/classes/errors/UnauthorizedError";
import { formatErrorResponse } from "../../../common/utils/responses";
import { log } from "console";

export const HasRole = (role: Role) => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const userID = Context.get('authID');

            if (!userID) {
                throw new UnauthorizedError();
            }

            const userService = container.resolve<IUserService>("UserService");
            const user = await userService.find(userID);

            if (!user) {
                throw new UnauthorizedError();
            }

            if (user.role !== role) {
                res.status(403).json(formatErrorResponse(`You need ${role.toLowerCase()} access to access this resource`));
                return;
            }

            next();
        } catch (error: any) {
            res.status(403).json(formatErrorResponse(error.message || "Access denied."));
        }
    };
};