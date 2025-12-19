import { Prisma, Ticket, BalanceActionType, Role } from "@prisma/client";
import Service from "../../../common/services/Service";
import { inject, injectable, container } from "tsyringe";
import { CreateTicketRequest } from "../types/requests";
import ValidationError from "../../../common/classes/errors/ValidationError";
import { TicketMapper } from "../mappers/TicketMapper";
import { TicketInterface, UpdateTicketRequest, ExportTicketRequest, RelayableTicketOverview, ChunkedRelayableTicket, RelayableTicketEntry } from "@tickets/types";
import ExcelJS from "exceljs";
import _ from "lodash";
import { v4 } from "uuid";
import { Context } from "../../../common/utils/context";
import { DateTime } from "luxon";
import PDFDocument from "pdfkit";
import { IPrizeService } from "../../prize/services/PrizeService";
import { RaffleService } from "../../raffle/services/RaffleService";

export interface ITicketService {
    all(start: string, end: string, managerID?: string, runnerID?: string): Promise<TicketInterface[]>;
    runner(runnerID: number, date?: Date): Promise<TicketInterface[]>;
    manager(managerID: number): Promise<TicketInterface[]>;
    raffle(raffleID: number, start?: string, end?: string): Promise<TicketInterface[]>;
    create(data: CreateTicketRequest): Promise<Ticket | null>;
    update(id: number, data: UpdateTicketRequest): Promise<Ticket | null>;
    export(data: ExportTicketRequest): Promise<ExcelJS.Buffer>;
    getRelayableTickets(start: string, end: string, commit?: boolean, combineAcrossGames?: boolean): Promise<ChunkedRelayableTicket[]>;
    exportRelayableTickets(start: string, end: string, commit?: boolean, combineAcrossGames?: boolean): Promise<ExcelJS.Buffer>;
    exportRelayableTicketsPDF(start: string, end: string, commit?: boolean, compact?: boolean, combineAcrossGames?: boolean): Promise<Buffer>;
    exportRelayableGameTotals(start: string, end: string, commit?: boolean, combineAcrossGames?: boolean): Promise<ExcelJS.Buffer>;
    exportRelayableBalanceSummary(start: string, end: string): Promise<ExcelJS.Buffer>;
    exportRelayablePrizes(start: string, end: string, prizeDate?: string, scopeUserID?: number): Promise<ExcelJS.Buffer>;
    getRelayBatchHistory(): Promise<any[]>;
    undoRelayBatch(batchID: number): Promise<void>;
    delete(id: number): Promise<void>;
}

@injectable()
export class TicketService extends Service implements ITicketService {

    private DAILY_LIMITS = {
        GLOBAL: {
            DEFAULT: {
                4: 1000, // 10 euro total per 4-digit code (non Super4)
                3: 5000  // 50 euro total per 3-digit code (non Super4)
            },
            SUPER4: {
                4: 500,  // 5 euro total per 4-digit code (Super4)
                3: 1000  // 10 euro total per 3-digit code (Super4)
            }
        },
        USER: {
            DEFAULT: {
                4: 500,  // 5 euro per user per 4-digit code (non Super4)
                3: 2500  // 25 euro per user per 3-digit code (non Super4)
            },
            SUPER4: {
                4: 100,  // 1 euro per user per 4-digit code (Super4)
                3: 500   // 5 euro per user per 3-digit code (Super4)
            }
        }
    }

    constructor(
        @inject(RaffleService) protected raffleService: RaffleService
    ) {
        super();
    }

