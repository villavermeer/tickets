import { injectable, inject } from "tsyringe";
import { Request, Response } from "express";
import Controller from "../../../common/controllers/Controller";
import { IBalanceService } from "../services/BalanceService";
import { Context } from "../../../common/utils/context";
import { Role } from "@prisma/client";
import ValidationError from "../../../common/classes/errors/ValidationError";
import { formatSuccessResponse } from "../../../common/utils/responses";
import { ExtendedPrismaClient } from "../../../common/utils/prisma";

export interface IBalanceController {
    getUserBalance(req: Request, res: Response): Promise<void>;
    getBalanceActions(req: Request, res: Response): Promise<void>;
    getBalanceHistory(req: Request, res: Response): Promise<void>;
    processPayout(req: Request, res: Response): Promise<void>;
    processCorrection(req: Request, res: Response): Promise<void>;
    addBalanceAction(req: Request, res: Response): Promise<void>;
}

@injectable()
export class BalanceController extends Controller implements IBalanceController {
    constructor(
        @inject("BalanceService") private balanceService: IBalanceService,
        @inject("Database") private db: ExtendedPrismaClient,
    ) {
        super();
    }

    public getUserBalance = async (req: Request, res: Response): Promise<void> => {
        try {
            const userID = parseInt(req.params.userID);
            const requestUser = Context.get("user");

            // Validate permissions
            if (requestUser.role === Role.RUNNER && requestUser.id !== userID) {
                throw new ValidationError("You can only view your own balance");
            }

            if (requestUser.role === Role.MANAGER) {
                const isUnderManager = await this.isUserUnderManager(requestUser.id, userID);
                if (!isUnderManager) {
                    throw new ValidationError("You can only view balances of users under your management");
                }
            }

            const balance = await this.balanceService.getUserBalance(userID);
            res.status(200).json(formatSuccessResponse('Balance', balance));
        } catch (error) {
            this.handleError(error, req, res);
        }
    };

    public getBalanceActions = async (req: Request, res: Response): Promise<void> => {
        try {
            const userID = parseInt(req.params.userID);
            const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
            const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

            const requestUser = Context.get("user");

            // Validate permissions
            if (requestUser.role === Role.RUNNER && requestUser.id !== userID) {
                throw new ValidationError("You can only view your own balance actions");
            }

            if (requestUser.role === Role.MANAGER) {
                const isUnderManager = await this.isUserUnderManager(requestUser.id, userID);
                if (!isUnderManager) {
                    throw new ValidationError("You can only view balance actions of users under your management");
                }
            }

            const actions = await this.balanceService.getBalanceActions(userID, limit, offset);
            res.status(200).json(formatSuccessResponse('BalanceActions', actions));
        } catch (error) {
            this.handleError(error, req, res);
        }
    };

    public getBalanceHistory = async (req: Request, res: Response): Promise<void> => {
        try {
            const userID = parseInt(req.params.userID);
            const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
            const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

            const requestUser = Context.get("user");

            // Validate permissions
            if (requestUser.role === Role.RUNNER && requestUser.id !== userID) {
                throw new ValidationError("You can only view your own balance history");
            }

            if (requestUser.role === Role.MANAGER) {
                const isUnderManager = await this.isUserUnderManager(requestUser.id, userID);
                if (!isUnderManager) {
                    throw new ValidationError("You can only view balance history of users under your management");
                }
            }

            const history = await this.balanceService.getBalanceHistory(userID, startDate, endDate);
            res.status(200).json(formatSuccessResponse('BalanceHistory', history));
        } catch (error) {
            this.handleError(error, req, res);
        }
    };

    public processPayout = async (req: Request, res: Response): Promise<void> => {
        try {
            const userID = parseInt(req.params.userID);
            const { amount, reference } = req.body;

            if (!amount || amount <= 0) {
                throw new ValidationError("Valid payout amount is required");
            }

            const requestUser = Context.get("user");

            // Validate permissions
            if (requestUser.role === Role.RUNNER) {
                throw new ValidationError("Runners cannot process payouts");
            }

            if (requestUser.role === Role.MANAGER) {
                const isUnderManager = await this.isUserUnderManager(requestUser.id, userID);
                if (!isUnderManager) {
                    throw new ValidationError("You can only process payouts for users under your management");
                }
            }

            const payout = await this.balanceService.processPayout(userID, amount, reference);
            res.status(200).json(formatSuccessResponse('Payout', payout));
        } catch (error) {
            this.handleError(error, req, res);
        }
    };

    public processCorrection = async (req: Request, res: Response): Promise<void> => {
        try {
            const userID = parseInt(req.params.userID);
            const { amount, reference } = req.body;

            if (!amount || amount === 0) {
                throw new ValidationError("Valid correction amount is required");
            }

            const requestUser = Context.get("user");

            // Validate permissions
            if (requestUser.role === Role.MANAGER) {
                const isUnderManager = await this.isUserUnderManager(requestUser.id, userID);
                if (!isUnderManager) {
                    throw new ValidationError("You can only process corrections for users under your management");
                }
            }

            const correction = await this.balanceService.processCorrection(userID, amount, reference);
            res.status(200).json(formatSuccessResponse('Correction', correction));
        } catch (error) {
            this.handleError(error, req, res);
        }
    };

    public addBalanceAction = async (req: Request, res: Response): Promise<void> => {
        try {
            const userID = parseInt(req.params.userID);
            const { type, amount, reference } = req.body;

            if (!type || !amount) {
                throw new ValidationError("Action type and amount are required");
            }

            const requestUser = Context.get("user");

            // Validate permissions
            if (requestUser.role === Role.RUNNER) {
                throw new ValidationError("Runners cannot add balance actions");
            }

            if (requestUser.role === Role.MANAGER) {
                const isUnderManager = await this.isUserUnderManager(requestUser.id, userID);
                if (!isUnderManager) {
                    throw new ValidationError("You can only add balance actions for users under your management");
                }
            }

            const action = await this.balanceService.addBalanceAction(userID, {
                type,
                amount,
                reference
            });
            res.status(200).json(formatSuccessResponse('BalanceAction', action));
        } catch (error) {
            this.handleError(error, req, res);
        }
    };

    private async isUserUnderManager(managerID: number, userID: number): Promise<boolean> {
        const relation = await this.db.managerRunner.findFirst({
            where: { managerID, runnerID: userID },
            select: { id: true }
        });
        return !!relation || managerID === userID; // allow manager to view own balance
    }
}

BalanceController.register("BalanceController");
