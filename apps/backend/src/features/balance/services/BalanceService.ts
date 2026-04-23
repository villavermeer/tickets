import { injectable, inject } from "tsyringe";
import { DateTime } from "luxon";
import Service from "../../../common/services/Service";
import { ExtendedPrismaClient } from "../../../common/utils/prisma";
import { Context } from "../../../common/utils/context";
import { Balance, BalanceActionType, Prisma, Role } from "@prisma/client";
import ValidationError from "../../../common/classes/errors/ValidationError";
import EntityNotFoundError from "../../../common/classes/errors/EntityNotFoundError";

export interface BalanceDayTotalsResult {
    opening: number;
    ticketSale: number;
    correction: number;
    payout: number;
    prize: number;
    provision: number;
    dayNet: number;
    closing: number;
}

export interface IBalanceService {
    getUserBalance(userID: number): Promise<BalanceWithActions>;
    addBalanceAction(userID: number, action: CreateBalanceActionRequest): Promise<BalanceAction>;
    processPayout(userID: number, amount: number, reference?: string, created?: Date): Promise<BalanceAction>;
    processCorrection(userID: number, amount: number, reference?: string, created?: Date): Promise<BalanceAction>;
    getBalanceActions(userID: number, limit?: number, offset?: number): Promise<BalanceAction[]>;
    getBalanceHistory(userID: number, startDate?: Date, endDate?: Date): Promise<BalanceAction[]>;
    getFrozenBalance(userID: number, date: Date): Promise<number | null>;
    getBalanceDayTotals(userID: number, calendarDateYmd: string): Promise<BalanceDayTotalsResult>;
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

interface CachedBalanceDayTotals {
    value: BalanceDayTotalsResult;
    expiresAt: number;
}

@injectable()
export class BalanceService extends Service implements IBalanceService {
    private static readonly DAY_TOTALS_CACHE_TTL_MS = 20_000;
    private static readonly dayTotalsCache = new Map<string, CachedBalanceDayTotals>();

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
        this.invalidateUserDayTotalsCache(userID);

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
        this.invalidateUserDayTotalsCache(userID);

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

