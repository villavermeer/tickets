import jwt from "jsonwebtoken";
import { NextFunction, Request, Response } from "express";
import _ from "lodash";
import { Context } from "../utils/context";
import { IUserService } from "../../features/user/services/UserService";
import { container } from "tsyringe";

const ContextHandler = (req: Request, res: Response, next: NextFunction) => {
    Context.run(async () => {
        const userService = container.resolve<IUserService>("UserService")

        const authHeader = req.headers["authorization"];

        let token = authHeader
            ? authHeader
            : null;

        // Remove "Bearer " prefix if present
        if (token && token.startsWith("Bearer ")) {
            token = token.slice(7);
        }

        let authID = 0;

        if (token) {

            try {
                const decoded = jwt.verify(token as any, process.env.TOKEN_SECRET as string);

                if (typeof decoded === "string") {
                    authID = _.toNumber(decoded);
                } else {
                    authID = _.toNumber(decoded.id);
                }

                const user = await userService.find(authID);
                Context.set("user", user);
            } catch (error) {
                console.error('JWT verification error:', error);
                authID = 0;
            }
        }

        Context.set("authID", authID);

        next();
    });
};

export default ContextHandler;