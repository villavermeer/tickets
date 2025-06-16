import { singleton } from "tsyringe";
import { inject } from "tsyringe";
import Service from "../../../common/services/Service";
import { ExtendedPrismaClient } from "../../../common/utils/prisma";
import { ManageUserRequest, UserInterface } from "../types";
import EntityNotFoundError from "../../../common/classes/errors/EntityNotFoundError";
import { UserMapper } from "../mappers/UserMapper";
import { Context } from "../../../common/utils/context";
import bcrypt from "bcrypt";
import { Role } from "@prisma/client";
import ValidationError from "../../../common/classes/errors/ValidationError";

export interface IUserService {
    find(id: number): Promise<UserInterface>;
    current(): Promise<UserInterface>;
    update(data: Partial<ManageUserRequest> & { id: number }): Promise<UserInterface>;
    delete(id: number): Promise<void>;
}

@singleton()
export class UserService extends Service implements IUserService {

    constructor(
        @inject("Database") protected db: ExtendedPrismaClient,
    ) {
        super()
    }

    public find = async (id: number): Promise<UserInterface> => {
        const cacheKey = `users:${id}`;

        return await this.withCache(
            cacheKey,
            async () => {
                const user = await this.db.user.findFirst({
                    where: {
                        id: id
                    },
                    select: UserMapper.getSelectableFields()
                });

                if (!user) throw new EntityNotFoundError("User");

                return UserMapper.format(user);
            },
            { ttl: 3600 }
        );
    }

    public current = async (): Promise<UserInterface> => {
        const user = await this.db.user.findUnique({
            where: { id: Context.get('authID') }
        });

        if (!user) {
            throw new EntityNotFoundError("User")
        }

        return UserMapper.format(user);
    }

    public update = async (data: Partial<ManageUserRequest> & { id: number }): Promise<UserInterface> => {
        const user = await this.db.user.findUnique({
            where: { id: data.id }
        });

        if (!user) {
            throw new EntityNotFoundError("User");
        }

        const updatedUser = await this.db.user.update({
            where: { id: data.id },
            data: {
                name: data.name,
                username: data.username,
                password: data.password ? await bcrypt.hash(data.password, 10) : user.password,
                commission: data.commission,
                role: data.role,
            }
        });

        return UserMapper.format(updatedUser);
    }

    public delete = async (id: number): Promise<void> => {

        const requestUser = await Context.get('user');

        const userToDelete = await this.db.user.findUnique({
            where: { id }
        });

        if (!userToDelete) {
            throw new EntityNotFoundError("User");
        }

        if (requestUser.role === Role.RUNNER) {
            throw new ValidationError("Als loper kun je geen gebruikers verwijderen");
        }

        if (requestUser.role === Role.MANAGER && userToDelete.role !== Role.RUNNER) {
            throw new ValidationError("Als manager kun je alleen lopers verwijderen");
        }

        const isManagerRunner = await this.db.managerRunner.findFirst({
            where: {
                managerID: requestUser.id,
                runnerID: userToDelete.id
            }
        });

        if (requestUser.role === Role.MANAGER && !isManagerRunner) {
            throw new ValidationError("Als manager kun je alleen je eigen lopers verwijderen");
        }

        await this.db.user.delete({
            where: { id }
        });
    }
}

UserService.register("UserService");