import { Prisma, Ticket } from "@prisma/client";
import Service from "../../../common/services/Service";
import { container, injectable } from "tsyringe";
import { UserMapper } from "../../user/mappers/UserMapper";
import { CreateTicketRequest } from "../types/requests";
import { ExtendedPrismaClient } from "../../../common/utils/prisma";
import { IGameService } from "../../game/services/GameService";
import ValidationError from "../../../common/classes/errors/ValidationError";
import { TicketMapper } from "../mappers/TicketMapper";
import { TicketInterface, UpdateTicketRequest, ExportTicketRequest } from "@tickets/types";
import ExcelJS from "exceljs";
import _ from "lodash";
import { v4 } from "uuid";
import { Context } from "../../../common/utils/context";

export interface ITicketService {
    all(start: string, end: string, managerID?: string, runnerID?: string): Promise<TicketInterface[]>;
    runner(runnerID: number, date?: Date): Promise<TicketInterface[]>;
    manager(managerID: number): Promise<TicketInterface[]>;
    raffle(raffleID: number, start?: string, end?: string): Promise<TicketInterface[]>;
    create(data: CreateTicketRequest): Promise<Ticket | null>;
    update(id: number, data: UpdateTicketRequest): Promise<Ticket | null>;
    export(data: ExportTicketRequest): Promise<ExcelJS.Buffer>;
    delete(id: number): Promise<void>;
}

@injectable()
export class TicketService extends Service implements ITicketService {

    public all = async (start: string, end: string, managerID?: string, runnerID?: string): Promise<TicketInterface[]> => {
        const startDate = new Date(start);
        const endDate = new Date(end);

        // Get the current user's details
        const user = Context.get("user");

        if (user.role === 'MANAGER' && !managerID) {
            managerID = user.id.toString();
        }

        const whereClause: Prisma.TicketWhereInput = {
            created: {
                gte: startDate,
                lte: endDate
            }
        };

        // Role-based filtering
        if (user.role === 'RUNNER') {
            // Runners can only see their own tickets
            whereClause.creatorID = user.id;
        } else {
            // For managers or other roles, apply filters based on managerID or runnerID
            if (managerID) {
                whereClause.creatorID = Number(managerID)
            }
            if (runnerID) {
                whereClause.creatorID = Number(runnerID);
            }
        }

        console.log(JSON.stringify(whereClause, null, 2))

        // Fetch the tickets from the database
        const tickets = await this.db.ticket.findMany({
            select: TicketMapper.getSelectableFields(),
            orderBy: { created: 'desc' },
            where: whereClause
        });

        // Format and return the results
        return tickets.map(TicketMapper.format);
    }

    public raffle = async (raffleID: number, start?: string, end?: string): Promise<TicketInterface[]> => {
        const whereClause: any = {
            raffleID: raffleID,
        };

        if (start || end) {
            whereClause.created = {};
            if (start) {
                whereClause.created.gte = new Date(start);
            }
            if (end) {
                whereClause.created.lte = new Date(end);
            }
        }

        const tickets = await this.db.ticket.findMany({
            where: whereClause,
            select: TicketMapper.getSelectableFields(),
        });

        return tickets.map(TicketMapper.format);
    };

    public async create(data: CreateTicketRequest): Promise<Ticket | null> {

        console.log(data.codes);

        const ticket = await this.db.ticket.create({
            data: {
                name: data.name,
                creatorID: data.runnerID,
                codes: {
                    create: data.codes.map((code) => ({ 
                        code: code.code,
                        value: parseInt(code.value.toString(), 10),
                    })),
                },
            },
        });

        for (let game of data.games) {
            await this.db.ticketGame.create({
                data: {
                    ticketID: ticket.id,
                    gameID: game,
                },
            });
        }

        return ticket;
    }

    public update = async (id: number, data: UpdateTicketRequest): Promise<Ticket | null> => {
        const ticket = await this.db.ticket.update({
            where: {
                id
            },
            data: {
                name: data.name,
                codes: {
                    deleteMany: {},
                    create: data.codes.map((code) => ({
                        code: code.code.toString(),
                        value: parseInt(code.value.toString(), 10),
                    })),
                },
            },
        });

        return ticket;
    }

