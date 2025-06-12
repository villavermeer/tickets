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
            log(`Checking role: ${role}`);
            const userID = Context.get('authID');
            log(`Retrieved userID: ${userID}`);

            if (!userID) {
                log('No userID found, throwing UnauthorizedError');
                throw new UnauthorizedError();
            }

            const userService = container.resolve<IUserService>("UserService");
            const user = await userService.find(userID);
            log(`User found: ${user ? user.id : 'None'}`);

            if (!user) {
                log('User not found, throwing UnauthorizedError');
                throw new UnauthorizedError();
            }

            if (user.role !== role) {
                log(`User role ${user.role} does not match required role ${role}, sending 403 response`);
                res.status(403).json(formatErrorResponse(`You need ${role.toLowerCase()} access to access this resource`));
                return;
            }

            log('User role matches, proceeding to next middleware');
            next();
        } catch (error: any) {
            log(`Error occurred: ${error.message || "Access denied."}`);
            res.status(403).json(formatErrorResponse(error.message || "Access denied."));
        }
    };
};