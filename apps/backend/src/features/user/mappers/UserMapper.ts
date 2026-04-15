import {Prisma, Role, User} from "@prisma/client";
import {UserInterface} from "../types";

export type SelectableUserFields = Prisma.UserGetPayload<{
    select: ReturnType<typeof UserMapper.getSelectableFields>
}>;

export class UserMapper {

    public static getSelectableFields(): Prisma.UserSelect {
        const core: Prisma.UserSelect = {
            id: true,
            role: true,
            name: true,
            username: true,
            commission: true,
        };
        return {
            ...core,
            runners: {
                select: {
                    runner: { select: { ...core } },
                },
            },
            manager: {
                select: {
                    manager: { select: { ...core } },
                },
            },
        };
    }

    public static format(user: any): UserInterface {
        const runnersFormatted: UserInterface[] = (() => {
            if (!user.runners || !Array.isArray(user.runners)) {
                return [];
            }
            return user.runners
                .map((row: { runner?: any }) => (row.runner ? UserMapper.format(row.runner) : null))
                .filter(Boolean) as UserInterface[];
        })();

        const managerFormatted: UserInterface | null = (() => {
            const m = user.manager;
            if (!m || !Array.isArray(m) || m.length === 0) {
                return null;
            }
            const row = m[0] as { manager?: any };
            return row.manager ? UserMapper.format(row.manager) : null;
        })();

        return {
            id: user.id ?? '',
            name: user.name ?? '',
            role: user.role ?? '',
            username: user.username ?? '',
            commission: user.commission ?? 0,
            runners: runnersFormatted,
            manager: managerFormatted,
        };
    }

    public static formatMany(users: User[]): UserInterface[] {
        return users.map(user => UserMapper.format(user));
    }
}