    public runner = async (runnerID: number, date?: Date): Promise<TicketInterface[]> => {

        if (!date) {
            date = new Date();
        }

        const startOfDay = new Date(date.getTime());
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date.getTime());
        endOfDay.setHours(23, 59, 59, 999);

        const tickets = await this.db.ticket.findMany({
            select: TicketMapper.getSelectableFields(),
            where: {
                creatorID: runnerID,
                created: {
                    gte: startOfDay,
                    lte: endOfDay
                }
            },
            orderBy: {
                created: 'desc'
            }
        });

        return tickets.map(TicketMapper.format);
    }

    public manager = async (managerID: number): Promise<TicketInterface[]> => {
        console.log(`[TicketService] Fetching tickets for manager ID: ${managerID}`);

        // Step 1: Get runners managed by this manager
        const managerRunners = await this.db.managerRunner.findMany({
            where: {
                managerID: managerID
            },
            select: {
                runnerID: true
            }
        });

        console.log(`[TicketService] Found ${managerRunners.length} runners for manager`);

        // Step 2: Extract runner IDs
        const runnerIDs = managerRunners.map((mr) => mr.runnerID);
        console.log(`[TicketService] Runner IDs: ${runnerIDs.join(', ')}`);

        // If there are no runners, return an empty array
        if (runnerIDs.length === 0) {
            console.log('[TicketService] No runners found, returning empty array');
            return [];
        }

        // Step 3: Query tickets with those runnerIDs
        const tickets = await this.db.ticket.findMany({
            select: TicketMapper.getSelectableFields(),
            where: {
                creatorID: {
                    in: runnerIDs
                }
            },
            orderBy: {
                created: 'desc'
            }
        });
        console.log(`[TicketService] Found ${tickets.length} tickets for runners`);

        return tickets.map(TicketMapper.format);
    }

    public export = async (data: ExportTicketRequest): Promise<ExcelJS.Buffer> => {
        const tickets = await this.all(data.startDate, data.endDate);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Tickets');

        worksheet.addRow([
            "Datum", 'Uniek nummer', 'Naam klant', 'Naam loper', 'Naam manager',
            'Trekking', 'Nummer', 'Inleg', 'Tijd indienen ticket'
        ]);

        for (let ticket of tickets) {
            let runnerName = '-';
            let managerName = '-';

            if (ticket.creator.role === 'MANAGER') {
                managerName = ticket.creator.name;
            } else if (ticket.creator.role === 'RUNNER') {
                runnerName = ticket.creator.name;
                const manager = await this.db.managerRunner.findFirst({
                    where: {
                        runnerID: ticket.creator.id
                    },
                    select: {
                        manager: {
                            select: {
                                name: true
                            }
                        }
                    }
                });
                if (manager) {
                    managerName = manager.manager.name;
                }
            }

            console.log('ticket :', JSON.stringify(ticket, null, 2));

            for (let game of ticket.games) {
                console.log('game :', JSON.stringify(game, null, 2));

                for (let code of ticket.codes) {
                    worksheet.addRow([
                        ticket.created.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }),
                        v4(),
                        ticket.name,
                        runnerName,
                        managerName,
                        game.name,
                        code.code,
                        (code.value / 100).toFixed(2).replace('.', ','), // Convert cents to decimal currency and replace dot with comma
                        ticket.created.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })
                    ]);
                }
            }
        }

        // Generate buffer
        const buffer = await workbook.xlsx.writeBuffer();

        return buffer;
    }

    public delete = async (id: number): Promise<void> => {

        // check if the user owns the ticket
        const ticket = await this.db.ticket.findUnique({
            where: { id }
        });

        if (!ticket) {
            throw new ValidationError('Ticket not found');
        }

        if (ticket.creatorID !== Context.get('authID')) {
            throw new ValidationError('You are not allowed to delete this ticket');
        }

        // delete all codes
        await this.db.code.deleteMany({
            where: { ticketID: id }
        });

        // delete all games
        await this.db.ticketGame.deleteMany({
            where: { ticketID: id }
        });

        await this.db.ticket.delete({
            where: { id }
        });
    }
}

TicketService.register()