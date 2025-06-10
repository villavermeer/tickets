import {Router as ExpressRouter} from "express";
import {container} from "tsyringe";

export interface IBaseRouter {
    getRouter(): ExpressRouter
}

export abstract class Router implements IBaseRouter {
    public router: ExpressRouter;

    protected constructor() {
        this.router = ExpressRouter();
        this.initializeRoutes();
    }

    // Register route class with tsyringe DI container
    static register<T extends new (...args: any[]) => any>(this: T, identifier?: string): void {
        container.register(identifier || this.name, { useClass: this });
    }

    // Provide a method to expose the router for Express app use
    public getRouter(): ExpressRouter {
        return this.router;
    }

    // Abstract method to initialize routes in subclasses
    protected abstract initializeRoutes(): void;
}

export default Router;