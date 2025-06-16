import { Role, User } from "@prisma/client";
import Service from "../../../common/services/Service";
import { UserMapper } from "../../user/mappers/UserMapper";
import { UserInterface } from "../../user/types";
import { injectable } from "tsyringe";
import EntityNotFoundError from "../../../common/classes/errors/EntityNotFoundError";

export interface IManagerService {
    all(): Promise<UserInterface[]>;
    find(id: number): Promise<UserInterface>;
}

@injectable()
export class ManagerService extends Service implements IManagerService {
    public all = async (): Promise<UserInterface[]> => {
        const users = await this.db.user.findMany({
            where: {
                role: Role.MANAGER
            },
            orderBy: {
                created: 'desc'
            }
        }); 
        return users.map(user => UserMapper.format(user));
    }

    public find = async (id: number): Promise<UserInterface> => {
        const user = await this.db.user.findUnique({
            select: UserMapper.getSelectableFields(),
            where: { id, role: Role.MANAGER }
        });

        if (!user) {
            throw new EntityNotFoundError('Manager');
        }

        return UserMapper.format(user);
    }
}

ManagerService.register()