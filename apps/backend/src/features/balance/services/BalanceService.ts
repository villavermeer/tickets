import { injectable, inject } from "tsyringe";
import Service from "../../../common/services/Service";
import { ExtendedPrismaClient } from "../../../common/utils/prisma";
import { Context } from "../../../common/utils/context";
import { Balance, BalanceActionType, Role } from "@prisma/client";
import ValidationError from "../../../common/classes/errors/ValidationError";
import EntityNotFoundError from "../../../common/classes/errors/EntityNotFoundError";

export interface IBalanceService {
    getUserBalance(userID: number): Promise<BalanceWithActions>;
    addBalanceAction(userID: number, action: CreateBalanceActionRequest): Promise<BalanceAction>;
    processPayout(userID: number, amount: number, reference?: string): Promise<BalanceAction>;
    processCorrection(userID: number, amount: number, reference?: string): Promise<BalanceAction>;
    getBalanceActions(userID: number, limit?: number, offset?: number): Promise<BalanceAction[]>;
    getBalanceHistory(userID: number, startDate?: Date, endDate?: Date): Promise<BalanceAction[]>;
}

export interface CreateBalanceActionRequest {
    type: BalanceActionType;
    amount: number;
    reference?: string;
}

export interface BalanceWithActions {
    id: number;
    userID: number;
    balance: number;
    actions: BalanceAction[];
    created: Date;
    updated: Date;
}

export interface BalanceAction {
    id: number;
    balanceID: number;
    type: BalanceActionType;
    amount: number;
    reference?: string;
    created: Date;
    updated: Date;
}

@injectable()
export class BalanceService extends Service implements IBalanceService {
    constructor(@inject("Database") protected db: ExtendedPrismaClient) {
        super();
    }

    public async getUserBalance(userID: number): Promise<BalanceWithActions> {

        console.log(':)')
        
        const balance = await this.db.balance.findUnique({
            where: { userID },
            include: {
                actions: {
                    orderBy: { created: 'desc' },
                    take: 10
                }
            }
        });

        if (!balance) {
            // Create balance if it doesn't exist
            return await this.createInitialBalance(userID);
        }

        return this.formatBalance(balance);
    }

    public async addBalanceAction(userID: number, action: CreateBalanceActionRequest): Promise<BalanceAction> {
        const requestUser = Context.get("user");
        
        // Validate user permissions
        if (requestUser.role === Role.RUNNER && requestUser.id !== userID) {
            throw new ValidationError("Runners can only manage their own balance");
        }

        if (requestUser.role === Role.MANAGER) {
            const isUnderManager = await this.isUserUnderManager(requestUser.id, userID);
            if (!isUnderManager) {
                throw new ValidationError("You can only manage balances of users under your management");
            }
        }

        // Get or create balance
        let balance = await this.db.balance.findUnique({
            where: { userID }
        });

        if (!balance) {
            balance = await this.createInitialBalanceRecord(userID);
        }

        // Create balance action
        const balanceAction = await this.db.balanceAction.create({
            data: {
                balanceID: balance.id,
                type: action.type,
                amount: action.amount,
                reference: action.reference
            }
        });

        // Update balance based on action type
        await this.updateBalance(balance.id, action.type, action.amount);

        return this.formatBalanceAction(balanceAction);
    }

    public async processPayout(userID: number, amount: number, reference?: string): Promise<BalanceAction> {
        if (amount <= 0) {
            throw new ValidationError("Payout amount must be positive");
        }

        const balance = await this.db.balance.findUnique({
            where: { userID }
        });

        if (!balance || balance.balance < amount) {
            throw new ValidationError("Insufficient balance for payout");
        }

        return await this.addBalanceAction(userID, {
            type: BalanceActionType.PAYOUT,
            amount: -amount, // Negative for payouts
            reference
        });
    }

    public async processCorrection(userID: number, amount: number, reference?: string): Promise<BalanceAction> {
        if (amount === 0) {
            throw new ValidationError("Correction amount cannot be zero");
        }

        return await this.addBalanceAction(userID, {
            type: BalanceActionType.CORRECTION,
            amount,
            reference
        });
    }

    public async getBalanceActions(userID: number, limit: number = 50, offset: number = 0): Promise<BalanceAction[]> {
        const actions = await this.db.balanceAction.findMany({
            where: {
                balance: { userID }
            },
            orderBy: { created: 'desc' },
            take: limit,
            skip: offset
        });

        return actions.map(action => this.formatBalanceAction(action));
    }

    public async getBalanceHistory(userID: number, startDate?: Date, endDate?: Date): Promise<BalanceAction[]> {
        const where: any = {
            balance: { userID }
        };

        if (startDate || endDate) {
            where.created = {};
            if (startDate) where.created.gte = startDate;
            if (endDate) where.created.lte = endDate;
        }

        const actions = await this.db.balanceAction.findMany({
            where,
            orderBy: { created: 'asc' }
        });

        return actions.map(action => this.formatBalanceAction(action));
    }

    private async createInitialBalance(userID: number): Promise<BalanceWithActions> {
        const balance = await this.createInitialBalanceRecord(userID);
        return {
            id: balance.id,
            userID: balance.userID,
            balance: balance.balance,
            actions: [],
            created: balance.created,
            updated: balance.updated
        };
    }

    private async createInitialBalanceRecord(userID: number) {
        return await this.db.balance.create({
            data: {
                userID,
                balance: 0
            }
        });
    }

    private async updateBalance(balanceID: number, actionType: BalanceActionType, amount: number): Promise<void> {
        const updateData: any = {};

        switch (actionType) {
            case BalanceActionType.PAYOUT:
                updateData.balance = { decrement: Math.abs(amount) };
                break;
            case BalanceActionType.CORRECTION:
                updateData.balance = { increment: amount };
                break;
            case BalanceActionType.TICKET_SALE:
                updateData.balance = { increment: amount };
                break;
        }

        await this.db.balance.update({
            where: { id: balanceID },
            data: updateData
        });
    }

    private async isUserUnderManager(managerID: number, userID: number): Promise<boolean> {
        const relation = await this.db.managerRunner.findFirst({
            where: {
                managerID,
                runnerID: userID
            }
        });
        return !!relation;
    }

    private formatBalance(balance: any): BalanceWithActions {
        return {
            id: balance.id,
            userID: balance.userID,
            balance: balance.balance,
            actions: balance.actions.map((action: any) => this.formatBalanceAction(action)),
            created: balance.created,
            updated: balance.updated
        };
    }

    private formatBalanceAction(action: any): BalanceAction {
        return {
            id: action.id,
            balanceID: action.balanceID,
            type: action.type,
            amount: action.amount,
            reference: action.reference,
            created: action.created,
            updated: action.updated
        };
    }
}

BalanceService.register("BalanceService");
