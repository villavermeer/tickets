import { Prisma, Ticket, BalanceActionType, Role } from "@prisma/client";
import Service from "../../../common/services/Service";
import { injectable, container } from "tsyringe";
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

        // Check daily limits for all codes (skip for admin accounts)
        const user = Context.get("user");
        if (user.role !== 'ADMIN') {
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
            if (codesToCreate.length > 0) {
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
            where: { id }
        });

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

    public exportRelayableTicketsPDF = async (start: string, end: string, commit?: boolean, _compact?: boolean, combineAcrossGames?: boolean): Promise<Buffer> => {
        console.debug("Exporting relayable tickets to PDF with data:", { start, end, commit });
        const relayableTickets = await this.getRelayableTickets(start, end, commit, combineAcrossGames);
        console.debug(`Fetched ${relayableTickets.length} relayable ticket combinations for PDF export.`);

        // Pre-calculate daily codes for the summary
        const startDate = this.parseDateParameter(start, true);
        const endDate = this.parseDateParameter(end, false);
        const amsterdamStart = DateTime.fromJSDate(startDate).setZone('Europe/Amsterdam');
        const dayStart = amsterdamStart.startOf('day').toUTC().toJSDate();
        const dayEnd = amsterdamStart.endOf('day').toUTC().toJSDate();
        const dailyCodesForDisplay = await this.getDailyCodesForDisplay(dayStart, dayEnd);

        return new Promise((resolve, reject) => {
            try {
                const doc = new PDFDocument({
                    size: 'A4',
                    margins: { top: 40, bottom: 40, left: 40, right: 40 }
                });

                const chunks: Buffer[] = [];
                doc.on('data', (chunk: Buffer) => chunks.push(chunk));
                doc.on('end', () => resolve(Buffer.concat(chunks)));
                doc.on('error', reject);

                const left = doc.page.margins.left;
                const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
                const bottomLimit = doc.page.height - doc.page.margins.bottom;
                const rowHeight = 22;
                
                // Calculate column widths based on actual text content
                const calculateColumnWidths = () => {
                    let maxCodeWidth = 0;
                    let maxAmountWidth = 0;
                    
                    relayableTickets.forEach(chunk => {
                        chunk.entries.forEach(entry => {
                            // Estimate text width: approximately 6 pixels per character for Helvetica 11pt
                            const codeTextWidth = entry.code.length * 6;
                            const amountTextWidth = (entry.final / 100).toFixed(2).length * 6;
                            maxCodeWidth = Math.max(maxCodeWidth, codeTextWidth);
                            maxAmountWidth = Math.max(maxAmountWidth, amountTextWidth);
                        });
                    });
                    
                    // Add padding (16px on each side) and ensure minimum widths
                    const minCodeWidth = 50; // Minimum width for "Code" header
                    const minAmountWidth = 50; // Minimum width for "Bedrag" header and amounts
                    
                    const codeWidth = Math.max(maxCodeWidth + 32, minCodeWidth);
                    const amountWidth = Math.max(maxAmountWidth + 32, minAmountWidth);
                    
                    return { codeWidth, amountWidth };
                };
                
                const { codeWidth: codeColumnWidth, amountWidth: amountColumnWidth } = calculateColumnWidths();
                const columnWidths = [codeColumnWidth, amountColumnWidth];
                const tableWidth = codeColumnWidth + amountColumnWidth;
                const generatedStamp = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

                const renderReportHeader = (subtitle?: string) => {
                    doc.fillColor('#000000');
                    if (subtitle) {
                        // Calculate a more compact width for the subtitle (max 60% of usable width)
                        const maxSubtitleWidth = Math.min(usableWidth * 0.6, 300);
                        doc.font('Helvetica-Bold').fontSize(10).text(subtitle, left, doc.y, { width: maxSubtitleWidth });
                    }
                    doc.moveDown(0.6);
                };

                const drawTableHeader = (y: number) => {
                    doc.save();
                    doc.rect(left, y, tableWidth, rowHeight).fill('#f2f4f7');
                    doc.fillColor('#000000');
                    doc.font('Helvetica-Bold').fontSize(11)
                        .text('Code', left + 8, y + 6, { width: columnWidths[0] - 16 });
                    doc.text('Bedrag', left + columnWidths[0], y + 6, { width: columnWidths[1] - 16, align: 'right' });
                    doc.restore();
                };

                const drawTableRow = (entry: RelayableTicketEntry, y: number, isStriped: boolean) => {
                    doc.save();
                    
                    // Special styling for "Vaste lijst" row
                    const isVasteLijst = entry.code === 'Vaste lijst';
                    
                    if (isVasteLijst) {
                        // Light yellow background for "Vaste lijst"
                        doc.rect(left, y, tableWidth, rowHeight).fill('#fff4cc');
                    } else if (isStriped) {
                        doc.rect(left, y, tableWidth, rowHeight).fill('#fbfcfe');
                    }
                    
                    doc.fillColor('#000000');
                    const font = isVasteLijst ? 'Helvetica-Oblique' : 'Helvetica';
                    doc.font(font).fontSize(11)
                        .text(entry.code, left + 8, y + 6, { width: columnWidths[0] - 16 });
                    doc.text((entry.final / 100).toFixed(2), left + columnWidths[0], y + 6, { width: columnWidths[1] - 16, align: 'right' });
                    doc.restore();
                };

                const drawTotalRow = (total: number, y: number) => {
                    doc.save();
                    doc.rect(left, y, tableWidth, rowHeight).fill('#e8ebed');
                    doc.fillColor('#000000');
                    doc.font('Helvetica-Bold').fontSize(11)
                        .text('Totaal', left + 8, y + 6, { width: columnWidths[0] - 16 });
                    doc.text((total / 100).toFixed(2), left + columnWidths[0], y + 6, { width: columnWidths[1] - 16, align: 'right' });
                    doc.restore();
                };

                if (!relayableTickets.length) {
                    renderReportHeader('Geen relaybare tickets gevonden');
                    doc.end();
                    return;
                }

                // Separate Super 4 and non-Super 4 tickets
                const super4Chunks: ChunkedRelayableTicket[] = [];
                const nonSuper4Chunks: ChunkedRelayableTicket[] = [];
                
                relayableTickets.forEach(chunk => {
                    const isSuper4 = chunk.gameCombination.length === 1 && chunk.gameCombination[0] === 'Super 4';
                    if (isSuper4) {
                        super4Chunks.push(chunk);
                    } else {
                        nonSuper4Chunks.push(chunk);
                    }
                });

                let isFirstPage = true;

                // Process all non-Super4 games first
                nonSuper4Chunks.forEach((chunk, chunkIndex) => {
                    // Filter out "Vaste lijst" entries - they'll be rendered separately at the end
                    const regularEntries = chunk.entries.filter(e => e.code !== 'Vaste lijst');
                    const dailyDeduction = (chunk as any).dailyDeduction;
                    const chunkTotal = chunk.entries.reduce((sum, entry) => sum + entry.final, 0);

                    let entryIndex = 0;
                    let pageForChunk = 0;
                    const combinationTitle = `${chunk.gameCombination.join(', ')}`;

                    while (entryIndex < regularEntries.length || pageForChunk === 0) {
                        if (!isFirstPage) {
                            doc.addPage();
                        }
                        isFirstPage = false;

                        const subtitle = pageForChunk > 0 ? `${combinationTitle} (vervolg)` : combinationTitle;
                        renderReportHeader(subtitle);

                        let y = doc.y;
                        drawTableHeader(y);
                        y += rowHeight;

                        let stripe = false;
                        while (entryIndex < regularEntries.length) {
                            if (y + rowHeight > bottomLimit) {
                                break;
                            }
                            const entry = regularEntries[entryIndex];
                            drawTableRow(entry, y, stripe);
                            stripe = !stripe;
                            y += rowHeight;
                            entryIndex++;
                        }

                        // After all regular entries are rendered, add "Vaste lijst" and total row
                        if (entryIndex >= regularEntries.length) {
                            // Check if we have room for "Vaste lijst" row (if exists) and total row
                            const rowsNeeded = dailyDeduction ? 2 : 1;
                            if (y + (rowHeight * rowsNeeded) > bottomLimit) {
                                doc.addPage();
                                renderReportHeader(`${combinationTitle} (vervolg)`);
                                y = doc.y;
                                drawTableHeader(y);
                                y += rowHeight;
                            }
                            
                            // Render "Vaste lijst" row if it exists
                            if (dailyDeduction) {
                                drawTableRow(dailyDeduction, y, false);
                                y += rowHeight;
                            }
                            
                            // Render total row
                            drawTotalRow(chunkTotal, y);
                            y += rowHeight;

                            if (y + 24 > bottomLimit) {
                                doc.addPage();
                                renderReportHeader(`${combinationTitle} (vervolg)`);
                                y = doc.y;
                            } else {
                                y += 12;
                            }
                        }

                        pageForChunk++;
                    }
                });

                // Now process all Super 4 games in a single combined table at the end
                if (super4Chunks.length > 0) {
                    // Combine all Super 4 entries into one array, filtering out "Vaste lijst" entries
                    const allSuper4Entries: RelayableTicketEntry[] = [];
                    let super4DailyDeduction: any = null;
                    
                    super4Chunks.forEach(chunk => {
                        // Filter out "Vaste lijst" entries from regular entries
                        const regularEntries = chunk.entries.filter(e => e.code !== 'Vaste lijst');
                        allSuper4Entries.push(...regularEntries);
                        
                        // Store the daily deduction (there should only be one for Super4)
                        if ((chunk as any).dailyDeduction) {
                            super4DailyDeduction = (chunk as any).dailyDeduction;
                        }
                    });

                    const super4Total = super4Chunks.reduce((sum, chunk) => 
                        sum + chunk.entries.reduce((entrySum, entry) => entrySum + entry.final, 0), 0
                    );
                    const combinationTitle = 'Super 4';

                    let entryIndex = 0;
                    let pageForSuper4 = 0;

                    while (entryIndex < allSuper4Entries.length || pageForSuper4 === 0) {
                        if (!isFirstPage) {
                            doc.addPage();
                        }
                        isFirstPage = false;

                        const subtitle = pageForSuper4 > 0 ? `${combinationTitle} (vervolg)` : combinationTitle;
                        renderReportHeader(subtitle);

                        let y = doc.y;
                        drawTableHeader(y);
                        y += rowHeight;

                        let stripe = false;
                        while (entryIndex < allSuper4Entries.length) {
                            if (y + rowHeight > bottomLimit) {
                                break;
                            }
                            const entry = allSuper4Entries[entryIndex];
                            drawTableRow(entry, y, stripe);
                            stripe = !stripe;
                            y += rowHeight;
                            entryIndex++;
                        }

                        // After all regular entries are rendered, add "Vaste lijst" and total row
                        if (entryIndex >= allSuper4Entries.length) {
                            // Check if we have room for "Vaste lijst" row (if exists) and total row
                            const rowsNeeded = super4DailyDeduction ? 2 : 1;
                            if (y + (rowHeight * rowsNeeded) > bottomLimit) {
                                doc.addPage();
                                renderReportHeader(`${combinationTitle} (vervolg)`);
                                y = doc.y;
                                drawTableHeader(y);
                                y += rowHeight;
                            }
                            
                            // Render "Vaste lijst" row if it exists
                            if (super4DailyDeduction) {
                                drawTableRow(super4DailyDeduction, y, false);
                                y += rowHeight;
                            }
                            
                            // Render total row
                            drawTotalRow(super4Total, y);
                            y += rowHeight;
                        }

                        pageForSuper4++;
                    }
                }

                // Add daily tickets summary at the bottom
                if (dailyCodesForDisplay.length > 0) {
                    // Group codes by game for section headers
                    const codesByGame = new Map<number, typeof dailyCodesForDisplay>();
                    for (const code of dailyCodesForDisplay) {
                        if (!codesByGame.has(code.gameID)) {
                            codesByGame.set(code.gameID, []);
                        }
                        codesByGame.get(code.gameID)!.push(code);
                    }
                    
                    // Check if we need to add a new page for the summary
                    const totalRows = dailyCodesForDisplay.length + codesByGame.size + 2; // +game headers +total
                    const spaceNeeded = rowHeight * (totalRows + 2); // +2 for padding
                    
                    if (doc.y + spaceNeeded > bottomLimit) {
                        doc.addPage();
                        isFirstPage = false;
                    } else if (!isFirstPage) {
                        // Add some spacing if we're continuing on the same page
                        doc.moveDown(1);
                    }
                    
                    renderReportHeader('Gespeelde daglijkse tickets');
                    
                    let y = doc.y;
                    let grandTotal = 0;
                    
                    // Process each game group
                    for (const [gameID, codes] of codesByGame) {
                        const gameName = codes[0].gameName;
                        
                        // Add game header
                        renderReportHeader(gameName);
                        y = doc.y;
                        drawTableHeader(y);
                        y += rowHeight;
                        
                        let gameTotal = 0;
                        let stripe = false;
                        
                        // Add individual codes
                        for (const code of codes) {
                            drawTableRow({
                                code: code.code,
                                codeLength: code.code.length,
                                value: code.value,
                                deduction: 0,
                                final: code.value
                            } as any, y, stripe);
                            
                            gameTotal += code.value;
                            grandTotal += code.value;
                            stripe = !stripe;
                            y += rowHeight;
                        }
                        
                        // Add game total
                        drawTotalRow(gameTotal, y);
                        y += rowHeight + 12; // Extra spacing between games
                    }
                    
                    // Add grand total if multiple games
                    if (codesByGame.size > 1) {
                        if (y + rowHeight > bottomLimit) {
                            doc.addPage();
                            renderReportHeader('Gespeelde daglijkse tickets (vervolg)');
                            y = doc.y;
                        }
                        
                        // Grand total header
                        doc.font('Helvetica-Bold').fontSize(11)
                            .text('Totaal alle daglijkse tickets', left, y + 6);
                        drawTotalRow(grandTotal, y);
                    }
                }

                doc.end();
            } catch (err) {
                reject(err);
            }
        });
    }

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
        const actions = await this.db.balanceAction.findMany({
            where: {
                created: {
                    gte: startDate,
                    lte: endDate
                },
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
        actions.forEach((action) => {
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

        // Note: We only use PROVISION balance actions from the database.
        // Commission calculation from tickets would be double-counting since 
        // PROVISION balance actions are created separately by raffle scripts.

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
                    provisie: row.provisie / 100,
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
                provisie: rows.reduce((sum, row) => sum + row.provisie, 0) / 100,
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

    private getDailyCodesForDisplay = async (dayStart: Date, dayEnd: Date): Promise<{code: string, value: number, gameID: number, gameName: string}[]> => {
        const dailyCodes: {code: string, value: number, gameID: number, gameName: string}[] = [];
        
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

        // Calculate daily code totals per code per game for WNK and Super4
        const dailyTotalsPerCode = await this.calculateDailyCodeTotals(dayStart, dayEnd);

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

                // Get daily deduction for this specific code ONLY if it matches the current game
                const dailyGameMap = dailyTotalsPerCode.get(e.code);
                const dailyDeductionForCode = dailyGameMap ? (dailyGameMap.get(gameID) || 0) : 0;
                
                // Apply daily deduction to the full day total for threshold check
                const totalAllDayAfterDailyDeduction = totalAllDay - dailyDeductionForCode;
                
                // Apply threshold to the full day total after daily deduction
                const valueInEuros = totalAllDayAfterDailyDeduction / 100;
                let meetsThreshold = false;
                if (isSuper4) {
                    if (e.codeLength === 4) meetsThreshold = valueInEuros >= 1.00;
                    else if (e.codeLength === 3) meetsThreshold = valueInEuros >= 2.50;
                    else if (e.codeLength === 2) meetsThreshold = false;
                } else {
                    if (e.codeLength === 4) meetsThreshold = valueInEuros >= 1.25;
                    else if (e.codeLength === 3) meetsThreshold = valueInEuros >= 3.75;
                    else if (e.codeLength === 2) meetsThreshold = valueInEuros >= 25.00;
                }
                if (!meetsThreshold) continue;

                // Apply daily deduction to the window value
                const windowValueAfterDailyDeduction = e.value - dailyDeductionForCode;
                
                // Skip codes with zero or negative window value after daily deduction
                if (windowValueAfterDailyDeduction <= 0) continue;

                // Calculate deduction on the window value after daily deduction
                const windowCalc = this.calculateDeduction(e.codeLength, windowValueAfterDailyDeduction, group.gameIds);

                // Skip codes with zero or negative final value
                if (windowCalc.finalValue <= 0) continue;

                entriesDetailed.push({ 
                    code: e.code, 
                    codeLength: e.codeLength, 
                    value: windowValueAfterDailyDeduction, 
                    deduction: windowCalc.deduction, 
                    final: windowCalc.finalValue 
                });
                e.ids.forEach(id => relayableCodeIds.add(id));
            }

            if (!entriesDetailed.length) {
                continue;
            }

            // Calculate daily deduction for this game (will be shown separately)
            // Sum up all daily deductions for codes that appear in this game, ONLY for the current game
            const dailyTotal = Array.from(dailyTotalsPerCode.entries())
                .filter(([code, _]) => entriesDetailed.some(e => e.code === code))
                .reduce((sum, [_, gameMap]) => {
                    const deductionForGame = gameMap.get(gameID) || 0;
                    return sum + deductionForGame;
                }, 0);
            
            // Calculate totals (daily deduction is already applied per code)
            const totalValue = entriesDetailed.reduce((s, x) => s + x.value, 0);
            const deduction = entriesDetailed.reduce((s, x) => s + x.deduction, 0);
            const finalValue = entriesDetailed.reduce((s, x) => s + x.final, 0);

            // Create the "Vaste lijst" entry separately
            const vasteLijstEntry = dailyTotal > 0 ? {
                code: 'Vaste lijst',
                codeLength: 0,
                value: -dailyTotal,
                deduction: 0,
                final: -dailyTotal
            } : null;

            // Store all entries including "Vaste lijst" for Excel export
            const allEntries = vasteLijstEntry 
                ? [...entriesDetailed, vasteLijstEntry]
                : entriesDetailed;

            chunks.push({
                gameCombination: group.gameNames,
                codes: allEntries.map(e => e.code),
                totalValue,
                ticketCount: entriesDetailed.length,
                deduction,
                finalValue,
                entries: allEntries,
                // Store daily deduction separately for PDF rendering
                dailyDeduction: vasteLijstEntry
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
                    if (entry.codeLength === 4) return valueInEuros >= 1.00;
                    if (entry.codeLength === 3) return valueInEuros >= 2.50;
                    if (entry.codeLength === 2) return false; // never played on Super4
                } else {
                    // Default game thresholds
                    if (entry.codeLength === 4) return valueInEuros >= 1.25; // 1.25+ then deduct 1
                    if (entry.codeLength === 3) return valueInEuros >= 3.75;  // 3.75-6.99 => -2, 7+ => -5
                    if (entry.codeLength === 2) return valueInEuros >= 25.00; // 25+ => halve
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
                // 4 digits: Een euro of hoger gaat 0.50 vanaf
                if (valueInEuros >= 1) {
                    deductionInEuros = 0.50;
                }
            } else if (codeLength === 3) {
                // 3 digits: Alles vanaf 2.50 halen we 0.50 vanaf
                if (valueInEuros >= 2.50) {
                    deductionInEuros = 0.50;
                }
            } else if (codeLength === 2) {
                // 2 digits: Deze spelen we niet - should be filtered out
                return { deduction: 0, finalValue: 0 };
            }
        } else {
            // All games except Super 4
            if (codeLength === 4) {
                // 4 digits: Alles wat boven 1 euro gespeeld wordt halen we 1 euro vanaf
                if (valueInEuros > 1) {
                    deductionInEuros = 1;
                }
            } else if (codeLength === 3) {
                // 3 digits: Inleg van 3 tot 7 euro halen we 2 euro vanaf. Alles vanaf 7 euro of hoger halen we 5 euro vanaf
                if (valueInEuros >= 3 && valueInEuros < 7) {
                    deductionInEuros = 2;
                } else if (valueInEuros >= 7) {
                    deductionInEuros = 5;
                }
            } else if (codeLength === 2) {
                // 2 digits: Alles vanaf 25 euro gaat door de helft
                if (valueInEuros >= 25) {
                    deductionInEuros = valueInEuros / 2;
                }
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

    private calculateDeductionForTotal = (totalValue: number, gameIds: number[]): { deduction: number; finalValue: number } => {
        const hasSuper4 = gameIds.includes(7); 
        
        // Convert cents to euros for easier calculation
        const valueInEuros = totalValue / 100;
        let deductionInEuros = 0;

        if (hasSuper4) {
            // Super 4 rules - apply to total value
            if (valueInEuros >= 1.00) {
                // For Super 4, deduct 0.50 euro from total if >= 1.00 euro
                deductionInEuros = 0.50;
            }
        } else {
            // All games except Super 4 - apply to total value
            if (valueInEuros > 1.00) {
                // For non-Super4 games, deduct 1 euro from total if > 1.00 euro
                deductionInEuros = 1.00;
            }
        }

        // Convert back to cents
        const deductionInCents = Math.round(deductionInEuros * 100);
        const finalValueInCents = totalValue - deductionInCents;

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
}

TicketService.register()
