import {Prisma, User} from "@prisma/client";
import {UserInterface} from "../types";

export type SelectableUserFields = Prisma.UserGetPayload<{
    select: ReturnType<typeof UserMapper.getSelectableFields>
}>;

export class UserMapper {

    public static getSelectableFields(): Prisma.UserSelect {
        return {
            id: true,
            role: true,
            name: true,
            runners: true,
            manager: true,
            username: true,
            commission: true,
        }
    }

    public static format(user: any): UserInterface {
        return {
            id: user.id ?? '',
            name: user.name ?? '',
            role: user.role ?? '',
            username: user.username ?? '',
            commission: user.commission ?? 0,
            runners: user.runners ? UserMapper.formatMany(user.runners) : [],
            manager: user.manager ? UserMapper.format(user.manager) : null
        };
    }

    public static formatMany(users: User[]): UserInterface[] {
        return users.map(user => UserMapper.format(user));
    }
}