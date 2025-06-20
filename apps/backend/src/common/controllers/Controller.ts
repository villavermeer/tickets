import {Response} from "express";
import {container} from "tsyringe";
import BaseError from "../classes/errors/BaseError";
import Singleton from "../classes/injectable/Singleton";

export default class Controller extends Singleton {
    public static type = 'singleton'

    constructor() { super() }

    static register<T extends new (...args: any[]) => any>(this: T, identifier?: string): void {
        container.register(identifier || this.name, { useClass: this });
    }

    protected handleError(error: any, req: any, res: Response<any>): void {

        console.error(error)

        if (error instanceof BaseError) {
            res.status(error.getStatusCode()).json({
                status: "error",
                error: error.getMessage(),
            });
        } else {
            res.status(500).json({
                status: "error",
                error: "Something went wrong... please try again later",
            });
        }
    }
}