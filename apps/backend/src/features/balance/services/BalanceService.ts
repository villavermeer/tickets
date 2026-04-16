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
    processPayout(userID: number, amount: number, reference?: string, created?: Date): Promise<BalanceAction>;
    processCorrection(userID: number, amount: number, reference?: string, created?: Date): Promise<BalanceAction>;
    getBalanceActions(userID: number, limit?: number, offset?: number): Promise<BalanceAction[]>;
    getBalanceHistory(userID: number, startDate?: Date, endDate?: Date): Promise<BalanceAction[]>;
    getFrozenBalance(userID: number, date: Date): Promise<number | null>;
    updateBalanceAction(actionID: number, updates: Partial<CreateBalanceActionRequest>): Promise<BalanceAction>;
    deleteBalanceAction(actionID: number): Promise<void>;
}

export interface CreateBalanceActionRequest {
    type: BalanceActionType;
    amount: number;
    reference?: string;
    created?: Date;
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
                reference: action.reference,
                created: action.created ? new Date(action.created) : undefined,
            }
        });

        // Update balance based on action type
        await this.updateBalance(balance.id, action.type, action.amount);

        return this.formatBalanceAction(balanceAction);
    }

    public async processPayout(userID: number, amount: number, reference?: string, created?: Date): Promise<BalanceAction> {
        // Allow both positive and negative payouts
        // Positive payout = money going out (decrease balance)
        // Negative payout = money coming in (increase balance)
        const payoutAmount = amount > 0 ? -amount : amount;

        const balance = await this.db.balance.findUnique({
            where: { userID }
        });

        if (!balance) {
            throw new ValidationError("User balance not found");
        }

        // Check if payout would result in negative balance (only for positive payouts)
        if (amount > 0 && balance.balance < amount) {
            throw new ValidationError("Insufficient balance for payout");
        }

        return await this.addBalanceAction(userID, {
            type: BalanceActionType.PAYOUT,
            amount: payoutAmount,
            reference,
            created: created ? new Date(created) : undefined,
        });
    }

    public async processCorrection(userID: number, amount: number, reference?: string, created?: Date): Promise<BalanceAction> {
        // Correction should add/subtract from balance, not set to absolute amount
        // Get or create balance
        let balance = await this.db.balance.findUnique({ where: { userID } });
        if (!balance) {
            balance = await this.createInitialBalanceRecord(userID);
        }

        // Create balance action with the correction amount (can be positive or negative)
        const balanceAction = await this.db.balanceAction.create({
            data: {
                balanceID: balance.id,
                type: BalanceActionType.CORRECTION,
                amount: amount, // amount can be positive or negative
                reference,
                created: created ? new Date(created) : undefined,
            }
        });

        // Update balance by adding the correction amount
        await this.db.balance.update({
            where: { id: balance.id },
            data: { 
                balance: { increment: amount }
            }
        });

        return this.formatBalanceAction(balanceAction);
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

    public async getFrozenBalance(userID: number, date: Date): Promise<number | null> {
        const frozen = await this.db.frozenBalance.findUnique({
            where: { userID_date: { userID, date } }
        });
        return frozen?.balance ?? null;
    }

    public async updateBalanceAction(actionID: number, updates: Partial<CreateBalanceActionRequest>): Promise<BalanceAction> {
        const requestUser = Context.get("user");
        
        // Get the existing action
        const existingAction = await this.db.balanceAction.findUnique({
            where: { id: actionID },
            include: { balance: true }
        });

        if (!existingAction) {
            throw new EntityNotFoundError("Balance action not found");
        }

        // Validate user permissions
        if (requestUser.role === Role.RUNNER && requestUser.id !== existingAction.balance.userID) {
            throw new ValidationError("Runners can only manage their own balance actions");
        }

        if (requestUser.role === Role.MANAGER) {
            const isUnderManager = await this.isUserUnderManager(requestUser.id, existingAction.balance.userID);
            if (!isUnderManager) {
                throw new ValidationError("You can only manage balance actions of users under your management");
            }
        }

        // Ledger entries are append-only. We do not mutate an existing action row.
        if (updates.type && updates.type !== existingAction.type) {
            throw new ValidationError("Changing action type is not allowed. Create a new action instead.");
        }

        if (updates.created && new Date(updates.created).getTime() !== existingAction.created.getTime()) {
            throw new ValidationError("Changing action date is not allowed. Create a new action instead.");
        }

        if (updates.reference !== undefined && updates.reference !== existingAction.reference) {
            throw new ValidationError("Changing action reference is not allowed. Create a new action instead.");
        }

        const nextAmount = updates.amount ?? existingAction.amount;
        const amountDifference = nextAmount - existingAction.amount;

        // If amount is unchanged, return original action as-is.
        if (amountDifference === 0) {
            return this.formatBalanceAction(existingAction);
        }

        // Record only the delta as a new correction action.
        const adjustmentReference = `ADJUST_ACTION:${existingAction.id}:${Date.now()}`;
        const adjustmentAction = await this.db.balanceAction.create({
            data: {
                balanceID: existingAction.balanceID,
                type: BalanceActionType.CORRECTION,
                amount: amountDifference,
                reference: adjustmentReference,
            }
        });

        await this.db.balance.update({
            where: { id: existingAction.balanceID },
            data: { balance: { increment: amountDifference } }
        });

        return this.formatBalanceAction(adjustmentAction);
    }

    public async deleteBalanceAction(actionID: number): Promise<void> {
        const requestUser = Context.get("user");
        
        // Get the existing action
        const existingAction = await this.db.balanceAction.findUnique({
            where: { id: actionID },
            include: { balance: true }
        });

        if (!existingAction) {
            throw new EntityNotFoundError("Balance action not found");
        }

        // Validate user permissions
        if (requestUser.role === Role.RUNNER && requestUser.id !== existingAction.balance.userID) {
            throw new ValidationError("Runners can only manage their own balance actions");
        }

        if (requestUser.role === Role.MANAGER) {
            const isUnderManager = await this.isUserUnderManager(requestUser.id, existingAction.balance.userID);
            if (!isUnderManager) {
                throw new ValidationError("You can only manage balance actions of users under your management");
            }
        }

        // Append a reversal action instead of deleting historical data.
        const reversalAmount = -existingAction.amount;
        await this.db.$transaction(async (tx) => {
            await tx.balanceAction.create({
                data: {
                    balanceID: existingAction.balanceID,
                    type: BalanceActionType.CORRECTION,
                    amount: reversalAmount,
                    reference: `REVERSAL:${existingAction.id}:${Date.now()}`,
                }
            });

            await tx.balance.update({
                where: { id: existingAction.balanceID },
                data: { balance: { increment: reversalAmount } }
            });
        });
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
            case BalanceActionType.PRIZE:
                updateData.balance = { increment: Math.abs(amount) };
                break;
            case BalanceActionType.PROVISION:
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
