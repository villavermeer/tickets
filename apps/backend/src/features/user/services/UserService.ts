import { singleton } from "tsyringe";
import { inject } from "tsyringe";
import Service from "../../../common/services/Service";
import { ExtendedPrismaClient } from "../../../common/utils/prisma";
import { UserInterface } from "../types";
import EntityNotFoundError from "../../../common/classes/errors/EntityNotFoundError";
import { UserMapper } from "../mappers/UserMapper";
import { Context } from "../../../common/utils/context";

export interface IUserService {
    find(id: number): Promise<UserInterface>;
    current(): Promise<UserInterface>;
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
}

UserService.register("UserService");