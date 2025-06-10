import "reflect-metadata";
import path from "path";
import {container} from "tsyringe";
import {glob} from "glob";
import prisma, {ExtendedPrismaClient} from "./prisma";
import RedisClient from "../classes/cache/RedisClient";
import {ROOTDIR} from "../../index";
import _ from "lodash";

/**
 * Auto-register all classes in the specified directories into the DI container
 */
export const autoRegisterServices = async (): Promise<void> => {
    const BASE_DIR = path.resolve(ROOTDIR, "features");

    container.registerInstance<ExtendedPrismaClient>("Database", prisma);

    container.registerSingleton<RedisClient>("Redis", RedisClient);

    const folders = [
        "services",
        "services/*",
        "controllers",
        "mappers",
        "sockets",
        "jobs",
        "queues",
        "workers",
        "routes",
        "router"
    ];

    for (const folder of folders) {
        const pattern = path.join(BASE_DIR, `**/${folder}/*.js`);
        const files = await glob(pattern);

        for (const file of files) {
            try {
                const requiredModule = await import(file);
                Object.keys(requiredModule).forEach((exportedKey) => {
                    const exportedClass = requiredModule[exportedKey];
                    if (typeof exportedClass === "function" && _.isFunction(exportedClass.register)) {
                        exportedClass.register();
                    }
                });
            } catch (error) {
                console.error(`Failed to register class from "${file}":`, error);
            }
        }
    }

    // Explicitly register MainRouter last
    const { default: MainRouter } = await import("../routes/MainRouter");
    MainRouter.register();
};

export { container };