    /**
     * Amsterdam calendar day (YYYY-MM-DD) totals for the mobile balance overview.
     * Uses [startOfDay, nextDayStart) UTC bounds so ledger rows cannot fall through cracks at day edges.
     */
    public async getBalanceDayTotals(userID: number, calendarDateYmd: string): Promise<BalanceDayTotalsResult> {
        const parsed = DateTime.fromFormat(calendarDateYmd, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
        if (!parsed.isValid) {
            throw new ValidationError("Invalid date; use YYYY-MM-DD");
        }
        const cached = this.getCachedDayTotals(userID, calendarDateYmd);
        if (cached) return cached;

        const earliestAction = await this.db.balanceAction.findFirst({
            where: { balance: { userID } },
            orderBy: { created: "asc" },
            select: { created: true },
        });
        const earliestTicket = await this.db.ticket.findFirst({
            where: { creatorID: userID },
            orderBy: { created: "asc" },
            select: { created: true },
        });

        const continuityCache = new Map<string, BalanceDayTotalsResult>();
        const earliestActionYmd = earliestAction
            ? DateTime.fromJSDate(earliestAction.created).setZone("Europe/Amsterdam").startOf("day").toFormat("yyyy-MM-dd")
            : null;
        const earliestTicketYmd = earliestTicket
            ? DateTime.fromJSDate(earliestTicket.created).setZone("Europe/Amsterdam").startOf("day").toFormat("yyyy-MM-dd")
            : null;
        const earliestCalendarDateYmd =
            earliestActionYmd && earliestTicketYmd
                ? (earliestActionYmd < earliestTicketYmd ? earliestActionYmd : earliestTicketYmd)
                : (earliestActionYmd ?? earliestTicketYmd);

        return this.computeBalanceDayTotalsWithContinuity(
            userID,
            parsed,
            calendarDateYmd,
            earliestCalendarDateYmd,
            continuityCache
        );
    }

    private async computeBalanceDayTotalsWithContinuity(
        userID: number,
        parsed: DateTime,
        calendarDateYmd: string,
        earliestCalendarDateYmd: string | null,
        cache: Map<string, BalanceDayTotalsResult>
    ): Promise<BalanceDayTotalsResult> {
        const inCallCached = cache.get(calendarDateYmd);
        if (inCallCached) return inCallCached;
        const sharedCached = this.getCachedDayTotals(userID, calendarDateYmd);
        if (sharedCached) {
            cache.set(calendarDateYmd, sharedCached);
            return sharedCached;
        }

        const current = await this.computeBalanceDayTotalsRaw(userID, parsed, calendarDateYmd);

        // Base case: no history, or this is the first ledger day for this user.
        if (!earliestCalendarDateYmd || calendarDateYmd <= earliestCalendarDateYmd) {
            cache.set(calendarDateYmd, current);
            this.setCachedDayTotals(userID, calendarDateYmd, current);
            return current;
        }

        const previousParsed = parsed.minus({ days: 1 });
        const previousCalendarDateYmd = previousParsed.toFormat("yyyy-MM-dd");
        const previous = await this.computeBalanceDayTotalsWithContinuity(
            userID,
            previousParsed,
            previousCalendarDateYmd,
            earliestCalendarDateYmd,
            cache
        );

        if (current.opening === previous.closing) {
            cache.set(calendarDateYmd, current);
            this.setCachedDayTotals(userID, calendarDateYmd, current);
            return current;
        }

        const opening = previous.closing;
        const normalized = {
            ...current,
            opening,
            closing: opening + current.dayNet,
        };
        cache.set(calendarDateYmd, normalized);
        this.setCachedDayTotals(userID, calendarDateYmd, normalized);
        return normalized;
    }

    private async computeBalanceDayTotalsRaw(
        userID: number,
        parsed: DateTime,
        calendarDateYmd: string
    ): Promise<BalanceDayTotalsResult> {
        const dayStartUtc = parsed.startOf("day").toUTC().toJSDate();
        const nextDayStartUtc = parsed.plus({ days: 1 }).startOf("day").toUTC().toJSDate();

        const frozenSnapshotInstant = parsed.minus({ days: 1 }).startOf("day").toUTC().toJSDate();

        let opening: number;
        const frozen = await this.getFrozenBalance(userID, frozenSnapshotInstant);
        if (frozen !== null) {
            opening = frozen;
        } else {
            const priorActions = await this.db.balanceAction.findMany({
                where: {
                    balance: { userID },
                    created: { lt: dayStartUtc },
                },
            });
            opening = priorActions.reduce((sum, a) => sum + a.amount, 0);
        }

        const dayActionsByCreated = await this.db.balanceAction.findMany({
            where: {
                balance: { userID },
                created: {
                    gte: dayStartUtc,
                    lt: nextDayStartUtc,
                },
            },
            orderBy: { created: "asc" },
        });

        /**
         * Also pick up ledger rows tied to tickets whose *business* day in Amsterdam is this date,
         * even when `balance_action.created` falls outside that window (relay timing, adjustments, etc.).
         */
        let ticketRows: Array<{ id: number }> = [];
        try {
            ticketRows = await this.db.$queryRaw<Array<{ id: number }>>(Prisma.sql`
                SELECT id FROM tickets
                WHERE "creatorID" = ${userID}
                AND (timezone('Europe/Amsterdam', created))::date = CAST(${calendarDateYmd} AS DATE)
            `);
        } catch {
            ticketRows = [];
        }

        let attributedByTicketDay: typeof dayActionsByCreated = [];
        if (ticketRows.length > 0) {
            const ticketIds = new Set(ticketRows.map((r) => r.id));
            attributedByTicketDay = await this.db.balanceAction.findMany({
                where: {
                    balance: { userID },
                    OR: [
                        ...ticketRows.map((r) => ({ reference: `TICKET_SALE:${r.id}` })),
                        ...ticketRows.map((r) => ({
                            reference: { startsWith: `TICKET_SALE_ADJUST:${r.id}:` },
                        })),
                        ...ticketRows.map((r) => ({
                            reference: { endsWith: `:TICKET_SALE:${r.id}` },
                        })),
                    ],
                },
                orderBy: { created: "asc" },
            });

            const prizeCandidates = await this.db.balanceAction.findMany({
                where: {
                    balance: { userID },
                    type: BalanceActionType.PRIZE,
                    reference: { startsWith: "PRIZE:" },
                },
                orderBy: { created: "asc" },
            });
            for (const a of prizeCandidates) {
                const parts = (a.reference || "").split(":");
                if (parts.length < 4) continue;
                const ticketId = Number(parts[2]);
                if (Number.isFinite(ticketId) && ticketIds.has(ticketId)) {
                    attributedByTicketDay.push(a);
                }
            }
        }

        const mergedById = new Map<number, (typeof dayActionsByCreated)[number]>();
        for (const a of dayActionsByCreated) {
            mergedById.set(a.id, a);
        }
        for (const a of attributedByTicketDay) {
            mergedById.set(a.id, a);
        }
        const dayActions = [...mergedById.values()];

        let ticketSale = 0;
        let correction = 0;
        let payout = 0;
        let prize = 0;
        let provision = 0;

        for (const a of dayActions) {
            switch (a.type) {
                case BalanceActionType.TICKET_SALE:
                    ticketSale += a.amount;
                    break;
                case BalanceActionType.CORRECTION:
                    correction += a.amount;
                    break;
                case BalanceActionType.PAYOUT:
                    payout += a.amount;
                    break;
                case BalanceActionType.PRIZE:
                    prize += a.amount;
                    break;
                case BalanceActionType.PROVISION:
                    provision += a.amount;
                    break;
                default:
                    break;
            }
        }

        const dayNet = ticketSale + correction + payout + prize + provision;
        const closing = opening + dayNet;

        return {
            opening,
            ticketSale,
            correction,
            payout,
            prize,
            provision,
            dayNet,
            closing,
        };
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
        this.invalidateUserDayTotalsCache(existingAction.balance.userID);

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
        this.invalidateUserDayTotalsCache(existingAction.balance.userID);
    }

    private dayTotalsCacheKey(userID: number, calendarDateYmd: string): string {
        return `${userID}:${calendarDateYmd}`;
    }

    private getCachedDayTotals(userID: number, calendarDateYmd: string): BalanceDayTotalsResult | null {
        const key = this.dayTotalsCacheKey(userID, calendarDateYmd);
        const cached = BalanceService.dayTotalsCache.get(key);
        if (!cached) return null;
        if (cached.expiresAt < Date.now()) {
            BalanceService.dayTotalsCache.delete(key);
            return null;
        }
        return cached.value;
    }

    private setCachedDayTotals(userID: number, calendarDateYmd: string, value: BalanceDayTotalsResult): void {
        const key = this.dayTotalsCacheKey(userID, calendarDateYmd);
        BalanceService.dayTotalsCache.set(key, {
            value,
            expiresAt: Date.now() + BalanceService.DAY_TOTALS_CACHE_TTL_MS,
        });
    }

    private invalidateUserDayTotalsCache(userID: number): void {
        const prefix = `${userID}:`;
        for (const key of BalanceService.dayTotalsCache.keys()) {
            if (key.startsWith(prefix)) {
                BalanceService.dayTotalsCache.delete(key);
            }
        }
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
