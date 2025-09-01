import {NextFunction, Request, Response} from "express";
import jwt from 'jsonwebtoken';
import UnauthorizedError from "../../../common/classes/errors/UnauthorizedError";
import { formatErrorResponse } from  "../../../common/utils/responses"

export const Authorized = async (req: Request<unknown, unknown, unknown, unknown>, res: Response, next: NextFunction) => {
    try {
        let token = req.headers.authorization
        if (token == null) throw new UnauthorizedError()

        // if the token contains "Bearer " remove it
        if (token.startsWith("Bearer ")) {
            token = token.slice(7);
        }

        jwt.verify(token, process.env.TOKEN_SECRET as string, async (err: any, id: any) => {
            if (err) throw new UnauthorizedError()
            res.locals.authID = Number(id);
            next();
        });
    } catch (error: any) {
        res.status(403).json(formatErrorResponse(error.message || "Access denied."));
    }
}

export default Authorized;