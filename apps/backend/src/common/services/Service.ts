import {container, Lifecycle} from "tsyringe";
import _ from "lodash";
import {Prisma} from "@prisma/client/extension";
import TransactionClient = Prisma.TransactionClient;
import Singleton from "../classes/injectable/Singleton";
import { ExtendedPrismaClient } from "../utils/prisma";

export interface IServiceInterface {
    bindTransactionClient(prisma: ExtendedPrismaClient): this
}

export abstract class Service extends Singleton implements IServiceInterface {

    protected db: ExtendedPrismaClient = container.resolve<ExtendedPrismaClient>("Database");

    // Register service with tsyringe DI container
    static register<T extends new (...args: any[]) => any>(
        this: T,
        identifier?: string
    ): void {
        container.register(identifier || this.name, {
            useClass: this as unknown as new (...args: any[]) => T
        }, { lifecycle: Lifecycle.ResolutionScoped });
    }

    public bindTransactionClient(prisma: ExtendedPrismaClient | TransactionClient): this {
        return _.assign(Object.create(this), { db: prisma });
    }
}

export default Service;