    public all = async (start: string, end: string, managerID?: string, runnerID?: string): Promise<TicketInterface[]> => {
        const startDate = new Date(start);
        const endDate = new Date(end);

        // Set startDate to beginning of the day (00:00:00.000)
        startDate.setUTCHours(0, 0, 0, 0);
        // Set endDate to end of the day (23:59:59.999)
        endDate.setUTCHours(23, 59, 59, 999);

        // Get the current user's details
        const user = Context.get("user");

        if (user.role === 'MANAGER' && !managerID) {
            managerID = user.id.toString();
        }

        const whereClause: Prisma.TicketWhereInput = {
            created: {
                gte: startDate,
                lte: endDate
            },
            codes: {
                some: {
                    ticketID: {
                        not: null
                    },
                    // Exclude tickets that only contain daily codes (for backend processing only)
                    daily: false
                }
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
            // Exclude tickets that only contain daily codes (for backend processing only)
            codes: {
                some: {
                    daily: false
                }
            }
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
        /* -------------------------------------------------------------
        * Calculate the strictest cut-off for the selected games
        * ------------------------------------------------------------ */
        const nowNL = DateTime.now().setZone("Europe/Amsterdam");

        // Load the game names that belong to the ticket
        const games = await this.db.game.findMany({
            where: { id: { in: data.games } },
            select: { id: true, name: true },
        });

        if (games.length !== data.games.length) {
            throw new ValidationError("Er is iets misgegaan bij het aanmaken van het ticket.");
        }

        // Check daily limits for all codes (skip for admin accounts and daily tickets)
        const user = Context.get("user");
        if (user.role !== 'ADMIN' && !data.relayed) {
            await this.checkDailyLimits(data.codes, data.games, data.runnerID, nowNL);
        }

        // Compute the earliest cut-off among all chosen games
        const earliestCutOff = games
            .map((g) => this.getCutOffForGame(g.name, nowNL))
            .reduce((earliest, cur) => (cur < earliest ? cur : earliest));

        if (nowNL >= earliestCutOff) {
            const list = games.map((g) => g.name).join(", ");
            throw new ValidationError(
                `Tickets voor ${list} moeten voor ${earliestCutOff.toFormat("HH:mm")} worden aangemaakt.`
            );
        }

        // Use a transaction to ensure data consistency
        return await this.db.$transaction(async (tx) => {
            const ticket = await tx.ticket.create({
                data: {
                    name: data.name,
                    creatorID: data.runnerID,
                    codes: {
                        create: data.codes.map((code) => ({
                            code: code.code,
                            value: parseInt(code.value.toString(), 10),
                            relayed: data.relayed ? new Date() : null,
                            daily: Boolean(data.relayed), // Mark as daily for Vaste lijst tickets
                        })),
                    },
                },
            });

            // Create all TicketGame records in a single operation to avoid sequence issues
            // Note: The Prisma middleware in prisma.ts automatically creates TICKET_SALE balance actions
            // when TicketGame.createMany is called, so we don't need to call createTicketSaleBalanceAction here
            if (data.games.length > 0) {
                await tx.ticketGame.createMany({
                    data: data.games.map((game) => ({
                        ticketID: ticket.id,
                        gameID: game,
                    })),
                });
            }

            return ticket;
        });
    }

    public update = async (id: number, data: UpdateTicketRequest): Promise<Ticket | null> => {
        // check if the ticket exists
        const ticket = await this.db.ticket.findUnique({
            where: { id }
        });

        if (!ticket) {
            throw new ValidationError('Ticket niet gevonden');
        }

        // check if the ticket was created today (same day editing only) - use Amsterdam timezone
        const nowAmsterdam = DateTime.now().setZone('Europe/Amsterdam');
        const ticketCreatedAmsterdam = DateTime.fromJSDate(ticket.created).setZone('Europe/Amsterdam');

        // Compare the dates in Amsterdam timezone (year-month-day)
        const todayDateStr = nowAmsterdam.toFormat('yyyy-MM-dd');
        const ticketDateStr = ticketCreatedAmsterdam.toFormat('yyyy-MM-dd');

        if (todayDateStr !== ticketDateStr) {
            throw new ValidationError('Tickets kunnen alleen worden bewerkt op dezelfde dag als ze zijn aangemaakt');
        }

        // update the ticket
        const updatedTicket = await this.db.ticket.update({
            where: {
                id
            },
            data: {
                name: data.name,
            },
        });

        // Handle games with smart update to preserve created timestamps
        if (data.games) {
            // Get existing games for this ticket
            const existingGames = await this.db.ticketGame.findMany({
                where: { ticketID: id },
                select: { id: true, gameID: true, created: true }
            });

            // Find games to delete (existing but not in new data)
            const gamesToDelete = existingGames.filter(eg =>
                !data.games.includes(eg.gameID)
            );

            // Find games to create (in new data but not existing)
            const gamesToCreate = data.games.filter(gameId =>
                !existingGames.some(eg => eg.gameID === gameId)
            );

            // Delete removed games
            if (gamesToDelete.length > 0) {
                await this.db.ticketGame.deleteMany({
                    where: { id: { in: gamesToDelete.map(g => g.id) } }
                });
            }

            // Create new games with preserved timestamps using raw SQL
            for (const gameId of gamesToCreate) {
                const now = new Date();
                await this.db.$executeRaw`
                    INSERT INTO ticket_games ("ticketID", "gameID", created, updated)
                    VALUES (${id}, ${gameId}, ${now}, ${now})
                `;
            }
        }

        // Handle codes with smart update to preserve created timestamps
        if (data.codes) {
            // Get existing codes for this ticket
            const existingCodes = await this.db.code.findMany({
                where: { ticketID: id },
                select: { id: true, code: true, value: true, created: true }
            });

            // Find codes to delete (existing but not in new data)
            const codesToDelete = existingCodes.filter(ec =>
                !data.codes.some(newCode =>
                    newCode.code.toString() === ec.code &&
                    parseInt(newCode.value.toString(), 10) === ec.value
                )
            );

            // Find codes to create (in new data but not existing)
            const codesToCreate = data.codes.filter(newCode =>
                !existingCodes.some(ec =>
                    ec.code === newCode.code.toString() &&
                    ec.value === parseInt(newCode.value.toString(), 10)
                )
            );

            // Check daily limits for new codes (only if there are new codes to create)
            // Skip limit check if this ticket already has daily codes (daily tickets don't count towards limits)
            if (codesToCreate.length > 0) {
                // Check if this ticket already has any daily codes
                const hasDailyCodes = await this.db.code.findFirst({
                    where: {
                        ticketID: id,
                        daily: true
                    }
                });

                // Only check limits if this ticket doesn't have daily codes
                if (!hasDailyCodes) {
                    // Get the current games for this ticket (use updated games if provided, otherwise existing)
                    let currentGames = data.games;
                    if (!currentGames) {
                        const existingTicketGames = await this.db.ticketGame.findMany({
                            where: { ticketID: id },
                            select: { gameID: true }
                        });
                        currentGames = existingTicketGames.map(tg => tg.gameID);
                    }

                    const nowNL = DateTime.now().setZone("Europe/Amsterdam");
                    await this.checkDailyLimits(codesToCreate, currentGames, ticket.creatorID, nowNL);
                }
            }

            // Delete removed codes
            if (codesToDelete.length > 0) {
                await this.db.code.deleteMany({
                    where: { id: { in: codesToDelete.map(c => c.id) } }
                });
            }

            // Create new codes with preserved timestamps using raw SQL
            for (const code of codesToCreate) {
                const now = new Date();
                await this.db.$executeRaw`
                    INSERT INTO codes (code, value, "ticketID", created, updated)
                    VALUES (${code.code.toString()}, ${parseInt(code.value.toString(), 10)}, ${id}, ${now}, ${now})
                `;
            }
        }

        // Fetch the updated ticket to return
        const finalTicket = await this.db.ticket.findUnique({
            where: { id },
            include: {
                codes: { select: { value: true } },
                games: { select: { gameID: true } }
            }
        });

        // Update balance action if ticket value changed
        if (finalTicket && (data.games || data.codes)) {
            await this.updateTicketSaleBalanceAction(id, finalTicket.creatorID);
        }

        return finalTicket
    }

    public runner = async (runnerID: number, date?: Date): Promise<TicketInterface[]> => {

        if (!date) {
            date = new Date();
        }

        // Convert to Amsterdam timezone and get day boundaries
        const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
        const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
        const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();

        const tickets = await this.db.ticket.findMany({
            select: TicketMapper.getSelectableFields(),
            where: {
                creatorID: runnerID,
                created: {
                    gte: startOfDay,
                    lte: endOfDay
                },
                // Exclude tickets that only contain daily codes (for backend processing only)
                codes: {
                    some: {
                        daily: false
                    }
                }
            },
            orderBy: {
                created: 'desc'
            }
        });

        return tickets.map(TicketMapper.format);
    }

    public manager = async (managerID: number): Promise<TicketInterface[]> => {

        // Step 1: Get runners managed by this manager
        const managerRunners = await this.db.managerRunner.findMany({
            where: {
                managerID: managerID
            },
            select: {
                runnerID: true
            }
        });


        // Step 2: Extract runner IDs
        const runnerIDs = managerRunners.map((mr) => mr.runnerID);

        // If there are no runners, return an empty array
        if (runnerIDs.length === 0) {
            return [];
        }

        // Step 3: Query tickets with those runnerIDs
        const tickets = await this.db.ticket.findMany({
            select: TicketMapper.getSelectableFields(),
            where: {
                creatorID: {
                    in: runnerIDs
                },
                // Exclude tickets that only contain daily codes (for backend processing only)
                codes: {
                    some: {
                        daily: false
                    }
                }
            },
            orderBy: {
                created: 'desc'
            }
        });

        return tickets.map(TicketMapper.format);
    }

    public export = async (data: ExportTicketRequest): Promise<ExcelJS.Buffer> => {
        console.debug("Exporting tickets with data:", data);
        const tickets = await this.all(data.startDate, data.endDate);
        console.debug(`Fetched ${tickets.length} tickets for export.`);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Tickets');

        worksheet.addRow([
            "Datum", 'Uniek nummer', 'Naam klant', 'Naam loper', 'Naam manager',
            'Trekking', 'Nummer', 'Inleg', 'Tijd indienen ticket'
        ]);

        // Pre-fetch all manager names for runners to minimize database calls
        const runnerIDs = tickets
            .filter(ticket => ticket.creator.role === 'RUNNER')
            .map(ticket => ticket.creator.id);

        const runnerManagerMap = await this.db.managerRunner.findMany({
            where: {
                runnerID: { in: runnerIDs }
            },
            select: {
                runnerID: true,
                manager: {
                    select: {
                        name: true
                    }
                }
            }
        });

        const managerNameMap = new Map<number, string>();
        runnerManagerMap.forEach(rm => {
            if (rm.manager) {
                managerNameMap.set(rm.runnerID, rm.manager.name);
            }
        });

        tickets.forEach(ticket => {
            console.debug("Processing ticket:", ticket.id);
            let runnerName = '-';
            let managerName = '-';

            if (ticket.creator.role === 'MANAGER') {
                managerName = ticket.creator.name;
            } else if (ticket.creator.role === 'RUNNER') {
                runnerName = ticket.creator.name;
                managerName = managerNameMap.get(ticket.creator.id) || '-';
            }

            ticket.games.forEach(game => {
                console.debug("Processing game:", game.name);
                ticket.codes.forEach(code => {
                    console.debug("Adding row for code:", code.code);
                    worksheet.addRow([
                        ticket.created.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }),
                        v4(),
                        ticket.name,
                        runnerName,
                        managerName,
                        game.name,
                        code.code,
                        (code.value / 100).toFixed(2).replace('.', ','),
                        ticket.created.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })
                    ]);
                });
            });
        });

        // Generate buffer
        const buffer = await workbook.xlsx.writeBuffer();
        console.debug("Export buffer generated successfully.");

        return buffer;
    }

    public exportRelayableTickets = async (start: string, end: string, commit?: boolean, combineAcrossGames?: boolean): Promise<ExcelJS.Buffer> => {
        console.debug("Exporting relayable tickets with data:", { start, end, commit });
        const relayableTickets = await this.getRelayableTickets(start, end, commit, combineAcrossGames);
        console.debug(`Fetched ${relayableTickets.length} relayable ticket combinations for export.`);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Relayable Tickets');

        // Add report header
        worksheet.addRow([]); // Empty row for spacing

        // Style the report header
        const reportHeaderRow = worksheet.getRow(1);
        reportHeaderRow.font = { bold: true, size: 16 };
        reportHeaderRow.alignment = { horizontal: 'center' };

        const periodRow = worksheet.getRow(2);
        periodRow.font = { bold: true, size: 12 };
        periodRow.alignment = { horizontal: 'center' };

        const generatedRow = worksheet.getRow(3);
        generatedRow.font = { size: 10 };
        generatedRow.alignment = { horizontal: 'center' };

        const rulesTitleRow = worksheet.getRow(5);
        rulesTitleRow.font = { bold: true, size: 11 };

        const rulesRows = [6, 7, 8];
        rulesRows.forEach(rowNum => {
            const row = worksheet.getRow(rowNum);
            row.font = { size: 10 };
        });

        // Process each game combination
        relayableTickets.forEach((chunk, idx) => {
            // Add game combination title
            const titleRow = worksheet.addRow([`${chunk.gameCombination.join(', ')}`]);
            titleRow.font = { bold: true, size: 12 };
            titleRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFD3D3D3' }
            };

            // Add summary
            worksheet.addRow([`Total Value: €${(chunk.totalValue / 100).toFixed(2)}`]);
            worksheet.addRow([`Deduction: €${(chunk.deduction / 100).toFixed(2)}`]);
            worksheet.addRow([`Final Value: €${(chunk.finalValue / 100).toFixed(2)}`]);
            worksheet.addRow([`Number of Codes: ${chunk.entries.length}`]);
            worksheet.addRow([]); // Empty row for spacing

            // Add table header
            const tableHeaderRow = worksheet.addRow(['Code', 'Value (€)', 'Final Value (€)']);
            tableHeaderRow.font = { bold: true };
            tableHeaderRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFE0E0E0' }
            };

            // Add table data (only code, value, and final value - no deduction)
            chunk.entries.forEach((entry: RelayableTicketEntry) => {
                const row = worksheet.addRow([
                    entry.code,
                    (entry.value / 100).toFixed(2),
                    (entry.final / 100).toFixed(2)
                ]);

                // Apply special styling for "Vaste lijst" row
                if (entry.code === 'Vaste lijst') {
                    row.font = { italic: true };
                    row.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'FFFFF4CC' } // Light yellow background
                    };
                }
            });

            worksheet.addRow([]); // Empty row for spacing between game combinations
        });

        // Add daily tickets summary at the bottom
        const startDate = this.parseDateParameter(start, true);
        const endDate = this.parseDateParameter(end, false);
        const amsterdamStart = DateTime.fromJSDate(startDate).setZone('Europe/Amsterdam');
        const dayStart = amsterdamStart.startOf('day').toUTC().toJSDate();
        const dayEnd = amsterdamStart.endOf('day').toUTC().toJSDate();

        const dailyCodesForDisplay = await this.getDailyCodesForDisplay(dayStart, dayEnd);

        if (dailyCodesForDisplay.length > 0) {
            // Group codes by game
            const codesByGame = new Map<number, typeof dailyCodesForDisplay>();
            for (const code of dailyCodesForDisplay) {
                if (!codesByGame.has(code.gameID)) {
                    codesByGame.set(code.gameID, []);
                }
                codesByGame.get(code.gameID)!.push(code);
            }

            // Add spacing before daily summary
            worksheet.addRow([]);
            worksheet.addRow([]);

            // Add main header
            const headerRow = worksheet.addRow(['', '', 'Gespeelde daglijkse tickets']);
            headerRow.font = { bold: true };
            headerRow.alignment = { horizontal: 'center' };
            worksheet.mergeCells(`C${headerRow.number}:E${headerRow.number}`);

            let grandTotal = 0;

            // Process each game group
            for (const [gameID, codes] of codesByGame) {
                const gameName = codes[0].gameName;

                // Add game header
                const gameHeaderRow = worksheet.addRow(['', gameName, '']);
                gameHeaderRow.font = { bold: true };
                gameHeaderRow.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFE8EBED' }
                };

                // Add column headers for this game
                const colHeaderRow = worksheet.addRow(['Code', 'Waarde (€)', 'Eindwaarde (€)']);
                colHeaderRow.font = { bold: true };
                colHeaderRow.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFF2F4F7' }
                };

                let gameTotal = 0;

                // Add individual codes
                for (const code of codes) {
                    const row = worksheet.addRow([
                        code.code,
                        (code.value / 100).toFixed(2),
                        (code.value / 100).toFixed(2)
                    ]);

                    gameTotal += code.value;
                    grandTotal += code.value;
                }

                // Add game total
                const gameTotalRow = worksheet.addRow([
                    `Totaal ${gameName}`,
                    (gameTotal / 100).toFixed(2),
                    (gameTotal / 100).toFixed(2)
                ]);
                gameTotalRow.font = { bold: true };
                gameTotalRow.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFE8EBED' }
                };

                // Add spacing between games
                worksheet.addRow([]);
            }

            // Add grand total if multiple games
            if (codesByGame.size > 1) {
                const totalRow = worksheet.addRow([
                    'Totaal alle daglijkse tickets',
                    (grandTotal / 100).toFixed(2),
                    (grandTotal / 100).toFixed(2)
                ]);
                totalRow.font = { bold: true };
                totalRow.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFD4D4D4' } // Darker gray for grand total
                };
            }
        }

        // Auto-fit columns
        worksheet.columns.forEach(column => {
            column.width = Math.max(
                column.width || 0,
                Math.max(...column.values?.map(v => String(v).length) || [0])
            );
        });

        // Generate buffer
        console.log('About to generate Excel buffer...');
        const buffer = await workbook.xlsx.writeBuffer();
        console.log('Excel buffer generated successfully. Buffer type:', typeof buffer);
        console.log('Buffer constructor:', buffer.constructor.name);
        console.log('Buffer properties:', Object.keys(buffer));
        console.log('Buffer length property:', (buffer as any).length);
        console.debug("Relayable tickets export buffer generated successfully.");

        return buffer;
    }

    public exportRelayableTicketsPDF = async (
        start: string,
        end: string,
        commit?: boolean,
        _compact?: boolean,
        combineAcrossGames?: boolean
    ): Promise<Buffer> => {
        console.debug("Exporting relayable tickets to PDF with data:", { start, end, commit });
        const relayableTickets = await this.getRelayableTickets(start, end, commit, combineAcrossGames);
        console.debug(`Fetched ${relayableTickets.length} relayable ticket combinations for PDF export.`);

        // Daily tickets (vaste nummers)
        const startDate = this.parseDateParameter(start, true);
        const endDate = this.parseDateParameter(end, false);
        const amsterdamStart = DateTime.fromJSDate(startDate).setZone('Europe/Amsterdam');
        const dayStart = amsterdamStart.startOf('day').toUTC().toJSDate();
        const dayEnd = amsterdamStart.endOf('day').toUTC().toJSDate();
        const dailyCodesForDisplay = await this.getDailyCodesForDisplay(dayStart, dayEnd);

        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({
                size: 'A4',
                margins: { top: 40, bottom: 40, left: 40, right: 40 }
            });

            const chunks: Buffer[] = [];
            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const left = doc.page.margins.left;
            const top = doc.page.margins.top;
            const right = doc.page.width - doc.page.margins.right;
            const usableWidth = right - left;
            const bottomLimit = doc.page.height - doc.page.margins.bottom;

            const rowHeight = 20;
            const titleHeight = 18;

            // 1 column for code/description, 1 for amount
            // Use a compact fixed table width so the table is only as wide
            // as needed for the code and value, instead of stretching full-page.
            const codeColWidth = 100;
            const amountColWidth = 100;
            const tableWidth = codeColWidth + amountColWidth;

            let y = top;
            let isFirstSection = true;

            const drawTableHeader = (firstColLabel: string) => {
                doc.save();
                doc.rect(left, y, tableWidth, rowHeight).fill('#f2f4f7');
                doc.fillColor('#000000');
                doc.font('Helvetica-Bold').fontSize(11);
                doc.text(firstColLabel, left + 8, y + 4, { width: codeColWidth - 16 });
                doc.text('Bedrag', left + codeColWidth, y + 4, {
                    width: amountColWidth - 16,
                    align: 'right'
                });
                doc.restore();
                y += rowHeight;
            };

            const drawEntryRow = (entry: RelayableTicketEntry, striped: boolean) => {
                const isVasteLijst = entry.code === 'Vaste lijst';

                doc.save();
                if (isVasteLijst) {
                    doc.rect(left, y, tableWidth, rowHeight).fill('#fff4cc');
                } else if (striped) {
                    doc.rect(left, y, tableWidth, rowHeight).fill('#fbfcfe');
                } else {
                    doc.rect(left, y, tableWidth, rowHeight).fill('#ffffff');
                }

                doc.fillColor('#000000');
                doc.font(isVasteLijst ? 'Helvetica-Oblique' : 'Helvetica').fontSize(11);
                doc.text(entry.code, left + 8, y + 4, { width: codeColWidth - 16 });
                doc.text((entry.final / 100).toFixed(2), left + codeColWidth, y + 4, {
                    width: amountColWidth - 16,
                    align: 'right'
                });
                doc.restore();
                y += rowHeight;
            };

            const drawTotalRow = (label: string, totalCents: number) => {
                doc.save();
                doc.rect(left, y, tableWidth, rowHeight).fill('#e8ebed');
                doc.fillColor('#000000');
                doc.font('Helvetica-Bold').fontSize(11);
                doc.text(label, left + 8, y + 4, { width: codeColWidth - 16 });
                doc.text((totalCents / 100).toFixed(2), left + codeColWidth, y + 4, {
                    width: amountColWidth - 16,
                    align: 'right'
                });
                doc.restore();
                y += rowHeight;
            };

            const startSectionPage = (title: string, firstColLabel: string, continuation: boolean) => {
                if (!isFirstSection) {
                    doc.addPage();
                }
                isFirstSection = false;
                y = top;

                const fullTitle = continuation ? `${title} (vervolg)` : title;
                doc.font('Helvetica-Bold')
                    .fontSize(12)
                    .fillColor('#000000');

                // Calculate actual height of wrapped title text
                const titleHeightActual = doc.heightOfString(fullTitle, { width: usableWidth });
                doc.text(fullTitle, left, y, { width: usableWidth });

                // Add spacing after title (title height + some padding)
                y += titleHeightActual + 8;

                drawTableHeader(firstColLabel);
            };

            const renderSection = (
                title: string,
                entries: RelayableTicketEntry[],
                totalCents: number,
                firstColLabel = 'Code'
            ) => {
                if (!entries.length && totalCents === 0) return;

                // Ensure "Vaste lijst" appears at the end
                const ordered: RelayableTicketEntry[] = [
                    ...entries.filter(e => e.code !== 'Vaste lijst'),
                    ...entries.filter(e => e.code === 'Vaste lijst')
                ];

                startSectionPage(title, firstColLabel, false);

                let stripe = false;
                let i = 0;

                while (i < ordered.length) {
                    if (y + rowHeight > bottomLimit) {
                        // New physical page, same table
                        startSectionPage(title, firstColLabel, true);
                        stripe = false;
                    }

                    drawEntryRow(ordered[i], stripe);
                    stripe = !stripe;
                    i++;
                }

                if (y + rowHeight > bottomLimit) {
                    startSectionPage(title, firstColLabel, true);
                }
                drawTotalRow('Totaal', totalCents);
            };

            // Nothing at all
            if (!relayableTickets.length && !dailyCodesForDisplay.length) {
                doc.font('Helvetica')
                    .fontSize(12)
                    .fillColor('#000000')
                    .text('Geen relaybare of daglijkse tickets gevonden', left, y, { width: usableWidth });
                doc.end();
                return;
            }

            // ---- Relayable tickets: Super4 vs non-Super4 ----
            const super4Chunks: ChunkedRelayableTicket[] = [];
            const nonSuper4Chunks: ChunkedRelayableTicket[] = [];

            relayableTickets.forEach(chunk => {
                const isSuper4 =
                    chunk.gameCombination.length === 1 &&
                    chunk.gameCombination[0] === 'Super 4';
                if (isSuper4) {
                    super4Chunks.push(chunk);
                } else {
                    nonSuper4Chunks.push(chunk);
                }
            });

            // Non-Super4 chunks: each chunk = its own section/table (and therefore its own page)
            for (const chunk of nonSuper4Chunks) {
                if (!chunk.entries || !chunk.entries.length) continue;

                const totalCents = (chunk.entries as RelayableTicketEntry[]).reduce(
                    (sum, e) => sum + e.final,
                    0
                );

                renderSection(
                    chunk.gameCombination.join(', '),
                    chunk.entries as RelayableTicketEntry[],
                    totalCents
                );
            }

            // Super4 chunks: one section per chunk (still 1 table per page)
            for (const chunk of super4Chunks) {
                if (!chunk.entries || !chunk.entries.length) continue;

                const totalCents = (chunk.entries as RelayableTicketEntry[]).reduce(
                    (sum, e) => sum + e.final,
                    0
                );

                renderSection(
                    'Super 4',
                    chunk.entries as RelayableTicketEntry[],
                    totalCents
                );
            }

            // ---- Daily tickets (vaste nummers) ----
            if (dailyCodesForDisplay.length > 0) {
                const codesByGame = new Map<number, typeof dailyCodesForDisplay>();
                for (const code of dailyCodesForDisplay) {
                    if (!codesByGame.has(code.gameID)) {
                        codesByGame.set(code.gameID, []);
                    }
                    codesByGame.get(code.gameID)!.push(code);
                }

                let grandTotal = 0;

                // Each game’s daily summary = its own section / table / page
                for (const [gameID, codes] of codesByGame) {
                    if (!codes.length) continue;
                    const gameName = codes[0].gameName;

                    const entries: RelayableTicketEntry[] = codes.map(c => ({
                        code: c.code,
                        codeLength: c.code.length,
                        value: c.value,
                        deduction: 0,
                        final: c.value
                    })) as any;

                    const totalForGame = codes.reduce((sum, c) => sum + c.value, 0);
                    grandTotal += totalForGame;

                    renderSection(
                        `Gespeelde daglijkse tickets – ${gameName}`,
                        entries,
                        totalForGame
                    );
                }

                // Grand total (if multiple games): its own small table on its own page
                if (codesByGame.size > 1) {
                    const totalEntry: RelayableTicketEntry = {
                        code: 'Totaal alle daglijkse tickets',
                        codeLength: 0,
                        value: grandTotal,
                        deduction: 0,
                        final: grandTotal
                    } as any;

                    renderSection(
                        'Gespeelde daglijkse tickets – totaal',
                        [totalEntry],
                        grandTotal,
                        'Omschrijving'
                    );
                }
            }

            doc.end();
        });
    };

    private getAllTicketsForDateRange = async (start: string, end: string): Promise<ChunkedRelayableTicket[]> => {
        const startDate = this.parseDateParameter(start, true);
        const endDate = this.parseDateParameter(end, false);

        console.log('getAllTicketsForDateRange - Parsed dates:', {
            originalStart: start,
            originalEnd: end,
            parsedStart: startDate.toISOString(),
            parsedEnd: endDate.toISOString(),
            startUTC: startDate.toUTCString(),
            endUTC: endDate.toUTCString()
        });

        const tickets = await this.db.ticket.findMany({
            where: {
                created: {
                    gte: startDate,
                    lte: endDate
                }
            },
            select: { id: true, created: true }
        });

        console.log('getAllTicketsForDateRange - Found tickets:', {
            count: tickets.length,
            ticketIds: tickets.map(t => t.id),
            firstTicketCreated: tickets[0]?.created?.toISOString(),
            lastTicketCreated: tickets[tickets.length - 1]?.created?.toISOString()
        });

        const codes = await this.db.code.findMany({
            where: {
                ticketID: { in: tickets.map(ticket => ticket.id) },
            },
            include: {
                ticket: {
                    include: {
                        games: { include: { game: true } }
                    }
                }
            }
        });

        console.log('getAllTicketsForDateRange - Found codes:', {
            count: codes.length,
            sampleCodes: codes.slice(0, 5).map(c => ({
                id: c.id,
                code: c.code,
                value: c.value,
                ticketId: c.ticketID
            }))
        });

        // Use the same logic as getRelayableTickets but without the relayed filter
        const results = await this.buildRelayableChunksIncremental(codes, startDate, endDate);
        console.log('getAllTicketsForDateRange - Results generated:', {
            chunkCount: results.length,
            totalEntries: results.reduce((sum, chunk) => sum + chunk.entries.length, 0)
        });

        return results;
    };

    public exportRelayableGameTotals = async (start: string, end: string, commit?: boolean, combineAcrossGames?: boolean): Promise<ExcelJS.Buffer> => {
        if (!start || !end) {
            throw new ValidationError('Start- en einddatum zijn verplicht voor het exporteren van spel totalen.');
        }

        const allTickets = await this.getAllTicketsForDateRange(start, end);

        const totalsMap = new Map<string, number>(); // key => aggregated cents

        allTickets.forEach((chunk) => {
            const gameLabel = chunk.gameCombination.join(' + ') || 'Onbekend spel';
            chunk.entries.forEach((entry) => {
                const key = `${gameLabel}||${entry.code}`;
                const current = totalsMap.get(key) ?? 0;
                totalsMap.set(key, current + entry.value);
            });
        });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Spel totalen');

        worksheet.columns = [
            { header: 'Omschrijving', key: 'description', width: 48 }
        ];

        if (!totalsMap.size) {
            worksheet.addRow({ description: 'Geen gegevens gevonden voor de opgegeven periode.' });
        } else {
            const sortedEntries = Array.from(totalsMap.entries()).sort(([a], [b]) => a.localeCompare(b, 'nl'));
            sortedEntries.forEach(([key, totalCents]) => {
                const [gameLabel, code] = key.split('||');
                const euroValue = (totalCents / 100).toFixed(2).replace('.', ',');
                worksheet.addRow({
                    description: `${gameLabel} ${code} €${euroValue}`
                });
            });
        }

        return workbook.xlsx.writeBuffer();
    }

    public exportRelayableBalanceSummary = async (start: string, end: string): Promise<ExcelJS.Buffer> => {
        if (!start || !end) {
            throw new ValidationError('Start- en einddatum zijn verplicht voor het exporteren van saldo gegevens.');
        }

        const startDate = this.parseDateParameter(start, true);
        const endDate = this.parseDateParameter(end, false);

        // Calculate day boundaries for the end date (in Amsterdam timezone)
        // This is needed to include prizes/corrections created the next day that relate to the selected day
        const endDateAmsterdam = DateTime.fromJSDate(endDate).setZone('Europe/Amsterdam');
        const endDateDayStart = endDateAmsterdam.startOf('day').toUTC().toJSDate();
        const endDateDayEnd = endDateAmsterdam.endOf('day').toUTC().toJSDate();

        // Extend endDate by 24 hours to catch prizes/corrections created the next day
        const endDateExtended = new Date(endDate);
        endDateExtended.setHours(endDateExtended.getHours() + 24);

        // Get all users (runners and managers) with their balance info
        const users = await this.db.user.findMany({
            where: {
                role: {
                    in: [Role.RUNNER, Role.MANAGER]
                }
            },
            select: {
                id: true,
                name: true,
                role: true,
                commission: true,
                balance: {
                    select: {
                        balance: true
                    }
                }
            }
        });

        // Get all balance actions within the period
        // For PRIZE and CORRECTION, also include actions created up to 24 hours after endDate
        // but only if their created date falls within the day boundaries of endDate
        const actions = await this.db.balanceAction.findMany({
            where: {
                OR: [
                    // Regular actions within the period
                    {
                        created: {
                            gte: startDate,
                            lte: endDate
                        }
                    },
                    // PRIZE and CORRECTION actions: include if created within endDate's day boundaries
                    // OR created up to 24 hours after endDate (to catch late entries)
                    {
                        type: {
                            in: [BalanceActionType.PRIZE, BalanceActionType.CORRECTION]
                        },
                        created: {
                            gte: endDateDayStart,
                            lte: endDateExtended
                        }
                    }
                ],
                balance: {
                    user: {
                        role: {
                            in: [Role.RUNNER, Role.MANAGER]
                        }
                    }
                }
            },
            include: {
                balance: {
                    select: {
                        userID: true
                    }
                }
            }
        });

        // Filter actions: for PRIZE and CORRECTION created after endDate, only include if
        // their created date falls within the day boundaries of endDate
        // (this ensures we only include prizes/corrections that relate to the selected day)
        const filteredActions = actions.filter(action => {
            if ((action.type === BalanceActionType.PRIZE || action.type === BalanceActionType.CORRECTION) && action.created > endDate) {
                // Only include if created date falls within the day boundaries of endDate
                return action.created >= endDateDayStart && action.created <= endDateDayEnd;
            }
            return true;
        });

        // Get tickets for commission calculation
        const tickets = await this.db.ticket.findMany({
            where: {
                created: {
                    gte: startDate,
                    lte: endDate
                }
            },
            select: {
                creatorID: true,
                codes: {
                    select: {
                        value: true
                    }
                },
                games: {
                    select: {
                        gameID: true
                    }
                }
            }
        });

        type BalanceRow = {
            name: string;
            role: Role;
            vorigSaldo: number;
            inleg: number;
            correctie: number;
            uitbetaling: number;
            prijs: number;
            provisie: number;
            eindSaldo: number;
        };

        const byUser = new Map<number, BalanceRow>();

        // Initialize rows for all users with their previous balance
        users.forEach((user) => {
            // Get actions before the start date to calculate previous balance
            const currentBalance = user.balance?.balance ?? 0;

            byUser.set(user.id, {
                name: user.name,
                role: user.role,
                vorigSaldo: 0, // Will be calculated
                inleg: 0,
                correctie: 0,
                uitbetaling: 0,
                prijs: 0,
                provisie: 0,
                eindSaldo: 0
            });
        });

        // Calculate previous balance for each user (balance before the period)
        for (const [userId, row] of byUser) {
            const actionsBeforePeriod = await this.db.balanceAction.findMany({
                where: {
                    created: {
                        lt: startDate
                    },
                    balance: {
                        userID: userId
                    }
                }
            });

            let previousBalance = 0;
            actionsBeforePeriod.forEach((action) => {
                switch (action.type) {
                    case BalanceActionType.TICKET_SALE:
                        previousBalance += action.amount;
                        break;
                    case BalanceActionType.CORRECTION:
                        previousBalance += action.amount;
                        break;
                    case BalanceActionType.PAYOUT:
                        previousBalance += action.amount; // Already negative
                        break;
                    case BalanceActionType.PRIZE:
                        previousBalance += action.amount; // Already negative
                        break;
                    case BalanceActionType.PROVISION:
                        previousBalance += action.amount;
                        break;
                }
            });

            row.vorigSaldo = previousBalance;
        }

        // Process actions within the period
        filteredActions.forEach((action) => {
            const userId = action.balance?.userID;
            if (!userId) {
                return;
            }

            const entry = byUser.get(userId);
            if (!entry) {
                return;
            }

            switch (action.type) {
                case BalanceActionType.TICKET_SALE:
                    entry.inleg += action.amount;
                    break;
                case BalanceActionType.CORRECTION:
                    entry.correctie += action.amount;
                    break;
                case BalanceActionType.PAYOUT:
                    entry.uitbetaling += Math.abs(action.amount);
                    break;
                case BalanceActionType.PRIZE:
                    entry.prijs += Math.abs(action.amount);
                    break;
                case BalanceActionType.PROVISION:
                    entry.provisie += action.amount;
                    break;
            }
        });

        // Calculate provision from Inleg and commission percentage for each user
        // Provision is calculated as a percentage of Inleg for the period
        // Provision should be shown as positive in the export, but is negative for balance calculation
        byUser.forEach((row, userId) => {
            const user = users.find(u => u.id === userId);
            if (user && row.inleg > 0) {
                // Calculate provision as percentage of Inleg
                const provisionAmount = Math.round((row.inleg * (user.commission || 0)) / 100);
                // Always use calculated value from Inleg (not balance actions)
                row.provisie = -provisionAmount; // Negative for balance calculation
            }
        });

        // Calculate end balance: opening + corrections - payouts + ticket sales - prizes + provision
        // Note: provision is negative, so adding it subtracts from balance
        byUser.forEach((row) => {
            row.eindSaldo = row.vorigSaldo + row.correctie - row.uitbetaling + row.inleg - row.prijs + row.provisie;
        });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Saldo export');

        const currencyFormat = '€ #,##0.00';

        worksheet.columns = [
            { header: 'Loper / Manager', key: 'name', width: 30 },
            { header: 'Rol', key: 'role', width: 14 },
            { header: 'Vorig saldo (€)', key: 'vorigSaldo', width: 18, style: { numFmt: currencyFormat } },
            { header: 'Inleg (€)', key: 'inleg', width: 16, style: { numFmt: currencyFormat } },
            { header: 'Correctie (€)', key: 'correctie', width: 16, style: { numFmt: currencyFormat } },
            { header: 'Uitbetaling (€)', key: 'uitbetaling', width: 18, style: { numFmt: currencyFormat } },
            { header: 'Prijzen (€)', key: 'prijs', width: 16, style: { numFmt: currencyFormat } },
            { header: 'Provisie (€)', key: 'provisie', width: 16, style: { numFmt: currencyFormat } },
            { header: 'Eind saldo (€)', key: 'eindSaldo', width: 18, style: { numFmt: currencyFormat } },
        ];

        const rows = Array.from(byUser.values())
            .filter(row => row.inleg !== 0 || row.correctie !== 0 || row.uitbetaling !== 0 || row.prijs !== 0 || row.vorigSaldo !== 0)
            .sort((a, b) => a.name.localeCompare(b.name, 'nl'));

        if (!rows.length) {
            worksheet.addRow({ name: 'Geen saldo acties gevonden voor de opgegeven periode.' });
        } else {
            rows.forEach((row) => {
                worksheet.addRow({
                    name: row.name,
                    role: row.role === Role.MANAGER ? 'Manager' : 'Loper',
                    vorigSaldo: row.vorigSaldo / 100,
                    inleg: row.inleg / 100,
                    correctie: row.correctie / 100,
                    uitbetaling: row.uitbetaling / 100,
                    prijs: row.prijs / 100,
                    provisie: Math.abs(row.provisie) / 100, // Display as positive value
                    eindSaldo: row.eindSaldo / 100
                });
            });

            worksheet.addRow({});
            worksheet.addRow({
                name: 'Totaal',
                role: '',
                vorigSaldo: rows.reduce((sum, row) => sum + row.vorigSaldo, 0) / 100,
                inleg: rows.reduce((sum, row) => sum + row.inleg, 0) / 100,
                correctie: rows.reduce((sum, row) => sum + row.correctie, 0) / 100,
                uitbetaling: rows.reduce((sum, row) => sum + row.uitbetaling, 0) / 100,
                prijs: rows.reduce((sum, row) => sum + row.prijs, 0) / 100,
                provisie: rows.reduce((sum, row) => sum + Math.abs(row.provisie), 0) / 100, // Display as positive value
                eindSaldo: rows.reduce((sum, row) => sum + row.eindSaldo, 0) / 100
            });
        }

        return workbook.xlsx.writeBuffer();
    }

    public exportRelayablePrizes = async (start: string, end: string, prizeDate?: string, scopeUserID?: number): Promise<ExcelJS.Buffer> => {
        const referenceDateParam = prizeDate || end || start;

        if (!referenceDateParam) {
            throw new ValidationError('Er is geen datum opgegeven voor de prijzen export.');
        }

        const prizeService = container.resolve<IPrizeService>("PrizeService");
        const targetDate = this.parseDateParameter(referenceDateParam, true);

        const pageSize = 200;
        let page = 1;
        let hasMore = true;

        type PrizeRow = {
            game: string;
            runner: string;
            manager: string;
            customer: string;
            code: string;
            order: string | number;
            stake: number;
            prize: number;
        };

        const rows: PrizeRow[] = [];

        while (hasMore) {
            const report = await prizeService.getPrizesByDate(
                targetDate,
                scopeUserID,
                page,
                pageSize
            );

            report.groups.forEach(group => {
                group.tickets.forEach(ticket => {
                    const runnerLabel = ticket.runnerName || (ticket.managerName ? 'Manager zelf' : '-');

                    ticket.codes.forEach(codeEntry => {
                        if (!codeEntry || codeEntry.value <= 0) {
                            return;
                        }

                        const stakeValue = (codeEntry as any).stake ?? 0;

                        rows.push({
                            game: group.game.name,
                            runner: runnerLabel,
                            manager: ticket.managerName || '-',
                            customer: ticket.name || '-',
                            code: codeEntry.code,
                            order: codeEntry.raffleOrder ?? '-',
                            stake: stakeValue / 100,
                            prize: codeEntry.value / 100
                        });
                    });
                });
            });

            hasMore = report.hasMore;
            page += 1;
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Prijzen');

        const currencyFormat = '€ #,##0.00';

        worksheet.columns = [
            { header: 'Spel', key: 'game', width: 18 },
            { header: 'Loper', key: 'runner', width: 20 },
            { header: 'Manager', key: 'manager', width: 20 },
            { header: 'Klant', key: 'customer', width: 24 },
            { header: 'Nummer', key: 'code', width: 12 },
            { header: 'Regel', key: 'order', width: 10 },
            { header: 'Inleg (€)', key: 'stake', width: 14, style: { numFmt: currencyFormat } },
            { header: 'Prijs (€)', key: 'prize', width: 14, style: { numFmt: currencyFormat } },
        ];

        if (!rows.length) {
            worksheet.addRow({ game: 'Geen prijzen gevonden binnen de selectie.' });
        } else {
            rows
                .sort((a, b) => {
                    const gameCompare = a.game.localeCompare(b.game, 'nl');
                    if (gameCompare !== 0) return gameCompare;
                    return a.code.localeCompare(b.code, 'nl');
                })
                .forEach(row => {
                    worksheet.addRow(row);
                });

            worksheet.addRow({});
            worksheet.addRow({
                game: 'Totaal',
                runner: '',
                manager: '',
                customer: '',
                code: '',
                order: '',
                stake: rows.reduce((sum, row) => sum + row.stake, 0),
                prize: rows.reduce((sum, row) => sum + row.prize, 0)
            });
        }

        return workbook.xlsx.writeBuffer();
    }

    public getRelayBatchHistory = async (): Promise<any[]> => {
        const batches = await this.db.relayBatch.findMany({
            orderBy: { created: 'desc' },
            include: {
                codes: {
                    select: {
                        id: true,
                        code: true,
                        value: true,
                        ticket: {
                            select: {
                                games: {
                                    include: {
                                        game: true
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        // Calculate totals for each batch
        const history = batches.map(batch => {
            let totalValue = 0;
            let totalDeduction = 0;
            let totalFinal = 0;

            // Group codes by game to apply deduction rules
            const codesByGame = new Map<string, any[]>();

            batch.codes.forEach(code => {
                const gameIds = code.ticket?.games.map(g => g.game.id) || [];
                const gameNames = code.ticket?.games.map(g => g.game.name) || [];
                const gameKey = gameIds.sort().join(',');

                if (!codesByGame.has(gameKey)) {
                    codesByGame.set(gameKey, []);
                }

                codesByGame.get(gameKey)!.push({
                    code: code.code,
                    value: code.value,
                    gameIds,
                    gameNames
                });
            });

            // Calculate deductions per code
            codesByGame.forEach((codes, _gameKey) => {
                codes.forEach(code => {
                    const codeLength = String(code.code).length;
                    const { deduction, finalValue } = this.calculateDeduction(
                        codeLength,
                        code.value,
                        code.gameIds
                    );

                    totalValue += code.value;
                    totalDeduction += deduction;
                    totalFinal += finalValue;
                });
            });

            return {
                id: batch.id,
                start: batch.start,
                end: batch.end,
                created: batch.created,
                totalValue,
                totalDeduction,
                totalFinal,
                codeCount: batch.codes.length
            };
        });

        return history;
    }

    public undoRelayBatch = async (batchID: number): Promise<void> => {
        // Verify batch exists
        const batch = await this.db.relayBatch.findUnique({
            where: { id: batchID },
            include: {
                codes: {
                    select: { id: true }
                }
            }
        });

        if (!batch) {
            throw new ValidationError('Relay batch niet gevonden');
        }

        // Use transaction to ensure atomicity
        await this.db.$transaction(async (tx) => {
            // Reset all codes in this batch
            await tx.code.updateMany({
                where: { relayBatchID: batchID },
                data: {
                    relayed: null,
                    relayBatchID: null
                }
            });

            // Delete the batch
            await tx.relayBatch.delete({
                where: { id: batchID }
            });
        });
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

        // check if the ticket was created today (same day editing only) - use Amsterdam timezone
        const nowAmsterdam = DateTime.now().setZone('Europe/Amsterdam');
        const ticketCreatedAmsterdam = DateTime.fromJSDate(ticket.created).setZone('Europe/Amsterdam');

        // Compare the dates in Amsterdam timezone (year-month-day)
        const todayDateStr = nowAmsterdam.toFormat('yyyy-MM-dd');
        const ticketDateStr = ticketCreatedAmsterdam.toFormat('yyyy-MM-dd');

        if (todayDateStr !== ticketDateStr) {
            throw new ValidationError('Tickets kunnen alleen worden verwijderd op dezelfde dag als ze zijn aangemaakt');
        }

        // delete all codes
        await this.db.code.deleteMany({
            where: { ticketID: id }
        });

        // delete all games
        await this.db.ticketGame.deleteMany({
            where: { ticketID: id }
        });

        // Delete balance action for this ticket
        await this.deleteTicketSaleBalanceAction(id);

        await this.db.ticket.delete({
            where: { id }
        });
    }

    public getRelayableTickets = async (start: string, end: string, commit?: boolean, combineAcrossGames?: boolean): Promise<ChunkedRelayableTicket[]> => {

        // if(Context.get('authID') !== 1) {
        //     throw new ValidationError('Je hebt geen toegang tot deze functionaliteit');
        // }

        let results: ChunkedRelayableTicket[];

        if (commit) {
            const commitResponse = await this.commitRelayableTickets(start, end);
            results = commitResponse.results as unknown as ChunkedRelayableTicket[];
        } else {
            // Parse and normalize date parameters for better demo usability
            const startDate = this.parseDateParameter(start, true);
            const endDate = this.parseDateParameter(end, false);

            console.log('getRelayableTickets - Parsed dates:', {
                originalStart: start,
                originalEnd: end,
                parsedStart: startDate.toISOString(),
                parsedEnd: endDate.toISOString(),
                startUTC: startDate.toUTCString(),
                endUTC: endDate.toUTCString()
            });

            const tickets = await this.db.ticket.findMany({
                where: {
                    created: {
                        gte: startDate,
                        lte: endDate
                    }
                },
                select: { id: true, created: true }
            });

            console.log('getRelayableTickets - Found tickets:', {
                count: tickets.length,
                ticketIds: tickets.map(t => t.id),
                firstTicketCreated: tickets[0]?.created?.toISOString(),
                lastTicketCreated: tickets[tickets.length - 1]?.created?.toISOString()
            });

            const codes = await this.db.code.findMany({
                where: {
                    ticketID: { in: tickets.map(ticket => ticket.id) },
                    relayed: null,
                    daily: false, // Exclude daily codes - they are handled separately in PDF export
                },
                include: {
                    ticket: {
                        include: {
                            games: { include: { game: true } }
                        }
                    }
                }
            });

            console.log('getRelayableTickets - Found codes:', {
                count: codes.length,
                sampleCodes: codes.slice(0, 5).map(c => ({
                    id: c.id,
                    code: c.code,
                    value: c.value,
                    ticketId: c.ticketID
                }))
            });

            // For non-commit exports, we want incremental results that account for prior commits earlier the same day
            try {
                results = await this.buildRelayableChunksIncremental(codes, startDate, endDate);
                console.log('getRelayableTickets - Results generated:', {
                    chunkCount: results.length,
                    totalEntries: results.reduce((sum, chunk) => sum + chunk.entries.length, 0)
                });
            } catch (error) {
                console.error('getRelayableTickets - Error in buildRelayableChunksIncremental:', error);
                throw error;
            }
        }

        if (!combineAcrossGames) {
            return results;
        }

        // Separate Super 4 chunks from other game chunks
        const super4Results: ChunkedRelayableTicket[] = [];
        const nonSuper4Results: ChunkedRelayableTicket[] = [];

        results.forEach(chunk => {
            const isSuper4 = chunk.gameCombination.length === 1 && chunk.gameCombination[0] === 'Super 4';
            if (isSuper4) {
                super4Results.push(chunk);
            } else {
                nonSuper4Results.push(chunk);
            }
        });

        // Combine across games ONLY for non-Super4 games by (code, per-game final). We sum value/deduction across games
        // but keep the per-game final amount unchanged by grouping on it.
        type EntryAgg = { code: string; codeLength: number; final: number; valueSum: number; deductionSum: number; games: Set<string> };
        const byCodeFinal = new Map<string, Map<number, EntryAgg>>();
        nonSuper4Results.forEach(chunk => {
            chunk.entries.forEach((e: RelayableTicketEntry) => {
                const code = e.code;
                const finalKey = e.final; // cents
                let inner = byCodeFinal.get(code);
                if (!inner) { inner = new Map<number, EntryAgg>(); byCodeFinal.set(code, inner); }
                let agg = inner.get(finalKey);
                if (!agg) {
                    agg = { code, codeLength: e.codeLength, final: finalKey, valueSum: 0, deductionSum: 0, games: new Set<string>() };
                    inner.set(finalKey, agg);
                }
                agg.valueSum += e.value;
                agg.deductionSum += e.deduction;
                chunk.gameCombination.forEach((g: string) => agg!.games.add(g));
            });
        });

        // Now group aggregated entries by their union-of-games signature
        const groupsByGames = new Map<string, { gameList: string[]; entries: { code: string; codeLength: number; value: number; deduction: number; final: number }[] }>();
        for (const inner of byCodeFinal.values()) {
            for (const agg of inner.values()) {
                const gameList = Array.from(agg.games).sort();
                const gameKey = gameList.join(', ');
                const group = groupsByGames.get(gameKey) || { gameList, entries: [] };
                group.entries.push({
                    code: agg.code,
                    codeLength: agg.codeLength,
                    value: agg.valueSum,
                    deduction: agg.deductionSum,
                    final: agg.final
                });
                groupsByGames.set(gameKey, group);
            }
        }

        // Emit one chunk per game-list with multiple code rows for non-Super4 games
        const combinedChunks: ChunkedRelayableTicket[] = Array.from(groupsByGames.values()).map(g => ({
            gameCombination: g.gameList,
            codes: g.entries.map(e => e.code),
            totalValue: g.entries.reduce((s, x) => s + x.value, 0),
            ticketCount: g.entries.length,
            deduction: g.entries.reduce((s, x) => s + x.deduction, 0),
            finalValue: g.entries.reduce((s, x) => s + x.final, 0),
            entries: g.entries
        }));

        // Combine non-Super4 chunks and Super4 chunks, keeping Super4 separate
        const allChunks = [...combinedChunks, ...super4Results];

        return _.sortBy(allChunks, c => c.gameCombination.join('|'));
    }

    // Helper method to calculate daily code totals per code for specific games
    private calculateDailyCodeTotals = async (dayStart: Date, dayEnd: Date): Promise<Map<string, Map<number, number>>> => {
        const dailyTotals = new Map<string, Map<number, number>>(); // Map<code, Map<gameID, total>>

        // Query daily codes for WNK (gameID 1) and Super4 (gameID 7)
        const targetGameIds = [1, 7];

        for (const gameID of targetGameIds) {
            const dailyCodes = await this.db.code.findMany({
                where: {
                    daily: true,
                    ticket: {
                        created: { gte: dayStart, lte: dayEnd },
                        games: { some: { gameID } }
                    }
                },
                select: { code: true, value: true }
            });

            // Group by code and gameID
            for (const code of dailyCodes) {
                const codeStr = String(code.code);
                if (!dailyTotals.has(codeStr)) {
                    dailyTotals.set(codeStr, new Map<number, number>());
                }
                const gameMap = dailyTotals.get(codeStr)!;
                const currentTotal = gameMap.get(gameID) || 0;
                gameMap.set(gameID, currentTotal + (code.value as number));
            }
        }

        return dailyTotals;
    }

    private getDailyCodesForDisplay = async (dayStart: Date, dayEnd: Date): Promise<{ code: string, value: number, gameID: number, gameName: string }[]> => {
        const dailyCodes: { code: string, value: number, gameID: number, gameName: string }[] = [];

        // Query daily codes for WNK (gameID 1) and Super4 (gameID 7)
        const targetGameIds = [1, 7];
        const gameNames = { 1: 'WNK', 7: 'Super 4' };

        for (const gameID of targetGameIds) {
            const codes = await this.db.code.findMany({
                where: {
                    daily: true,
                    ticket: {
                        created: { gte: dayStart, lte: dayEnd },
                        games: { some: { gameID } }
                    }
                },
                select: { code: true, value: true }
            });

            // Group by code and sum values
            const codeMap = new Map<string, number>();
            for (const code of codes) {
                const codeStr = String(code.code);
                const currentTotal = codeMap.get(codeStr) || 0;
                codeMap.set(codeStr, currentTotal + (code.value as number));
            }

            // Convert to display format
            for (const [code, value] of codeMap) {
                dailyCodes.push({
                    code,
                    value,
                    gameID,
                    gameName: gameNames[gameID as keyof typeof gameNames]
                });
            }
        }

        // Sort by game, then by code
        return dailyCodes.sort((a, b) => {
            if (a.gameID !== b.gameID) return a.gameID - b.gameID;
            return a.code.localeCompare(b.code, undefined, { numeric: true });
        });
    }

    // Build chunks but compute per-code incremental values for the selected window by
    // subtracting already-committed amounts earlier in the same day.
    private buildRelayableChunksIncrementalDetailed = async (codes: any[], windowStart: Date, _windowEnd: Date): Promise<{ chunks: ChunkedRelayableTicket[]; relayableCodeIds: number[] }> => {
        type GroupValue = { gameIds: number[]; gameNames: string[]; entries: { id: number; code: string; codeLength: number; value: number; }[] };
        type GroupKey = string;

        const groups = new Map<GroupKey, GroupValue>();
        const relayableCodeIds = new Set<number>();

        codes.forEach((item) => {
            const value = Number(item.value);
            const codeStr = String(item.code);
            const codeLength = codeStr.length;
            const gameIds: number[] = (item.ticket?.games || []).map((g: any) => g.game?.id).filter((id: any) => typeof id === 'number');
            const gameNames: string[] = (item.ticket?.games || []).map((g: any) => g.game?.name).filter((n: any) => typeof n === 'string');

            const hasSuper4 = gameIds.includes(7);

            // Add entries per individual non-Super4 game (not as a combination)
            const nonSuperGames = (item.ticket?.games || []).filter((g: any) => g.game?.id !== 7);
            nonSuperGames.forEach((g: any) => {
                const gId = g.game?.id;
                const gName = g.game?.name;
                if (typeof gId === 'number' && typeof gName === 'string') {
                    const key: GroupKey = `G:${gId}:${gName}`;
                    const existing: GroupValue = groups.get(key) || { gameIds: [gId], gameNames: [gName], entries: [] };
                    existing.entries.push({ id: item.id, code: codeStr, codeLength, value });
                    groups.set(key, existing);
                }
            });

            // Add Super 4 group separately if present
            if (hasSuper4) {
                const key: GroupKey = 'S4:Super 4';
                const existing: GroupValue = groups.get(key) || { gameIds: [7], gameNames: ['Super 4'], entries: [] };
                existing.entries.push({ id: item.id, code: codeStr, codeLength, value });
                groups.set(key, existing);
            }
        });

        // Determine the day window from the start time in Amsterdam timezone
        // Convert windowStart to Amsterdam timezone to get the correct day boundaries
        let dayStart: Date;
        let dayEnd: Date;

        try {
            const windowStartAmsterdam = DateTime.fromJSDate(windowStart).setZone('Europe/Amsterdam');
            dayStart = windowStartAmsterdam.startOf('day').toUTC().toJSDate();
            dayEnd = windowStartAmsterdam.endOf('day').toUTC().toJSDate();

            console.log('buildRelayableChunksIncrementalDetailed - Day boundaries:', {
                windowStart: windowStart.toISOString(),
                dayStart: dayStart.toISOString(),
                dayEnd: dayEnd.toISOString()
            });
        } catch (error) {
            console.error('Error calculating day boundaries:', error);
            // Fallback to UTC calculation
            dayStart = new Date(windowStart);
            dayStart.setUTCHours(0, 0, 0, 0);
            dayEnd = new Date(windowStart);
            dayEnd.setUTCHours(23, 59, 59, 999);
        }

        const chunks: ChunkedRelayableTicket[] = [];
        for (const group of Array.from(groups.values())) {
            const isSuper4 = group.gameIds.includes(7);
            const gameID = group.gameIds[0];

            // Aggregate values for the window per code
            const codeGroups = _.groupBy(group.entries, 'code');
            const windowAggregated: { code: string; codeLength: number; value: number; ids: number[] }[] = [];
            Object.entries(codeGroups).forEach(([code, entries]) => {
                const totalValue = entries.reduce((sum, entry) => sum + entry.value, 0);
                const codeLength = entries[0].codeLength;
                const ids = entries.map(e => e.id);
                windowAggregated.push({ code, codeLength, value: totalValue, ids });
            });

            if (windowAggregated.length === 0) continue;

            // Batch-fetch all codes for the day for this game context
            const ticketGameFilter: any = isSuper4 ? { some: { gameID: 7 } } : { some: { gameID: group.gameIds[0] } };
            const allDayForGame = await this.db.code.findMany({
                where: {
                    ticket: {
                        created: { gte: dayStart, lte: dayEnd },
                        games: ticketGameFilter
                    }
                },
                select: { code: true, value: true, relayed: true }
            });

            // Build maps: total by code and committed by code
            const totalByCode = new Map<string, number>();
            const committedByCode = new Map<string, number>();
            for (const c of allDayForGame) {
                const k = String(c.code);
                totalByCode.set(k, (totalByCode.get(k) || 0) + (c.value as number));
                if (c.relayed) committedByCode.set(k, (committedByCode.get(k) || 0) + (c.value as number));
            }

            // For each window code, compute daily totals and incremental amounts
            const entriesDetailed: { code: string; codeLength: number; value: number; deduction: number; final: number }[] = [];
            for (const e of windowAggregated) {
                const totalAllDay = totalByCode.get(e.code) || 0;
                const committedValue = committedByCode.get(e.code) || 0;

                // Apply threshold to the full day total
                const valueInEuros = totalAllDay / 100;
                let meetsThreshold = false;
                if (isSuper4) {
                    if (e.codeLength === 4) meetsThreshold = valueInEuros > 1.50;
                    else if (e.codeLength === 3) meetsThreshold = false; // 3-digit codes filtered out
                    else if (e.codeLength === 2) meetsThreshold = false; // 2-digit codes filtered out
                } else {
                    if (e.codeLength === 4) meetsThreshold = valueInEuros > 3;
                    else if (e.codeLength === 3) meetsThreshold = valueInEuros > 20;
                    else if (e.codeLength === 2) meetsThreshold = false; // 2-digit codes filtered out
                }
                if (!meetsThreshold) continue;

                // Apply deduction rule to the original window value
                const windowCalc = this.calculateDeduction(e.codeLength, e.value, group.gameIds);

                // Skip codes with zero or negative final value after deduction
                if (windowCalc.finalValue <= 0) continue;

                entriesDetailed.push({
                    code: e.code,
                    codeLength: e.codeLength,
                    value: e.value,  // Keep original value for display
                    deduction: windowCalc.deduction,
                    final: windowCalc.finalValue
                });
                e.ids.forEach(id => relayableCodeIds.add(id));
            }

            if (!entriesDetailed.length) {
                continue;
            }

            // Calculate totals
            const totalValue = entriesDetailed.reduce((s, x) => s + x.value, 0);
            const deduction = entriesDetailed.reduce((s, x) => s + x.deduction, 0);
            const finalValue = entriesDetailed.reduce((s, x) => s + x.final, 0);

            chunks.push({
                gameCombination: group.gameNames,
                codes: entriesDetailed.map(e => e.code),
                totalValue,
                ticketCount: entriesDetailed.length,
                deduction,
                finalValue,
                entries: entriesDetailed
            } as any);
        }

        const sortedChunks = _.sortBy(chunks, c => c.gameCombination.join('|'));
        return { chunks: sortedChunks, relayableCodeIds: Array.from(relayableCodeIds) };
    }

    private buildRelayableChunksIncremental = async (codes: any[], windowStart: Date, windowEnd: Date): Promise<ChunkedRelayableTicket[]> => {
        const { chunks } = await this.buildRelayableChunksIncrementalDetailed(codes, windowStart, windowEnd);
        return chunks;
    }

    private parseDateParameter(dateParam: string, isStartDate: boolean): Date {
        // Handle various date formats for better demo usability

        // 1. If it's already an ISO string, parse directly
        if (dateParam.includes('T') || dateParam.includes('Z') || dateParam.includes('+')) {
            return new Date(dateParam);
        }

        // 2. Handle "YYYY-MM-DD" format - convert to start/end of day in Amsterdam timezone
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
            const parsed = DateTime.fromFormat(dateParam, 'yyyy-MM-dd', { zone: 'Europe/Amsterdam' });
            if (parsed.isValid) {
                if (isStartDate) {
                    return parsed.startOf('day').toUTC().toJSDate();
                } else {
                    return parsed.endOf('day').toUTC().toJSDate();
                }
            }
        }

        // 3. Handle "YYYY-MM-DD HH:MM" format
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dateParam)) {
            const parsed = DateTime.fromFormat(dateParam, 'yyyy-MM-dd HH:mm', { zone: 'Europe/Amsterdam' });
            if (parsed.isValid) {
                return parsed.toUTC().toJSDate();
            }
        }

        // 4. Handle "YYYY-MM-DD HH:MM:SS" format
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateParam)) {
            const parsed = DateTime.fromFormat(dateParam, 'yyyy-MM-dd HH:mm:ss', { zone: 'Europe/Amsterdam' });
            if (parsed.isValid) {
                return parsed.toUTC().toJSDate();
            }
        }

        // 5. Fallback: try to parse as-is (will throw error if invalid)
        return new Date(dateParam);
    }

    private buildRelayableChunks = (codes: any[]): ChunkedRelayableTicket[] => {
        type GroupValue = { gameIds: number[]; gameNames: string[]; entries: { code: string; codeLength: number; value: number; }[] };
        type GroupKey = string;

        const groups = new Map<GroupKey, GroupValue>();

        codes.forEach((item) => {
            const value = item.value as number;
            const codeStr = String(item.code);
            const codeLength = codeStr.length;
            const gameIds: number[] = (item.ticket?.games || []).map((g: any) => g.game?.id).filter((id: any) => typeof id === 'number');
            const gameNames: string[] = (item.ticket?.games || []).map((g: any) => g.game?.name).filter((n: any) => typeof n === 'string');

            const hasSuper4 = gameIds.includes(7);

            // Add entries per individual non-Super4 game (not as a combination)
            const nonSuperGames = (item.ticket?.games || []).filter((g: any) => g.game?.id !== 7);
            nonSuperGames.forEach((g: any) => {
                const gId = g.game?.id;
                const gName = g.game?.name;
                if (typeof gId === 'number' && typeof gName === 'string') {
                    const key: GroupKey = `G:${gId}:${gName}`;
                    const existing: GroupValue = groups.get(key) || { gameIds: [gId], gameNames: [gName], entries: [] };
                    existing.entries.push({ code: codeStr, codeLength, value });
                    groups.set(key, existing);
                }
            });

            // Add Super 4 group separately if present
            if (hasSuper4) {
                const key: GroupKey = 'S4:Super 4';
                const existing: GroupValue = groups.get(key) || { gameIds: [7], gameNames: ['Super 4'], entries: [] };
                existing.entries.push({ code: codeStr, codeLength, value });
                groups.set(key, existing);
            }
        });

        const chunks: ChunkedRelayableTicket[] = [];
        groups.forEach((group) => {
            // Group entries by code number and calculate total value per code
            const codeGroups = _.groupBy(group.entries, 'code');
            const aggregatedEntries: { code: string; codeLength: number; value: number; }[] = [];

            Object.entries(codeGroups).forEach(([code, entries]) => {
                const totalValue = entries.reduce((sum, entry) => sum + entry.value, 0);
                const codeLength = entries[0].codeLength; // All entries for same code have same length
                aggregatedEntries.push({ code, codeLength, value: totalValue });
            });

            const hasSuper4 = group.gameIds.includes(7);

            // Filter out codes that don't meet the minimum value requirements BEFORE further processing
            const filteredEntries = aggregatedEntries.filter(entry => {
                const valueInEuros = entry.value / 100;
                if (hasSuper4) {
                    // Super 4 thresholds
                    if (entry.codeLength === 4) return valueInEuros > 1.50;
                    if (entry.codeLength === 3) return false; // 3-digit codes filtered out
                    if (entry.codeLength === 2) return false; // 2-digit codes filtered out
                } else {
                    // Default game thresholds
                    if (entry.codeLength === 4) return valueInEuros > 3;
                    if (entry.codeLength === 3) return valueInEuros > 20;
                    if (entry.codeLength === 2) return false; // 2-digit codes filtered out
                }
                return false;
            });

            // If no codes meet the threshold requirements, skip this group entirely
            if (filteredEntries.length === 0) {
                return;
            }

            // Calculate per-code deductions and final values
            const entriesDetailed = filteredEntries
                .map(e => {
                    const { deduction, finalValue } = this.calculateDeduction(e.codeLength, e.value, group.gameIds);
                    return { code: e.code, codeLength: e.codeLength, value: e.value, deduction, final: finalValue };
                });

            // Aggregate totals from per-code results
            const totalGroupValue = entriesDetailed.reduce((sum, e) => sum + e.value, 0);
            const deduction = entriesDetailed.reduce((sum, e) => sum + e.deduction, 0);
            const finalValue = entriesDetailed.reduce((sum, e) => sum + e.final, 0);

            if (entriesDetailed.length) {
                chunks.push({
                    gameCombination: group.gameNames,
                    codes: entriesDetailed.map(e => e.code),
                    totalValue: totalGroupValue,
                    ticketCount: entriesDetailed.length,
                    deduction,
                    finalValue,
                    entries: entriesDetailed
                });
            }
        });

        return _.sortBy(chunks, c => c.gameCombination.join('|'));
    }

    private calculateDeduction = (codeLength: number, codeValue: number, gameIds: number[]): { deduction: number; finalValue: number } => {
        const hasSuper4 = gameIds.includes(7);

        // Convert cents to euros for easier calculation
        const valueInEuros = codeValue / 100;
        let deductionInEuros = 0;

        if (hasSuper4) {
            // Super 4 rules
            if (codeLength === 4) {
                // 4 digit codes > above 1.50 we deduct 1 euro
                if (valueInEuros > 1.50) {
                    deductionInEuros = 1;
                }
            } else if (codeLength === 3) {
                // 3 digit codes > we dont play these numbers at all. filters them
                return { deduction: 0, finalValue: 0 };
            } else if (codeLength === 2) {
                // 2 digit codes > we dont play these numbers at all. filters them
                return { deduction: 0, finalValue: 0 };
            }
        } else {
            // All games except Super 4
            if (codeLength === 4) {
                // 4 digit codes > above 3 euros we deduct 50 cents
                if (valueInEuros > 3) {
                    deductionInEuros = 0.50;
                }
            } else if (codeLength === 3) {
                // 3 digit codes > above 20 euros we deduct 5 euro
                if (valueInEuros > 20) {
                    deductionInEuros = 5;
                }
            } else if (codeLength === 2) {
                // 2 digit codes > we dont play these numbers at all. filters them
                return { deduction: 0, finalValue: 0 };
            }
        }

        // Convert back to cents
        const deductionInCents = Math.round(deductionInEuros * 100);
        const finalValueInCents = codeValue - deductionInCents;

        return {
            deduction: deductionInCents,
            finalValue: finalValueInCents
        };
    }


    private commitRelayableTickets = async (start: string, end: string) => {
        return await this.db.$transaction(async (tx) => {
            // Use the same date parsing logic as the non-commit path
            const startDate = this.parseDateParameter(start, true);
            const endDate = this.parseDateParameter(end, false);

            const tickets = await tx.ticket.findMany({
                where: { created: { gte: startDate, lte: endDate } },
                select: { id: true }
            });

            const allCodes = await tx.code.findMany({
                where: { ticketID: { in: tickets.map(t => t.id) }, relayed: null },
                include: { ticket: { include: { games: { include: { game: true } } } } }
            });

            const { chunks, relayableCodeIds } = await this.buildRelayableChunksIncrementalDetailed(allCodes, startDate, endDate);

            const batch = await tx.relayBatch.create({ data: { start: new Date(start), end: new Date(end) } });

            if (relayableCodeIds.length) {
                await tx.code.updateMany({
                    where: { id: { in: relayableCodeIds } },
                    data: { relayed: new Date(), relayBatchID: batch.id }
                });
            }

            return { batchID: batch.id, results: chunks };
        });
    }

    private getCutOffForGame(gameName: string, now: DateTime): DateTime {
        const weekday = now.weekday;           // 1 = Mon … 7 = Sun
        const isSunday = weekday === 7;
        const isNoonGame =
            gameName === "Philipsburg noon" || gameName === "Smart noon";

        // 16 : 00 every day for "noon" games
        if (isNoonGame) {
            return now.set({ hour: 16, minute: 0, second: 0, millisecond: 0 });
        }

        // 18 : 00 on Sunday for the "evening / regular" games
        if (isSunday) {
            return now.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
        }

        // 24 : 00 (00 : 00 next day) Mon-Sat for those games
        return now.plus({ days: 1 }).startOf("day"); // next-day midnight
    }

    private async checkDailyLimits(codes: any[], games: number[], runnerID: number, nowNL: DateTime): Promise<void> {
        const startOfDay = nowNL.startOf('day').toJSDate();
        const endOfDay = nowNL.endOf('day').toJSDate();

        const uniqueGameIds = Array.from(new Set(games));
        const gameNameRecords = uniqueGameIds.length
            ? await this.db.game.findMany({
                where: { id: { in: uniqueGameIds } },
                select: { id: true, name: true }
            })
            : [];
        const gameNameMap = new Map<number, string>(gameNameRecords.map(g => [g.id, g.name || `Game ${g.id}`]));

        type LimitBreach = { code: string; codeLength: number; gameID: number; limit: number };
        const globalBreaches: LimitBreach[] = [];
        const userBreaches: LimitBreach[] = [];
        const globalBreachKeys = new Set<string>();
        const userBreachKeys = new Set<string>();

        const globalTotalsCache = new Map<string, number>();
        const userTotalsCache = new Map<string, number>();
        const pendingGlobalAdds = new Map<string, number>();
        const pendingUserAdds = new Map<string, number>();

        const getLimit = (
            scope: 'GLOBAL' | 'USER',
            category: 'DEFAULT' | 'SUPER4',
            codeLength: number
        ): number | undefined => {
            const limits = this.DAILY_LIMITS[scope][category] as Record<number, number>;
            return limits[codeLength];
        };

        for (const newCode of codes) {
            const codeString = String(newCode.code);
            const codeLength = codeString.length;
            if (![3, 4].includes(codeLength)) {
                continue;
            }

            const newCodeValue = Number(newCode.value);

            for (const gameID of uniqueGameIds) {
                const category: 'DEFAULT' | 'SUPER4' = gameID === 7 ? 'SUPER4' : 'DEFAULT';
                const globalLimit = getLimit('GLOBAL', category, codeLength);
                const userLimit = getLimit('USER', category, codeLength);

                if (!globalLimit && !userLimit) {
                    continue;
                }

                const ticketWhereForGame: Prisma.TicketWhereInput = {
                    created: { gte: startOfDay, lte: endOfDay },
                    games: { some: { gameID } }
                };

                const cacheKeyBase = `${category}:${codeLength}:${gameID}:${codeString}`;

                if (globalLimit) {
                    const globalCacheKey = `${cacheKeyBase}:global`;
                    let currentTotal = globalTotalsCache.get(globalCacheKey);
                    if (currentTotal === undefined) {
                        const aggregate = await this.db.code.aggregate({
                            where: {
                                code: codeString,
                                daily: false, // Exclude daily tickets from limit calculations
                                ticket: ticketWhereForGame
                            },
                            _sum: { value: true }
                        });
                        currentTotal = aggregate._sum.value ?? 0;
                        globalTotalsCache.set(globalCacheKey, currentTotal);
                    }

                    const pendingAddition = pendingGlobalAdds.get(globalCacheKey) ?? 0;
                    const projectedTotal = currentTotal + pendingAddition + newCodeValue;

                    if (projectedTotal > globalLimit) {
                        const breachKey = globalCacheKey;
                        if (!globalBreachKeys.has(breachKey)) {
                            globalBreachKeys.add(breachKey);
                            globalBreaches.push({ code: codeString, codeLength, gameID, limit: globalLimit });
                        }
                        continue;
                    }

                    pendingGlobalAdds.set(globalCacheKey, pendingAddition + newCodeValue);
                }

                if (userLimit) {
                    const userCacheKey = `${cacheKeyBase}:user:${runnerID}`;
                    let currentUserTotal = userTotalsCache.get(userCacheKey);
                    if (currentUserTotal === undefined) {
                        const aggregate = await this.db.code.aggregate({
                            where: {
                                code: codeString,
                                daily: false, // Exclude daily tickets from limit calculations
                                ticket: {
                                    ...ticketWhereForGame,
                                    creatorID: runnerID
                                }
                            },
                            _sum: { value: true }
                        });
                        currentUserTotal = aggregate._sum.value ?? 0;
                        userTotalsCache.set(userCacheKey, currentUserTotal);
                    }

                    const pendingUserAddition = pendingUserAdds.get(userCacheKey) ?? 0;
                    const projectedUserTotal = currentUserTotal + pendingUserAddition + newCodeValue;

                    if (projectedUserTotal > userLimit) {
                        if (!userBreachKeys.has(userCacheKey)) {
                            userBreachKeys.add(userCacheKey);
                            userBreaches.push({ code: codeString, codeLength, gameID, limit: userLimit });
                        }
                        continue;
                    }

                    pendingUserAdds.set(userCacheKey, pendingUserAddition + newCodeValue);
                }
            }
        }

        if (globalBreaches.length) {
            const details = globalBreaches.map(breach => {
                const gameLabel = gameNameMap.get(breach.gameID) || `Game ${breach.gameID}`;
                return `${breach.code} (${breach.codeLength} cijfers, ${gameLabel})`;
            }).join(', ');
            throw new ValidationError(`Deze codes hebben het dagelijkse maximum bereikt: ${details}`);
        }

        if (userBreaches.length) {
            const details = userBreaches.map(breach => {
                const gameLabel = gameNameMap.get(breach.gameID) || `Game ${breach.gameID}`;
                return `${breach.code} (${breach.codeLength} cijfers, ${gameLabel})`;
            }).join(', ');
            throw new ValidationError(`Je hebt de persoonlijke limiet overschreden voor: ${details}`);
        }
    }

    /**
     * Calculate ticket value (sum of all code values multiplied by number of games)
     */
    private calculateTicketValue(codes: Array<{ value: number }>, gameCount: number): number {
        return codes.reduce((sum, code) => sum + (code.value * gameCount), 0);
    }

    /**
     * Create or update balance action for ticket sale
     */
    private async createTicketSaleBalanceAction(
        tx: any,
        ticketID: number,
        userID: number,
        created: Date
    ): Promise<void> {
        // Get ticket with codes and games to calculate value
        const ticket = await tx.ticket.findUnique({
            where: { id: ticketID },
            include: {
                codes: { select: { value: true } },
                games: { select: { gameID: true } }
            }
        });

        if (!ticket) return;

        const gameCount = ticket.games.length;
        const amount = this.calculateTicketValue(ticket.codes, gameCount);

        // Get or create balance for the user
        let balance = await tx.balance.findUnique({
            where: { userID }
        });

        if (!balance) {
            balance = await tx.balance.create({
                data: { userID, balance: 0 }
            });
        }

        // Create balance action
        await tx.balanceAction.create({
            data: {
                balanceID: balance.id,
                type: BalanceActionType.TICKET_SALE,
                amount: amount,
                reference: `TICKET_SALE:${ticketID}`,
                created: created
            }
        });

        // Update balance
        await tx.balance.update({
            where: { id: balance.id },
            data: { balance: { increment: amount } }
        });
    }

    /**
     * Update balance action when ticket is updated
     */
    private async updateTicketSaleBalanceAction(ticketID: number, userID: number): Promise<void> {
        // Get ticket with codes and games to calculate value
        const ticket = await this.db.ticket.findUnique({
            where: { id: ticketID },
            include: {
                codes: { select: { value: true } },
                games: { select: { gameID: true } }
            }
        });

        if (!ticket) return;

        const gameCount = ticket.games.length;
        const newAmount = this.calculateTicketValue(ticket.codes, gameCount);

        // Find existing balance action
        const balance = await this.db.balance.findUnique({
            where: { userID },
            include: {
                actions: {
                    where: {
                        type: BalanceActionType.TICKET_SALE,
                        reference: `TICKET_SALE:${ticketID}`
                    }
                }
            }
        });

        if (!balance || balance.actions.length === 0) {
            // Create new balance action if it doesn't exist
            await this.db.$transaction(async (tx) => {
                await this.createTicketSaleBalanceAction(tx, ticketID, userID, ticket.created);
            });
            // Update provision balance action
            await this.raffleService.updateProvisionForUser(userID, ticket.created);
            return;
        }

        const existingAction = balance.actions[0];
        const amountDifference = newAmount - existingAction.amount;

        if (amountDifference !== 0) {
            // Update balance action and adjust balance
            await this.db.$transaction(async (tx) => {
                await tx.balanceAction.update({
                    where: { id: existingAction.id },
                    data: { amount: newAmount }
                });

                await tx.balance.update({
                    where: { id: balance.id },
                    data: { balance: { increment: amountDifference } }
                });
            });
        }

        // Update provision balance action
        await this.raffleService.updateProvisionForUser(userID, ticket.created);
    }

    /**
     * Delete balance action when ticket is deleted
     */
    private async deleteTicketSaleBalanceAction(ticketID: number): Promise<void> {
        // Find balance action for this ticket
        const balanceAction = await this.db.balanceAction.findFirst({
            where: {
                type: BalanceActionType.TICKET_SALE,
                reference: `TICKET_SALE:${ticketID}`
            },
            include: {
                balance: true
            }
        });

        if (!balanceAction) return;

        // Delete balance action and adjust balance
        await this.db.$transaction(async (tx) => {
            await tx.balanceAction.delete({
                where: { id: balanceAction.id }
            });

            await tx.balance.update({
                where: { id: balanceAction.balanceID },
                data: { balance: { decrement: balanceAction.amount } }
            });
        });

        // Update provision balance action
        await this.raffleService.updateProvisionForUser(balanceAction.balance.userID, balanceAction.created);
    }
}

TicketService.register()
