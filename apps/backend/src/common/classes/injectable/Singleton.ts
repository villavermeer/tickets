import _ from "lodash";
import {Prisma} from "@prisma/client/extension";
import { container } from "tsyringe";
import TransactionClient = Prisma.TransactionClient;
import { ExtendedPrismaClient } from "../../utils/prisma";
import Cachable from "../cache/Cachable";

export interface ISingletonInterface {
    bindTransactionClient(prisma: ExtendedPrismaClient): this
}

export default class Singleton extends Cachable implements ISingletonInterface {

    public static type = 'singleton'

    static register<T extends new (...args: any[]) => any>(this: T, identifier?: string): void {
        container.register(identifier || this.name, { useClass: this });
    }

    public bindTransactionClient(prisma: ExtendedPrismaClient | TransactionClient): this {
        return _.assign(Object.create(this), { db: prisma });
    }
}