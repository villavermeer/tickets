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
import { RaffleService } from "../../raffle/services/RaffleService";
import { DateTime } from "luxon";

export interface IUserService {
    find(id: number): Promise<UserInterface>;
    current(): Promise<UserInterface>;
    update(data: Partial<ManageUserRequest> & { id: number }): Promise<UserInterface>;
    delete(id: number): Promise<void>;
}

type RequestUser = { id: number; role: Role };

@singleton()
export class UserService extends Service implements IUserService {

    constructor(
        @inject("Database") protected db: ExtendedPrismaClient,
        @inject("RaffleService") protected raffleService: RaffleService,
    ) {
        super()
    }

    private async distinctRunnerTicketDays(runnerId: number): Promise<Date[]> {
        const tickets = await this.db.ticket.findMany({
            where: { creatorID: runnerId },
            select: { created: true },
        });
        const keys = new Set<string>();
        const dates: Date[] = [];
        for (const t of tickets) {
            const key = DateTime.fromJSDate(t.created).setZone("Europe/Amsterdam").toISODate();
            if (!key || keys.has(key)) {
                continue;
            }
            keys.add(key);
            dates.push(DateTime.fromISO(key, { zone: "Europe/Amsterdam" }).startOf("day").toJSDate());
        }
        return dates;
    }

    private async reconcileManagerProvisionForManagers(managerIds: number[], runnerId: number): Promise<void> {
        if (managerIds.length === 0) {
            return;
        }
        const days = await this.distinctRunnerTicketDays(runnerId);
        for (const managerId of managerIds) {
            for (const d of days) {
                await this.raffleService.updateManagerProvision(managerId, d);
            }
        }
    }

    private async syncRunnerManagerRelation(
        runnerId: number,
        managerID: number | null | undefined,
        requestUser: RequestUser
    ): Promise<void> {
        if (managerID === undefined) {
            return;
        }

        if (requestUser.role === Role.RUNNER) {
            throw new ValidationError("Je kunt de manager-koppeling niet zelf wijzigen");
        }

        let effectiveManagerId: number | null = managerID;

        if (requestUser.role === Role.MANAGER) {
            if (managerID !== null && managerID !== requestUser.id) {
                throw new ValidationError("Je kunt je lopers alleen aan jezelf als manager koppelen");
            }
            if (managerID !== null) {
                effectiveManagerId = requestUser.id;
            }
        }

        if (effectiveManagerId !== null) {
            const mgr = await this.db.user.findFirst({
                where: { id: effectiveManagerId, role: Role.MANAGER },
            });
            if (!mgr) {
                throw new ValidationError("Ongeldige manager");
            }
        }

        const existing = await this.db.managerRunner.findMany({
            where: { runnerID: runnerId },
            select: { managerID: true },
        });
        const oldManagerIds = [...new Set(existing.map((e) => e.managerID))];

        await this.db.managerRunner.deleteMany({ where: { runnerID: runnerId } });

        if (effectiveManagerId !== null) {
            await this.db.managerRunner.create({
                data: { managerID: effectiveManagerId, runnerID: runnerId },
            });
        }

        const newManagerIds = effectiveManagerId !== null ? [effectiveManagerId] : [];
        const affected = [...new Set([...oldManagerIds, ...newManagerIds])];
        await this.reconcileManagerProvisionForManagers(affected, runnerId);
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

        const requestUser = Context.get("user") as RequestUser;

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

        if (updatedUser.role === Role.RUNNER && "managerID" in data) {
            await this.syncRunnerManagerRelation(updatedUser.id, data.managerID, requestUser);
        }

        await this.deleteFromCache(`users:${data.id}`);

        const refreshed = await this.db.user.findFirst({
            where: { id: data.id },
            select: UserMapper.getSelectableFields(),
        });

        if (!refreshed) {
            throw new EntityNotFoundError("User");
        }

        return UserMapper.format(refreshed);
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