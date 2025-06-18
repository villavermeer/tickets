import { Role, User } from "@prisma/client";
import Service from "../../../common/services/Service";
import { UserMapper } from "../../user/mappers/UserMapper";
import { UserInterface } from "../../user/types";
import { injectable, container } from "tsyringe";
import { Context } from "../../../common/utils/context";
import { IRevenueService, RevenueService } from "../../revenue/services/RevenueService";
import _ from "lodash";

export interface IRunnerService {
    all(): Promise<UserInterface[]>;
    find(id: number): Promise<UserInterface>;
    manager(id: number): Promise<UserInterface[]>;
}

@injectable()
export class RunnerService extends Service implements IRunnerService {

    public find = async (id: number): Promise<UserInterface> => {
        const runner = await this.db.user.findUnique({
            where: {
                id: id,
                role: Role.RUNNER
            }
        });
        return UserMapper.format(runner);
    }

    public all = async (): Promise<UserInterface[]> => {

        const revenueService = container.resolve<IRevenueService>(RevenueService);

        const requestingUser = Context.get('user');

        if (requestingUser?.role === Role.MANAGER) {
            const users = await this.db.user.findMany({
                select: UserMapper.getSelectableFields(),
                where: {
                    role: Role.RUNNER,
                    manager: {
                        some: {
                            managerID: requestingUser.id
                        }
                    }
                }
            }); 
            
            return users.map(user => UserMapper.format(user));
        }

        const users = await this.db.user.findMany({
            select: UserMapper.getSelectableFields(),
            where: {
                role: Role.RUNNER
            }
        }); 
        
        return users.map(user => UserMapper.format(user));
    }

    public manager = async (id: number): Promise<UserInterface[]> => {
        const users = await this.db.user.findMany({
            where: {
                role: Role.RUNNER,
                manager: {
                    some: {
                        managerID: id
                    }
                }   
            }
        });
        return users.map(user => UserMapper.format(user));
    }
}

RunnerService.register()